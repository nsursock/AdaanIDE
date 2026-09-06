import type { LLMProvider } from "../agent/provider.js";
import type { Workspace } from "../workspace.js";
import { reviewStore } from "./store.js";
import { runReview, registerRun, unregisterRun } from "./runner.js";
import type { ReviewConfig, ReviewResult } from "./types.js";

/**
 * Server-side scheduler for periodic committee reviews.
 *
 * A single setInterval tick (every minute) checks all enabled review configs
 * and triggers a run when `intervalHours` has elapsed since `lastRunAt`. Runs
 * are serialized per-config (a config won't start a new run while one is in
 * progress). The scheduler is started once on server init and lives for the
 * lifetime of the process — works in both the browser (SvelteKit Node server)
 * and Electron (which spawns that same server).
 */

const TICK_MS = 60_000;

export interface SchedulerDeps {
  getProvider: () => LLMProvider;
  getWorkspace: (rootPath: string) => Workspace;
  /** The workspace root to review. Defaults to the first registered workspace
   *  when not specified on the config. */
  defaultWorkspaceRoot?: () => string | undefined;
}

export class ReviewScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>(); // configIds currently running
  private deps: SchedulerDeps;
  /** Whether the global scheduler is enabled (persisted in the review store). */
  enabled = false;
  /** True once the UI explicitly toggles — prevents the store restore from
   *  clobbering a manual toggle during startup. */
  private enabledTouched = false;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    // Restore the persisted armed state so the background batch survives
    // server restarts. Only applies if the UI hasn't explicitly toggled yet.
    void reviewStore.load().then(() => {
      if (!this.enabledTouched) this.enabled = reviewStore.getSchedulerEnabled();
    }).catch(() => { /* best-effort */ });
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // scheduler must never crash the process
      });
    }, TICK_MS);
    // Don't keep the process alive on its own.
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.enabledTouched = true;
    void reviewStore.setSchedulerEnabled(v).catch(() => { /* best-effort */ });
  }

  private async tick(): Promise<void> {
    if (!this.enabled) return;
    await reviewStore.load();
    const now = Date.now();
    for (const config of reviewStore.getConfigs()) {
      if (!config.enabled || config.intervalValue <= 0) continue;
      if (this.running.has(config.id)) continue;
      const last = config.lastRunAt ? Date.parse(config.lastRunAt) : 0;
      const intervalMs = config.intervalValue
        * (config.intervalUnit === "hours" ? 60 * 60 * 1000
          : config.intervalUnit === "days" ? 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000);
      const due = now - last >= intervalMs;
      if (!due) continue;
      void this.runConfig(config).catch(() => {
        // best-effort
      });
    }
  }

  /** Run a config on the schedule. Best-effort; errors are swallowed. */
  private async runConfig(config: ReviewConfig): Promise<void> {
    let provider: LLMProvider;
    let workspace: Workspace;
    try {
      provider = this.deps.getProvider();
      const root = config.workspaceRoot ?? this.deps.defaultWorkspaceRoot?.();
      if (!root) return;
      workspace = this.deps.getWorkspace(root);
    } catch {
      return; // provider/workspace not ready
    }
    this.running.add(config.id);
    const abortCtrl = new AbortController();
    const runId = `sched-${config.id}-${Date.now()}`;
    registerRun(runId, abortCtrl);
    try {
      await reviewStore.touchConfig(config.id, new Date().toISOString());
      const gen = runReview({
        config,
        workspace,
        provider,
        triggeredBy: "schedule",
        signal: abortCtrl.signal,
        onResultUpdate: async (result: ReviewResult) => {
          await reviewStore.updateResult(result);
        },
      });
      // Drain the generator — we don't emit SSE for scheduled runs.
      for await (const _ev of gen) {
        void _ev;
      }
    } catch {
      // best-effort
    } finally {
      this.running.delete(config.id);
      unregisterRun(runId);
    }
  }
}

let scheduler: ReviewScheduler | null = null;

export function initReviewScheduler(deps: SchedulerDeps): ReviewScheduler {
  if (!scheduler) scheduler = new ReviewScheduler(deps);
  return scheduler;
}

export function getReviewScheduler(): ReviewScheduler | null {
  return scheduler;
}
