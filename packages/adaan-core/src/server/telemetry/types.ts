// ============================================================================
// Telemetry Types — Phase 1 (Measure)
//
// A "request" is one LLM call. A "task" is one user message → agent done.
// Daily rollups aggregate both and double as the seed for the Phase 3
// capability matrix (per-model empirical success/latency/cost).
// ============================================================================

/** Coarse classification of why an LLM request was made within a task. */
export type RequestType =
  | "planning" // first call of a task (no prior tool results)
  | "coding" // call following one or more successful tool calls
  | "debugging" // call following a tool error / failed verification
  | "final_response"; // forced summary turn after the iteration cap

/** Token usage reported by OpenRouter's final SSE chunk (real, not estimated). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number; // prompt-cache hits, if reported
  reasoningTokens: number; // reasoning/thinking tokens, if reported
}

/** One LLM request record. */
export interface RequestRecord {
  requestId: string;
  sessionId: string;
  taskId: string;
  model: string;
  provider: string;
  timestamp: number;
  /** ISO date (YYYY-MM-DD) — denormalized for fast daily bucketing. */
  day: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  cost: number;
  requestType: RequestType;
  /** Estimated context size (tokens) sent into this request, pre-pruning. */
  contextTokens: number;
  /** Number of tool calls executed before this request within the task. */
  toolCallsBeforeRequest: number;
  /** Agent loop iteration index (0-based) when this request was issued. */
  iteration: number;
  success: boolean;
}

/** Outcome of a user task (one user message → agent done/error/cancelled). */
export type TaskStatus = "success" | "error" | "cancelled";

/** One user-task record. */
export interface TaskRecord {
  taskId: string;
  sessionId: string;
  model: string;
  /** First line / truncated first user message — for the recent-task list. */
  prompt: string;
  timestamp: number;
  day: string;
  durationMs: number;
  status: TaskStatus;
  /** Number of LLM requests issued while serving this task. */
  requestCount: number;
  /** Number of tool calls executed (excluding cache hits). */
  toolCalls: number;
  /** Tool calls served from the result cache (no LLM round-trip needed). */
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
  /** Estimated context tokens that would have been sent without pruning. */
  rawContextTokens: number;
  /** Actual context tokens sent (sum of per-request contextTokens). */
  actualContextTokens: number;
  /** Number of messages pruned across all requests in this task. */
  prunedMessages: number;
  /** Tokens saved by truncating large tool results before history (A1). */
  truncationTokensSaved: number;
  /** Tokens saved by compacting old tool messages during pruning (A2). */
  compactionTokensSaved: number;
  /** Number of redundant tool calls blocked by the repeat-failure guard (B1). */
  redundantCallsAvoided: number;
  /** Whether a workspace snapshot was injected on this task's first request (A3). */
  snapshotInjected: boolean;
  /** Phase 3: whether this task was routed by the adaptive router or manually. */
  routedBy: "auto" | "manual";
  /** Phase 3: task category from the classifier. */
  category: string | null;
  /** Phase 3: number of intra-task escalations. */
  escalations: number;
  /** Phase 4: implicit outcome signal (verified/accepted/silent/corrected/rejected/rolled_back). */
  outcome: string;
}

/** Per-model empirical stats for a single day — the capability-matrix seed. */
export interface ModelDailyStats {
  model: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  cost: number;
  /** Sum of latencies — divide by requests for average. */
  totalLatencyMs: number;
  /** Number of tasks that used this model as their primary model. */
  tasks: number;
  /** Tasks that ended in "success" while using this model. */
  taskSuccesses: number;
}

/** Aggregated metrics for one calendar day. */
export interface DailyRollup {
  day: string;
  tasks: number;
  successfulTasks: number;
  erroredTasks: number;
  cancelledTasks: number;
  requests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  cost: number;
  toolCalls: number;
  cacheHits: number;
  filesRead: number;
  filesModified: number;
  /** Sum of raw (pre-pruning) context tokens across all requests. */
  rawContextTokens: number;
  /** Sum of actual (post-pruning) context tokens across all requests. */
  actualContextTokens: number;
  /** Total messages pruned across all requests. */
  prunedMessages: number;
  /** Tokens saved by truncating large tool results (A1), rolled up across tasks. */
  truncationTokensSaved: number;
  /** Tokens saved by compacting old tool messages during pruning (A2). */
  compactionTokensSaved: number;
  /** Redundant tool calls blocked by the repeat-failure guard (B1). */
  redundantCallsAvoided: number;
  /** Tasks that had a workspace snapshot injected on their first request (A3). */
  snapshotTasks: number;
  /** Phase 3: tasks that were routed by the adaptive router. */
  autoRoutedTasks: number;
  /** Phase 3: total intra-task escalations. */
  escalations: number;
  /** Phase 3: tasks that succeeded after ≥1 escalation. */
  escalationSuccesses: number;
  /** Total task duration in ms. */
  totalTaskDurationMs: number;
  perModel: Record<string, ModelDailyStats>;
}

/** On-disk persistence shape. */
export interface TelemetryData {
  version: 1;
  /** Capped ring of recent task records (most-recent first). */
  recentTasks: TaskRecord[];
  /** Capped ring of recent request records (most-recent first). */
  recentRequests: RequestRecord[];
  /** Unbounded daily rollups keyed by YYYY-MM-DD. */
  rollups: Record<string, DailyRollup>;
}

/** Summary payload returned by GET /api/telemetry/summary. */
export interface TelemetrySummary {
  today: DailyRollup;
  /** Successful tasks per 1,000 LLM requests today — the killer metric
   *  against OpenRouter's daily request cap. */
  successfulTasksPer1000Requests: number;
  /** requests / task today. */
  requestsPerTask: number;
  /** tokens / task today. */
  tokensPerTask: number;
  /** cost / task today. */
  costPerTask: number;
  /** avg task duration today (ms). */
  avgTaskDurationMs: number;
  /** context-pruning savings: 1 - actual/raw today (0..1). */
  contextSavingsPct: number;
  /** cache-hit rate: cacheHits / (cacheHits + toolCalls) today (0..1). */
  cacheHitRate: number;
  /** Phase 2 reduction metrics for today. */
  reduction: {
    truncationTokensSaved: number;
    compactionTokensSaved: number;
    redundantCallsAvoided: number;
    snapshotTasks: number;
  };
  /** Phase 3 optimization metrics for today. */
  optimize: {
    autoRoutedTasks: number;
    escalations: number;
    escalationSuccesses: number;
    escalationRate: number;
    escalationSuccessRate: number;
  };
  /** 14-day trend (oldest → newest), each entry a DailyRollup. */
  trend: DailyRollup[];
  /** Recent tasks (most-recent first), capped. */
  recentTasks: TaskRecord[];
}
