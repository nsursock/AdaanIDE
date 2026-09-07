import type { LLMProvider } from "../agent/provider.js";
import type { Workspace } from "../workspace.js";
import type { ReviewConfig, ReviewProgress, ReviewResult } from "./types.js";
import { reviewId, reviewStore } from "./store.js";
import { runReview, runAggregateOnly, registerRun, unregisterRun } from "./runner.js";
import { sleepGuard } from "./sleep-guard.js";

/**
 * Review run manager — owns active runs server-side, detached from any HTTP
 * request. A run survives the client closing the SSE connection (project
 * switch, tab reload, app backgrounding); clients re-attach via `subscribe()`
 * which replays the accumulated state and then streams live events.
 *
 * Sleep prevention (`caffeinate` on macOS) is held for the duration of every
 * run so the OS can't idle-sleep the machine mid-review. Persistence is
 * incremental (reviewer outputs are stored as they complete), so a run whose
 * process dies can be resumed from its surviving partial state.
 */

/** How long a finished run stays attachable before being evicted. */
const EVICT_GRACE_MS = 5 * 60 * 1000;

function isGoodOutput(v: string | undefined): boolean {
  return !!v && !v.startsWith("[REVIEWER ERROR:");
}

interface ManagedRun {
  resultId: string;
  configId: string;
  configName: string;
  workspaceRoot?: string;
  triggeredBy: "manual" | "schedule";
  resumed: boolean;
  controller: AbortController;
  startedAt: string;
  done: boolean;
  /** Ordered non-delta events (context/cost/committee/parse/aggregator/
   *  github + the terminal complete/error/cancelled). */
  discrete: ReviewProgress[];
  /** Accumulated text per reviewer (memory-parity with result.rawOutputs). */
  reviewerTexts: Map<string, string>;
  reviewerOrder: Map<string, number>;
  reviewerDone: Map<string, string | undefined>; // model → error (undefined = success)
  aggregatorModel?: string;
  aggText: string;
  aggReasoning: string;
  listeners: Set<(ev: ReviewProgress) => void>;
  evictTimer?: ReturnType<typeof setTimeout>;
}

export interface ActiveRunInfo {
  resultId: string;
  configId: string;
  configName: string;
  workspaceRoot?: string;
  triggeredBy: "manual" | "schedule";
  resumed: boolean;
  phase: string;
  startedAt: string;
}

export interface RunSubscription {
  /** Events to replay immediately (includes run.started and, for finished
   *  runs, the terminal event). */
  replay: ReviewProgress[];
  done: boolean;
  /** Register for subsequent live events. Returns an unsubscribe function. */
  live(listener: (ev: ReviewProgress) => void): () => void;
}

export interface StartReviewRunArgs {
  config: ReviewConfig;
  workspace: Workspace;
  provider: LLMProvider;
  triggeredBy: "manual" | "schedule";
  /** Resume from an interrupted run: completed reviewer outputs are kept,
   *  only missing/failed reviewers are re-run. Same result id is reused. */
  resumeFrom?: ReviewResult;
}

export interface StartAggregateRunArgs {
  config: ReviewConfig;
  workspace: Workspace;
  provider: LLMProvider;
  reviewerOutputs: Record<string, string>;
  aggregatorModel?: string;
  /** Reuse a previous (interrupted upload) result id. */
  resumeFrom?: ReviewResult;
}

export class ReviewRunManager {
  private runs = new Map<string, ManagedRun>();

  /** Base id → unique id suffix (a forced parallel re-run gets a fresh id). */
  private ensureFreshId(id: string): string {
    let out = id;
    while (this.runs.has(out)) out = reviewId("rev-");
    return out;
  }

  private newRun(
    cfg: { id: string; name: string },
    workspaceRoot: string | undefined,
    triggeredBy: "manual" | "schedule",
    resumed: boolean,
    requestedId?: string,
  ): ManagedRun {
    const controller = new AbortController();
    const run: ManagedRun = {
      resultId: this.ensureFreshId(requestedId ?? reviewId("rev-")),
      configId: cfg.id,
      configName: cfg.name,
      workspaceRoot,
      triggeredBy,
      resumed,
      controller,
      startedAt: new Date().toISOString(),
      done: false,
      discrete: [],
      reviewerTexts: new Map(),
      reviewerOrder: new Map(),
      reviewerDone: new Map(),
      aggText: "",
      aggReasoning: "",
      listeners: new Set(),
    };
    this.runs.set(run.resultId, run);
    registerRun(run.resultId, controller);
    sleepGuard.acquire();
    return run;
  }

