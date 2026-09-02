// ============================================================================
// Telemetry Metrics — Phase 6 (three views of one data model)
//
// Pure functions over TaskRecord[] / RequestRecord[]. No I/O, no Svelte, no
// singletons — trivially testable with synthetic fixtures. These are the
// "derived metrics" layer that turns the canonical event stream into the
// Paid / Free / Local regime views, the global model table, and the
// Model × Category capability matrix.
//
// Rule: every percentage-producing function returns `n` alongside it, and
// cells with n < 3 are flagged `lowConfidence: true` so the dashboard can
// never fool you with a 100% (N=1) cell.
// ============================================================================

import type { TaskRecord, RequestRecord, Regime } from "./types.js";

// ---------------------------------------------------------------------------
// Regime metrics — one bundle per economic regime (paid / free / local)
// ---------------------------------------------------------------------------

export interface RegimeMetrics {
  regime: Regime;
  /** Number of tasks in this regime. */
  tasks: number;
  /** Number of successful tasks. */
  successfulTasks: number;
  /** Number of errored tasks. */
  erroredTasks: number;
  /** Number of cancelled tasks. */
  cancelledTasks: number;
  /** successfulTasks / tasks (0..1). 0 when tasks === 0. */
  successRate: number;
  /** Total LLM requests across all tasks in this regime. */
  requests: number;
  /** Successful tasks per 1,000 LLM requests — the killer free-regime metric. */
  tasksPer1000Requests: number;
  /** Successful tasks per 100 LLM requests. */
  tasksPer100Requests: number;
  /** requests / tasks. 0 when tasks === 0. */
  requestsPerTask: number;
  /** requests / successfulTasks. 0 when successfulTasks === 0. */
  requestsPerSuccessfulTask: number;
  /** (inputTokens + outputTokens) / tasks. */
  tokensPerTask: number;
  /** (inputTokens + outputTokens) / requests. */
  tokensPerRequest: number;
  /** Total cost in USD. */
  cost: number;
  /** cost / tasks. */
  costPerTask: number;
  /** cost / successfulTasks. 0 when successfulTasks === 0. */
  costPerSuccessfulTask: number;
  /** Median task duration in ms. */
  p50DurationMs: number;
  /** 95th-percentile task duration in ms. */
  p95DurationMs: number;
  /** Median per-request latency in ms. */
  p50LatencyMs: number;
  /** 95th-percentile per-request latency in ms. */
  p95LatencyMs: number;
  /** escalations / tasks. */
  escalationRate: number;
  /** retries / tasks. */
  retryRate: number;
  /** fallbacks / tasks. */
  fallbackRate: number;
  /** Total tool calls (excluding cache hits). */
  toolCalls: number;
  /** toolCalls / tasks. */
  toolCallsPerTask: number;
  /** cacheHits / (cacheHits + toolCalls). */
  cacheHitRate: number;
  // --- Regime-specific ---
  /** Free only: today's request count (quota consumed). */
  quotaConsumed: number;
  /** Free only: quotaDailyLimit - quotaConsumed. */
  quotaRemaining: number;
  /** Free only: quotaConsumed / quotaDailyLimit (0..1). */
  quotaUsedPct: number;
  /** Local only: successfulTasks / (totalDurationHours). 0 when no duration. */
  tasksPerHour: number;
  /** Local only: sum(outputTokens) / sum(latencyMs) * 1000 — estimated tok/s. */
  tokensPerSecond: number;
  /** Local only: durationMs / successfulTasks. 0 when successfulTasks === 0. */
  timePerSuccessfulTaskMs: number;
}

/** Options for regime metrics computation. */
export interface RegimeMetricsOpts {
  /** Free-regime daily request quota (default 1000). Only affects the
   *  `quota*` fields for the `free` regime. 0 disables the quota display. */
  quotaDailyLimit?: number;
  /** Today's total request count for the free regime — sourced from the
   *  uncapped `DailyRollup.requests`, NOT from `recentRequests` (which is
   *  capped at 2000 and would undercount after a busy period). When omitted,
   *  quota fields fall back to counting free-regime requests in the passed
   *  `requests` array (useful for tests, inaccurate for production). */
  quotaConsumedToday?: number;
}

