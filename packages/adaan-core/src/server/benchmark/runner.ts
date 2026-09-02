import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AgentEvent } from "../../types.js";
import { Workspace } from "../workspace.js";
import { AgentSession } from "../agent/session.js";
import { AgentEngine } from "../agent/engine.js";
import { telemetryStore } from "../telemetry/index.js";
import { BENCHMARK_TASKS, type BenchmarkTask } from "./tasks.js";
import type { BenchmarkResult } from "./capability.js";

const RESULTS_FILE = path.join(os.homedir(), ".adaan", "benchmark-results.json");
const MAX_RESULTS = 500;
const FREE_REQUEST_BUDGET = 50; // refuse to run if < this many free requests remaining

export interface BenchmarkRunOptions {
  models?: string[];
  tasks?: string[];
  /** Phase B: optional tool filter — when set, only these tool schemas are
   *  exposed to the model for this run. Used for edit-format experiments. */
  toolFilter?: string[];
  provider: AgentEngine extends never ? never : import("../agent/provider.js").LLMProvider;
  engine: AgentEngine;
  registry: import("../agent/tools/registry.js").ToolRegistry;
}

export interface BenchmarkProgress {
  taskId: string;
  model: string;
  status: "running" | "pass" | "fail" | "error";
  detail?: string;
  result?: BenchmarkResult;
}

/**
 * Benchmark runner — executes benchmark tasks against models and records
 * results. Budget guard: refuses to start if today's telemetry shows < N
 * free requests remaining estimate.
 */
export class BenchmarkRunner {
  private filePath = RESULTS_FILE;

  /** Test hook. */
  _configure(opts?: { filePath?: string }): void {
    if (opts?.filePath) this.filePath = opts.filePath;
  }

  /** Check if we have enough free request budget to run benchmarks. */
  async checkBudget(): Promise<{ ok: boolean; reason?: string }> {
    await telemetryStore.load();
    const summary = telemetryStore.getSummary();
    // Rough estimate: if today's requests are already high, refuse.
    const todayRequests = summary.today.requests;
    if (todayRequests > FREE_REQUEST_BUDGET) {
      return {
        ok: false,
        reason: `Today's request count (${todayRequests}) exceeds benchmark budget guard (${FREE_REQUEST_BUDGET}). Benchmarks eat the daily cap — try again tomorrow or run with fewer tasks.`,
      };
    }
    return { ok: true };
  }

  /** Run benchmark tasks against models, yielding progress events. */
  async *run(
    opts: BenchmarkRunOptions,
  ): AsyncIterable<BenchmarkProgress> {
    const budget = await this.checkBudget();
    if (!budget.ok) {
      yield { taskId: "", model: "", status: "error", detail: budget.reason };
      return;
    }

    const tasks = (opts.tasks?.length ?? 0) > 0
      ? BENCHMARK_TASKS.filter((t) => opts.tasks!.includes(t.id))
      : BENCHMARK_TASKS;

    // Default to free models only.
    const models = opts.models ?? [];

    for (const task of tasks) {
      for (const model of models.length > 0 ? models : ["auto"]) {
        yield* this.runTask(task, model, opts);
      }
    }
  }

  private async *runTask(
    task: BenchmarkTask,
    model: string,
    opts: BenchmarkRunOptions,
  ): AsyncIterable<BenchmarkProgress> {
    const tmpDir = path.join(os.tmpdir(), `adaan-bench-${task.id}-${Date.now()}`);
    let ws: Workspace | null = null;
    let session: AgentSession | null = null;

    try {
      // Create temp workspace + scaffold.
      await fs.mkdir(tmpDir, { recursive: true });
      ws = new Workspace(tmpDir);
      for (const [filename, content] of Object.entries(task.scaffold)) {
        await ws.writeFile(filename, content);
      }

      // Create a fresh session.
      session = new AgentSession(`bench-${task.id}-${Date.now()}`, tmpDir);

      const engine = opts.engine;
      engine.maxIterations = task.maxIterations;
      // Phase B: apply tool filter if set (e.g. exclude apply_patch for
      // the rewrite variant of the edit-format experiment).
      (engine as any).toolFilter = opts.toolFilter;

      let requests = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let cost = 0;
      let retries = 0;
      let hasText = false;
      let hasCommand = false;
      const startTime = Date.now();

      yield { taskId: task.id, model, status: "running" };

      // Run the agent.
      try {
        for await (const event of engine.run(session, ws, task.prompt, model, 4096)) {
          const e = event as AgentEvent;
          if (e.type === "text.delta") hasText = true;
          if (e.type === "tool.start") {
            const data = e.data as { toolName: string };
            if (data.toolName === "execute_command") hasCommand = true;
          }
          if (e.type === "task.summary") {
            const data = e.data as any;
            requests = data?.requests ?? 0;
            inputTokens = data?.inputTokens ?? 0;
            outputTokens = data?.outputTokens ?? 0;
            cost = data?.cost ?? 0;
          }
        }
      } catch (err) {
        const result: BenchmarkResult = {
          taskId: task.id,
          model,
          day: new Date().toISOString().slice(0, 10),
          success: false,
          requests,
          retries,
          inputTokens,
          outputTokens,
          cost,
          latencyMs: Date.now() - startTime,
          verifyDetail: `Error: ${err instanceof Error ? err.message : String(err)}`,
        };
        await this.saveResult(result);
        yield { taskId: task.id, model, status: "error", detail: result.verifyDetail, result };
        return;
      }

      // Verify the result.
      let verifyResult: { pass: boolean; detail: string };
      try {
        verifyResult = await task.verify(ws);
        // For exploration/terminal tasks, check that the agent did something.
        if (verifyResult.pass && task.id === "exploration" && !hasText) {
          verifyResult = { pass: false, detail: "No text response generated" };
        }
        if (verifyResult.pass && task.id === "terminal" && !hasCommand) {
          verifyResult = { pass: false, detail: "No command executed" };
        }
      } catch (err) {
        verifyResult = {
          pass: false,
          detail: `Verify error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      const result: BenchmarkResult = {
        taskId: task.id,
        model,
        day: new Date().toISOString().slice(0, 10),
        success: verifyResult.pass,
        requests,
        retries,
        inputTokens,
        outputTokens,
        cost,
        latencyMs: Date.now() - startTime,
        verifyDetail: verifyResult.detail,
      };

      await this.saveResult(result);
      yield {
        taskId: task.id,
        model,
        status: verifyResult.pass ? "pass" : "fail",
        detail: verifyResult.detail,
        result,
      };
    } finally {
      // Cleanup temp dir.
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  /** Load all persisted results. */
  async loadResults(): Promise<BenchmarkResult[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** Save a result, capping total to MAX_RESULTS. */
  private async saveResult(result: BenchmarkResult): Promise<void> {
    const existing = await this.loadResults();
    existing.push(result);
    // Cap: keep the most recent MAX_RESULTS.
    const capped = existing.slice(-MAX_RESULTS);
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(capped, null, 2), "utf-8");
    } catch {
      // best-effort persistence
    }
  }
}

/** Singleton. */
export const benchmarkRunner = new BenchmarkRunner();