  private record(run: ManagedRun, ev: ReviewProgress): void {
    switch (ev.phase) {
      case "committee.delta":
        run.reviewerTexts.set(ev.model, (run.reviewerTexts.get(ev.model) ?? "") + ev.text);
        break;
      case "committee.start":
        run.reviewerOrder.set(ev.model, ev.reviewerIndex);
        break;
      case "committee.done":
        run.reviewerDone.set(ev.model, ev.error);
        break;
      case "aggregator":
        run.aggregatorModel = ev.model;
        run.discrete.push(ev);
        break;
      case "aggregator.delta":
        run.aggText += ev.text;
        break;
      case "aggregator.reasoning":
        run.aggReasoning += ev.text;
        break;
      default:
        run.discrete.push(ev);
    }
  }

  private emit(run: ManagedRun, ev: ReviewProgress): void {
    if (ev.phase === "complete" || ev.phase === "error" || ev.phase === "cancelled") {
      run.done = true;
    }
    for (const fn of run.listeners) {
      try { fn(ev); } catch { /* listener must not break the run */ }
    }
  }

  private finalize(run: ManagedRun): void {
    run.done = true;
    unregisterRun(run.resultId);
    sleepGuard.release();
    // Keep attachable briefly so a just-disconnected client can still grab
    // the terminal state, then evict.
    run.evictTimer = setTimeout(() => {
      this.runs.delete(run.resultId);
    }, EVICT_GRACE_MS);
    if (typeof run.evictTimer.unref === "function") run.evictTimer.unref();
  }

  private async drive(run: ManagedRun, gen: AsyncIterable<ReviewProgress>): Promise<void> {
    const started: ReviewProgress = {
      phase: "run.started",
      runId: run.resultId,
      configId: run.configId,
      configName: run.configName,
      ...(run.resumed ? { resumed: true } : {}),
    };
    this.record(run, started);
    this.emit(run, started);
    try {
      for await (const ev of gen) {
        this.record(run, ev);
        this.emit(run, ev);
      }
    } catch (e) {
      // The runner yields its own terminal events; this is a last-resort
      // path for infrastructure failures outside the generator.
      const message = e instanceof Error ? e.message : String(e);
      const ev: ReviewProgress = { phase: "error", message };
      this.record(run, ev);
      this.emit(run, ev);
    } finally {
      this.finalize(run);
    }
  }

  /** Start a full committee review, detached from the caller's request
   *  lifecycle. Returns the id the UI can attach/cancel by. */
  startReviewRun(args: StartReviewRunArgs): { resultId: string } {
    const run = this.newRun(
      { id: args.config.id, name: args.config.name },
      args.workspace.rootPath,
      args.triggeredBy,
      !!args.resumeFrom,
      args.resumeFrom?.id,
    );

    // Seed replay state with preserved reviewer outputs so attaching clients
    // see the full picture, including work carried over from the prior run.
    if (args.resumeFrom) {
      let i = 0;
      for (const [model, text] of Object.entries(args.resumeFrom.rawOutputs)) {
        if (!isGoodOutput(text)) continue;
        run.reviewerOrder.set(model, i);
        run.reviewerTexts.set(model, text);
        run.reviewerDone.set(model, undefined);
        i++;
      }
    }

    const gen = runReview({
      config: args.config,
      workspace: args.workspace,
      provider: args.provider,
      triggeredBy: args.triggeredBy,
      signal: run.controller.signal,
      resultId: run.resultId,
      resumeFrom: args.resumeFrom,
      onResultUpdate: async (result) => {
        await reviewStore.updateResult(result);
      },
    });
    void this.drive(run, gen);
    return { resultId: run.resultId };
  }

  /** Start an aggregate-only run (pasted external analysis), detached. */
  startAggregateRun(args: StartAggregateRunArgs): { resultId: string } {
    const run = this.newRun(
      { id: args.config.id, name: args.config.name },
      args.workspace.rootPath,
      "manual",
      !!args.resumeFrom,
      args.resumeFrom?.id,
    );

    let i = 0;
    for (const [model, text] of Object.entries(args.reviewerOutputs)) {
      run.reviewerOrder.set(model, i);
      run.reviewerTexts.set(model, text);
      run.reviewerDone.set(model, undefined);
      i++;
    }

    const gen = runAggregateOnly({
      config: args.config,
      workspace: args.workspace,
      provider: args.provider,
      reviewerOutputs: args.reviewerOutputs,
      aggregatorModel: args.aggregatorModel,
      signal: run.controller.signal,
      resultId: run.resultId,
      onResultUpdate: async (result) => {
        await reviewStore.updateResult(result);
      },
    });
    void this.drive(run, gen);
    return { resultId: run.resultId };
  }