/**
 * Compute aggregate metrics for a single regime from a set of tasks and the
 * requests that belong to them. Pure — no I/O.
 *
 * `tasks` is filtered to the given regime internally; `requests` should
 * already be the full request set (they're joined by taskId to the
 * regime-filtered tasks).
 */
export function computeRegimeMetrics(
  tasks: TaskRecord[],
  requests: RequestRecord[],
  regime: Regime,
  opts: RegimeMetricsOpts = {},
): RegimeMetrics {
  const quotaDailyLimit = opts.quotaDailyLimit ?? 1000;
  const regimeTasks = tasks.filter((t) => t.regime === regime);
  const regimeTaskIds = new Set(regimeTasks.map((t) => t.taskId));
  const regimeRequests = requests.filter((r) => regimeTaskIds.has(r.taskId));

  const tasksN = regimeTasks.length;
  const successfulTasks = regimeTasks.filter((t) => t.status === "success").length;
  const erroredTasks = regimeTasks.filter((t) => t.status === "error").length;
  const cancelledTasks = regimeTasks.filter((t) => t.status === "cancelled").length;
  const successRate = tasksN > 0 ? successfulTasks / tasksN : 0;

  const requestsN = regimeRequests.length;
  const tasksPer1000Requests = requestsN > 0 ? (successfulTasks / requestsN) * 1000 : 0;
  const tasksPer100Requests = requestsN > 0 ? (successfulTasks / requestsN) * 100 : 0;
  const requestsPerTask = tasksN > 0 ? requestsN / tasksN : 0;
  const requestsPerSuccessfulTask = successfulTasks > 0 ? requestsN / successfulTasks : 0;

  const inputTokens = regimeTasks.reduce((s, t) => s + t.inputTokens, 0);
  const outputTokens = regimeTasks.reduce((s, t) => s + t.outputTokens, 0);
  const totalTokens = inputTokens + outputTokens;
  const tokensPerTask = tasksN > 0 ? totalTokens / tasksN : 0;
  const tokensPerRequest = requestsN > 0 ? totalTokens / requestsN : 0;

  const cost = regimeTasks.reduce((s, t) => s + t.cost, 0);
  const costPerTask = tasksN > 0 ? cost / tasksN : 0;
  const costPerSuccessfulTask = successfulTasks > 0 ? cost / successfulTasks : 0;

  const durations = regimeTasks.map((t) => t.durationMs).sort((a, b) => a - b);
  const p50DurationMs = percentile(durations, 0.5);
  const p95DurationMs = percentile(durations, 0.95);

  const latencies = regimeRequests.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50LatencyMs = percentile(latencies, 0.5);
  const p95LatencyMs = percentile(latencies, 0.95);

  const escalations = regimeTasks.reduce((s, t) => s + t.escalations, 0);
  const retries = regimeTasks.reduce((s, t) => s + t.retries, 0);
  const fallbacks = regimeTasks.reduce((s, t) => s + t.fallbacks, 0);
  const escalationRate = tasksN > 0 ? escalations / tasksN : 0;
  const retryRate = tasksN > 0 ? retries / tasksN : 0;
  const fallbackRate = tasksN > 0 ? fallbacks / tasksN : 0;

  const toolCalls = regimeTasks.reduce((s, t) => s + t.toolCalls, 0);
  const cacheHits = regimeTasks.reduce((s, t) => s + t.cacheHits, 0);
  const toolCallsPerTask = tasksN > 0 ? toolCalls / tasksN : 0;
  const cacheHitRate = toolCalls + cacheHits > 0 ? cacheHits / (toolCalls + cacheHits) : 0;

  // --- Regime-specific ---
  // Quota consumed comes from the uncapped daily rollup (passed explicitly by
  // the API endpoint), NOT from `requests` — `recentRequests` is capped at
  // 2000 and would undercount after a busy period. Fall back to counting
  // free-regime requests in the passed array when no explicit value is given
  // (tests / single-day windows where the cap hasn't been hit).
  const quotaConsumed = regime === "free"
    ? (opts.quotaConsumedToday ?? requestsN)
    : 0;
  const quotaRemaining = regime === "free" ? Math.max(0, quotaDailyLimit - quotaConsumed) : 0;
  const quotaUsedPct = regime === "free" && quotaDailyLimit > 0
    ? Math.min(1, quotaConsumed / quotaDailyLimit)
    : 0;

  const totalDurationMs = regimeTasks.reduce((s, t) => s + t.durationMs, 0);
  const totalDurationHours = totalDurationMs / 3_600_000;
  const tasksPerHour = regime === "local" && totalDurationHours > 0
    ? successfulTasks / totalDurationHours
    : 0;

  const totalOutputTokens = regimeRequests.reduce((s, r) => s + r.outputTokens, 0);
  const totalLatencyMs = regimeRequests.reduce((s, r) => s + r.latencyMs, 0);
  const tokensPerSecond = regime === "local" && totalLatencyMs > 0
    ? (totalOutputTokens / totalLatencyMs) * 1000
    : 0;

  const timePerSuccessfulTaskMs = regime === "local" && successfulTasks > 0
    ? totalDurationMs / successfulTasks
    : 0;

  return {
    regime,
    tasks: tasksN,
    successfulTasks,
    erroredTasks,
    cancelledTasks,
    successRate,
    requests: requestsN,
    tasksPer1000Requests,
    tasksPer100Requests,
    requestsPerTask,
    requestsPerSuccessfulTask,
    tokensPerTask,
    tokensPerRequest,
    cost,
    costPerTask,
    costPerSuccessfulTask,
    p50DurationMs,
    p95DurationMs,
    p50LatencyMs,
    p95LatencyMs,
    escalationRate,
    retryRate,
    fallbackRate,
    toolCalls,
    toolCallsPerTask,
    cacheHitRate,
    quotaConsumed,
    quotaRemaining,
    quotaUsedPct,
    tasksPerHour,
    tokensPerSecond,
    timePerSuccessfulTaskMs,
  };
}

