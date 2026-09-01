import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type {
  RequestRecord,
  TaskRecord,
  TaskStatus,
  DailyRollup,
  ModelDailyStats,
  TelemetryData,
  TelemetrySummary,
  RequestType,
} from "./types.js";

const TELEMETRY_FILE = path.join(os.homedir(), ".adaan", "telemetry.json");
const MAX_RECENT_TASKS = 500;
const MAX_RECENT_REQUESTS = 2000;
const WRITE_DEBOUNCE_MS = 1500;
const TREND_DAYS = 14;

function todayStr(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function emptyRollup(day: string): DailyRollup {
  return {
    day,
    tasks: 0,
    successfulTasks: 0,
    erroredTasks: 0,
    cancelledTasks: 0,
    requests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    toolCalls: 0,
    cacheHits: 0,
    filesRead: 0,
    filesModified: 0,
    rawContextTokens: 0,
    actualContextTokens: 0,
    prunedMessages: 0,
    totalTaskDurationMs: 0,
    perModel: {},
  };
}

function emptyModelStats(model: string): ModelDailyStats {
  return {
    model,
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    totalLatencyMs: 0,
    tasks: 0,
    taskSuccesses: 0,
  };
}

/**
 * In-flight task accumulator. The engine mutates this as it runs, then calls
 * finishTask() to flush a TaskRecord + roll up the per-request stats.
 */
export interface ActiveTask {
  taskId: string;
  sessionId: string;
  model: string;
  prompt: string;
  startedAt: number;
  day: string;
  requestCount: number;
  toolCalls: number;
  cacheHits: number;
  filesRead: number;
  filesModified: number;
  commandsRun: number;
  testsRun: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  cost: number;
  rawContextTokens: number;
  actualContextTokens: number;
  prunedMessages: number;
  /** Tracks whether the previous iteration ended in a tool error, to classify
   *  the next request as "debugging" rather than "coding". */
  lastIterationHadError: boolean;
  /** Whether any tool call has succeeded yet (distinguishes planning from coding). */
  anyToolSuccess: boolean;
}

/**
 * Telemetry store. Single in-memory instance; persistence is debounced and
 * best-effort (a write failure never breaks the agent loop). All mutation
 * methods are synchronous and cheap — the engine calls them inline.
 */
export class TelemetryStore {
  private data: TelemetryData = { version: 1, recentTasks: [], recentRequests: [], rollups: {} };
  private active = new Map<string, ActiveTask>();
  private writeTimer: ReturnType<typeof setTimeout> | undefined;
  private loaded = false;
  /** Injected clock for tests. */
  private now: () => number = Date.now;
  /** Injected file path for tests (overrides TELEMETRY_FILE). */
  private filePath: string = TELEMETRY_FILE;

  /** Test hook: inject a custom clock and persistence path. */
  _configure(opts: { now?: () => number; filePath?: string }) {
    if (opts.now) this.now = opts.now;
    if (opts.filePath) this.filePath = opts.filePath;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as TelemetryData;
      if (parsed && parsed.version === 1) {
        this.data = {
          version: 1,
          recentTasks: parsed.recentTasks ?? [],
          recentRequests: parsed.recentRequests ?? [],
          rollups: parsed.rollups ?? {},
        };
      }
    } catch {
      // missing / corrupt file — start fresh
    }
  }

  private scheduleWrite() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.flush();
    }, WRITE_DEBOUNCE_MS);
  }

  /** Force an immediate write (e.g. on graceful shutdown). */
  async flush(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.data));
    } catch {
      // best-effort — telemetry must never break the agent
    }
  }

  /** Begin tracking a user task. Returns the active-task handle. */
  startTask(sessionId: string, model: string, prompt: string): ActiveTask {
    const taskId = randomUUID();
    const task: ActiveTask = {
      taskId,
      sessionId,
      model,
      prompt: prompt.slice(0, 160),
      startedAt: this.now(),
      day: todayStr(new Date(this.now())),
      requestCount: 0,
      toolCalls: 0,
      cacheHits: 0,
      filesRead: 0,
      filesModified: 0,
      commandsRun: 0,
      testsRun: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      cost: 0,
      rawContextTokens: 0,
      actualContextTokens: 0,
      prunedMessages: 0,
      lastIterationHadError: false,
      anyToolSuccess: false,
    };
    this.active.set(taskId, task);
    return task;
  }

  /**
   * Classify the request type from the active task's state at call time.
   * - first request (requestCount === 0) → planning
   * - previous iteration had a tool error → debugging
   * - otherwise (tools succeeded) → coding
   * The engine overrides this to "final_response" for the forced summary turn.
   */
  classifyRequest(task: ActiveTask): RequestType {
    if (task.requestCount === 0) return "planning";
    if (task.lastIterationHadError) return "debugging";
    return "coding";
  }

  /** Record a completed LLM request. */
  recordRequest(
    task: ActiveTask,
    opts: {
      model: string;
      provider?: string;
      requestType: RequestType;
      contextTokens: number;
      rawContextTokens: number;
      prunedMessages: number;
      iteration: number;
      latencyMs: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      reasoningTokens: number;
      cost: number;
      success: boolean;
    },
  ): void {
    const ts = this.now();
    const day = todayStr(new Date(ts));
    const rec: RequestRecord = {
      requestId: randomUUID(),
      sessionId: task.sessionId,
      taskId: task.taskId,
      model: opts.model,
      provider: opts.provider ?? "openrouter",
      timestamp: ts,
      day,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      cachedTokens: opts.cachedTokens,
      reasoningTokens: opts.reasoningTokens,
      latencyMs: opts.latencyMs,
      cost: opts.cost,
      requestType: opts.requestType,
      contextTokens: opts.contextTokens,
      toolCallsBeforeRequest: task.toolCalls + task.cacheHits,
      iteration: opts.iteration,
      success: opts.success,
    };
    this.data.recentRequests.unshift(rec);
    if (this.data.recentRequests.length > MAX_RECENT_REQUESTS) {
      this.data.recentRequests.length = MAX_RECENT_REQUESTS;
    }

    // Fold into the day's rollup.
    const rollup = this.rollupFor(day);
    rollup.requests++;
    if (!opts.success) rollup.failedRequests++;
    rollup.inputTokens += opts.inputTokens;
    rollup.outputTokens += opts.outputTokens;
    rollup.cachedTokens += opts.cachedTokens;
    rollup.reasoningTokens += opts.reasoningTokens;
    rollup.cost += opts.cost;
    rollup.rawContextTokens += opts.rawContextTokens;
    rollup.actualContextTokens += opts.contextTokens;
    rollup.prunedMessages += opts.prunedMessages;

    const ms = rollup.perModel[opts.model] ?? emptyModelStats(opts.model);
    ms.requests++;
    if (!opts.success) ms.errors++;
    ms.inputTokens += opts.inputTokens;
    ms.outputTokens += opts.outputTokens;
    ms.cachedTokens += opts.cachedTokens;
    ms.reasoningTokens += opts.reasoningTokens;
    ms.cost += opts.cost;
    ms.totalLatencyMs += opts.latencyMs;
    rollup.perModel[opts.model] = ms;

    // Accumulate into the active task.
    task.requestCount++;
    task.inputTokens += opts.inputTokens;
    task.outputTokens += opts.outputTokens;
    task.cachedTokens += opts.cachedTokens;
    task.reasoningTokens += opts.reasoningTokens;
    task.cost += opts.cost;
    task.rawContextTokens += opts.rawContextTokens;
    task.actualContextTokens += opts.contextTokens;
    task.prunedMessages += opts.prunedMessages;

    this.scheduleWrite();
  }

  /** Note a tool execution (classified) on the active task. */
  recordToolCall(
    task: ActiveTask,
    toolName: string,
    opts: { cached: boolean; success: boolean },
  ): void {
    if (opts.cached) {
      task.cacheHits++;
      return;
    }
    task.toolCalls++;
    if (READ_TOOLS.has(toolName)) task.filesRead++;
    if (MODIFY_TOOLS.has(toolName)) task.filesModified++;
    if (toolName === "execute_command") task.commandsRun++;
    if (toolName === "run_tests") task.testsRun++;
    if (opts.success) task.anyToolSuccess = true;
    else task.lastIterationHadError = true;
  }

  /** Mark the end of an iteration so the next request can be classified. */
  markIterationEnd(task: ActiveTask, hadError: boolean): void {
    task.lastIterationHadError = hadError;
  }

  /** Finalize a task and roll it up. */
  finishTask(task: ActiveTask, status: TaskStatus): TaskRecord {
    const durationMs = this.now() - task.startedAt;
    const rec: TaskRecord = {
      taskId: task.taskId,
      sessionId: task.sessionId,
      model: task.model,
      prompt: task.prompt,
      timestamp: task.startedAt,
      day: task.day,
      durationMs,
      status,
      requestCount: task.requestCount,
      toolCalls: task.toolCalls,
      cacheHits: task.cacheHits,
      filesRead: task.filesRead,
      filesModified: task.filesModified,
      commandsRun: task.commandsRun,
      testsRun: task.testsRun,
      inputTokens: task.inputTokens,
      outputTokens: task.outputTokens,
      cachedTokens: task.cachedTokens,
      reasoningTokens: task.reasoningTokens,
      cost: task.cost,
      rawContextTokens: task.rawContextTokens,
      actualContextTokens: task.actualContextTokens,
      prunedMessages: task.prunedMessages,
    };
    this.active.delete(task.taskId);
    this.data.recentTasks.unshift(rec);
    if (this.data.recentTasks.length > MAX_RECENT_TASKS) {
      this.data.recentTasks.length = MAX_RECENT_TASKS;
    }

    const rollup = this.rollupFor(task.day);
    rollup.tasks++;
    if (status === "success") rollup.successfulTasks++;
    else if (status === "error") rollup.erroredTasks++;
    else rollup.cancelledTasks++;
    rollup.toolCalls += rec.toolCalls;
    rollup.cacheHits += rec.cacheHits;
    rollup.filesRead += rec.filesRead;
    rollup.filesModified += rec.filesModified;
    rollup.totalTaskDurationMs += rec.durationMs;

    const ms = rollup.perModel[task.model] ?? emptyModelStats(task.model);
    ms.tasks++;
    if (status === "success") ms.taskSuccesses++;
    rollup.perModel[task.model] = ms;

    this.scheduleWrite();
    return rec;
  }

  private rollupFor(day: string): DailyRollup {
    let r = this.data.rollups[day];
    if (!r) {
      r = emptyRollup(day);
      this.data.rollups[day] = r;
    }
    return r;
  }

  /** Compute the dashboard summary. */
  getSummary(): TelemetrySummary {
    const today = todayStr(new Date(this.now()));
    const todayRollup = this.data.rollups[today] ?? emptyRollup(today);

    const requestsPerTask = todayRollup.tasks > 0 ? todayRollup.requests / todayRollup.tasks : 0;
    const totalTokens = todayRollup.inputTokens + todayRollup.outputTokens;
    const tokensPerTask = todayRollup.tasks > 0 ? totalTokens / todayRollup.tasks : 0;
    const costPerTask = todayRollup.tasks > 0 ? todayRollup.cost / todayRollup.tasks : 0;
    const avgTaskDurationMs = todayRollup.tasks > 0 ? todayRollup.totalTaskDurationMs / todayRollup.tasks : 0;
    const successfulTasksPer1000Requests =
      todayRollup.requests > 0 ? (todayRollup.successfulTasks / todayRollup.requests) * 1000 : 0;
    const contextSavingsPct =
      todayRollup.rawContextTokens > 0
        ? 1 - todayRollup.actualContextTokens / todayRollup.rawContextTokens
        : 0;
    const totalToolOps = todayRollup.toolCalls + todayRollup.cacheHits;
    const cacheHitRate = totalToolOps > 0 ? todayRollup.cacheHits / totalToolOps : 0;

    // 14-day trend (oldest → newest), including today even if empty.
    const trend: DailyRollup[] = [];
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      const d = new Date(this.now());
      d.setDate(d.getDate() - i);
      const key = todayStr(d);
      trend.push(this.data.rollups[key] ?? emptyRollup(key));
    }

    return {
      today: todayRollup,
      successfulTasksPer1000Requests,
      requestsPerTask,
      tokensPerTask,
      costPerTask,
      avgTaskDurationMs,
      contextSavingsPct,
      cacheHitRate,
      trend,
      recentTasks: this.data.recentTasks.slice(0, 25),
    };
  }

  /** Expose raw data — used by tests. */
  _data(): TelemetryData {
    return this.data;
  }
}

const READ_TOOLS = new Set(["read_file", "list_files", "list_symbols", "search_files", "git_status", "git_diff"]);
const MODIFY_TOOLS = new Set(["write_file", "apply_patch", "create_file", "delete_file", "git_checkpoint", "git_rollback"]);

/** Singleton store used by the engine and API routes. */
export const telemetryStore = new TelemetryStore();