  /** Resume an interrupted run: completed reviewer outputs are kept, missing
   *  (or errored) reviewers are re-run, then aggregation proceeds. Upload-
   *  source runs resume via the aggregate-only path. Returns null when the
   *  result isn't resumable. */
  async resumeRun(
    resultId: string,
    provider: LLMProvider,
    workspace: Workspace,
  ): Promise<{ resultId: string } | null> {
    await reviewStore.load();
    const prev = reviewStore.getResult(resultId);
    const config = prev && reviewStore.getConfig(prev.configId);
    if (!prev || !config) return null;
    const usable = Object.values(prev.rawOutputs ?? {}).some(isGoodOutput);
    if (!usable) return null;

    const resumable: ReviewResult = {
      ...prev,
      status: "running" as const,
      error: undefined,
      completedAt: undefined,
    };

    if (prev.source === "upload") {
      const outputs = Object.fromEntries(
        Object.entries(prev.rawOutputs).filter(([, v]) => isGoodOutput(v)),
      );
      return this.startAggregateRun({
        config,
        workspace,
        provider,
        reviewerOutputs: outputs,
        aggregatorModel: prev.aggregatorModel || undefined,
        resumeFrom: resumable,
      });
    }
    return this.startReviewRun({
      config,
      workspace,
      provider,
      triggeredBy: prev.triggeredBy,
      resumeFrom: resumable,
    });
  }

  /**
   * Attach to a run: replay accumulated state, then stream live events.
   * Synchronous on purpose — no interleaving is possible between building
   * the replay snapshot and registering the live listener.
   */
  subscribe(resultId: string): RunSubscription | null {
    const run = this.runs.get(resultId);
    if (!run) return null;

    const replay: ReviewProgress[] = [];
    if (run.done) {
      // Finished run: the terminal event carries the full result — committee
      // text replay is unnecessary.
      for (const ev of run.discrete) replay.push(ev);
    } else {
      for (const ev of run.discrete) {
        // Terminal events can't appear here while live, but guard anyway.
        if (ev.phase === "run.started") continue;
        replay.push(ev);
      }
      const started = run.discrete[0];
      replay.unshift(started ?? { phase: "run.started", runId: run.resultId, configId: run.configId, configName: run.configName });
      // Replay reviewer cards in their original order.
      const models = [...run.reviewerOrder.entries()].sort((a, b) => a[1] - b[1]);
      for (const [model, index] of models) {
        replay.push({ phase: "committee.start", model, reviewerIndex: index, reviewerCount: models.length });
        const text = run.reviewerTexts.get(model);
        if (text) replay.push({ phase: "committee.delta", model, reviewerIndex: index, text });
        if (run.reviewerDone.has(model)) {
          const err = run.reviewerDone.get(model);
          replay.push({ phase: "committee.done", model, reviewerIndex: index, ...(err ? { error: err } : {}) });
        }
      }
      if (run.aggReasoning) replay.push({ phase: "aggregator.reasoning", text: run.aggReasoning });
      if (run.aggText) replay.push({ phase: "aggregator.delta", text: run.aggText });
    }

    return {
      replay,
      done: run.done,
      live: (listener) => {
        run.listeners.add(listener);
        return () => { run.listeners.delete(listener); };
      },
    };
  }

  /** Snapshot of runs currently in flight (not done), optionally filtered by
   *  workspace root. */
  activeRuns(workspaceRoot?: string): ActiveRunInfo[] {
    const out: ActiveRunInfo[] = [];
    for (const run of this.runs.values()) {
      if (run.done) continue;
      if (workspaceRoot && run.workspaceRoot !== workspaceRoot) continue;
      const last = run.discrete[run.discrete.length - 1];
      out.push({
        resultId: run.resultId,
        configId: run.configId,
        configName: run.configName,
        workspaceRoot: run.workspaceRoot,
        triggeredBy: run.triggeredBy,
        resumed: run.resumed,
        phase: last?.phase ?? "context",
        startedAt: run.startedAt,
      });
    }
    return out;
  }

  /** Test hook. */
  _reset(): void {
    for (const run of this.runs.values()) {
      if (run.evictTimer) clearTimeout(run.evictTimer);
    }
    this.runs.clear();
  }
}

/** Shared singleton — runs survive request lifecycles because the manager
 *  (not the request) owns the generator. */
export const reviewRunManager = new ReviewRunManager();