// ---------------------------------------------------------------------------
// Model × Category matrix — N is first-class, lowConfidence when n < 3
// ---------------------------------------------------------------------------

export interface MatrixCell {
  model: string;
  category: string;
  /** Number of tasks for this model+category. ALWAYS present, never optional. */
  n: number;
  /** Number of successful tasks. */
  successes: number;
  /** successes / n (0..1). 0 when n === 0. */
  rate: number;
  /** Average request count per task. */
  avgReqs: number;
  /** True when n < 3 — the dashboard dims these so a 100% (N=1) cell can't
   *  fool you into trusting a model. */
  lowConfidence: boolean;
}

export interface ModelMatrix {
  /** Rows keyed by category, each containing cells per model. */
  byCategory: Record<string, MatrixCell[]>;
  /** All category labels that appear (sorted). */
  categories: string[];
  /** All model ids that appear (sorted by descending task count). */
  models: string[];
  /** Flat list of all cells (for easy table rendering). */
  cells: MatrixCell[];
}

/**
 * Compute the organic Model × Category capability matrix from task records.
 * Every cell carries `n` — a percentage without N is forbidden by construction.
 * Cells with n < 3 are flagged `lowConfidence`.
 *
 * Tasks without a category are assigned to `"uncategorized"`.
 */
export function computeModelMatrix(tasks: TaskRecord[]): ModelMatrix {
  const buckets = new Map<string, { model: string; category: string; n: number; successes: number; totalReqs: number }>();

  for (const t of tasks) {
    const category = t.category ?? "uncategorized";
    const key = `${t.model}\0${category}`;
    const b = buckets.get(key) ?? { model: t.model, category, n: 0, successes: 0, totalReqs: 0 };
    b.n++;
    if (t.status === "success") b.successes++;
    b.totalReqs += t.requestCount;
    buckets.set(key, b);
  }

  const cells: MatrixCell[] = [];
  const categoriesSet = new Set<string>();
  const modelTaskCounts = new Map<string, number>();

  for (const b of buckets.values()) {
    cells.push({
      model: b.model,
      category: b.category,
      n: b.n,
      successes: b.successes,
      rate: b.n > 0 ? b.successes / b.n : 0,
      avgReqs: b.n > 0 ? b.totalReqs / b.n : 0,
      lowConfidence: b.n < 3,
    });
    categoriesSet.add(b.category);
    modelTaskCounts.set(b.model, (modelTaskCounts.get(b.model) ?? 0) + b.n);
  }

  const categories = [...categoriesSet].sort();
  const models = [...modelTaskCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m);

  const byCategory: Record<string, MatrixCell[]> = {};
  for (const cat of categories) {
    byCategory[cat] = cells
      .filter((c) => c.category === cat)
      .sort((a, b) => b.n - a.n);
  }

  return { byCategory, categories, models, cells };
}

// ---------------------------------------------------------------------------
// Global model table — one row per model across all categories
// ---------------------------------------------------------------------------

export interface ModelRow {
  model: string;
  /** Total tasks using this model (as effective model). */
  n: number;
  /** Successful tasks. */
  successes: number;
  /** successes / n (0..1). */
  successRate: number;
  /** Total requests. */
  requests: number;
  /** requests / n. */
  requestsPerTask: number;
  /** Total tokens (input + output). */
  tokens: number;
  /** tokens / n. */
  tokensPerTask: number;
  /** Total cost. */
  cost: number;
  /** Median task duration in ms. */
  p50DurationMs: number;
  /** 95th-percentile task duration in ms. */
  p95DurationMs: number;
  /** Total escalations. */
  escalations: number;
  /** Total retries. */
  retries: number;
  /** Total fallbacks. */
  fallbacks: number;
  /** lowConfidence when n < 3. */
  lowConfidence: boolean;
}

/**
 * Compute a global per-model rollup from task records. One row per effective
 * model, sorted by descending task count. Each row carries `n` and
 * `lowConfidence` so the UI can dim under-sampled models.
 */
export function computeModelTable(tasks: TaskRecord[]): ModelRow[] {
  const groups = new Map<string, TaskRecord[]>();
  for (const t of tasks) {
    const arr = groups.get(t.model) ?? [];
    arr.push(t);
    groups.set(t.model, arr);
  }

  const rows: ModelRow[] = [];
  for (const [model, ts] of groups) {
    const n = ts.length;
    const successes = ts.filter((t) => t.status === "success").length;
    const requests = ts.reduce((s, t) => s + t.requestCount, 0);
    const tokens = ts.reduce((s, t) => s + t.inputTokens + t.outputTokens, 0);
    const cost = ts.reduce((s, t) => s + t.cost, 0);
    const durations = ts.map((t) => t.durationMs).sort((a, b) => a - b);
    const escalations = ts.reduce((s, t) => s + t.escalations, 0);
    const retries = ts.reduce((s, t) => s + t.retries, 0);
    const fallbacks = ts.reduce((s, t) => s + t.fallbacks, 0);
    rows.push({
      model,
      n,
      successes,
      successRate: n > 0 ? successes / n : 0,
      requests,
      requestsPerTask: n > 0 ? requests / n : 0,
      tokens,
      tokensPerTask: n > 0 ? tokens / n : 0,
      cost,
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
      escalations,
      retries,
      fallbacks,
      lowConfidence: n < 3,
    });
  }

  rows.sort((a, b) => b.n - a.n);
  return rows;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Nearest-rank percentile. `sorted` must be ascending. Returns 0 for empty. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  // Nearest-rank method: rank = ceil(p * n), 1-indexed.
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}
