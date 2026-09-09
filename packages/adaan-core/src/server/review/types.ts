// ============================================================================
// Monitoring — Committee Code Review that generates a living prioritized task
// list. Reviews the project every N hours/days/weeks through configurable
// AI personas ("lenses") at a chosen expertise level, across N reviewer models
// running in parallel. An aggregator/judge model merges all outputs into one
// structured, deduplicated task list.
// ============================================================================

/** Expertise level — injected into every lens prompt. */
export type ExpertiseLevel = "top-0.1%" | "top-1%" | "top-10%" | "top-25%";
export const EXPERTISE_LEVELS: ExpertiseLevel[] = ["top-0.1%", "top-1%", "top-10%", "top-25%"];

/** Model pool tier — which models are available for selection. */
export type ModelTier = "free" | "paid" | "all";
export const MODEL_TIERS: ModelTier[] = ["free", "paid", "all"];

/** A single reviewer persona / lens. */
export interface ReviewLens {
  id: string;
  emoji: string;
  /** User-defined short code used to match tasks back to this lens
   *  (e.g. "STAT", "EMS"). Derived from the label when empty. */
  code?: string;
  label: string;
  /** The role description, e.g. "quant researcher". The expertise prefix is
   *  prepended automatically at prompt-build time. Falls back to the label. */
  role?: string;
}

/** Priority bucket for a task (GitHub-triage style). */
export type TaskPriority = "P0" | "P1" | "P2" | "P3";
export const TASK_PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3"];

/** Finding type — distinguishes confirmed defects from risks and improvements. */
export type FindingType = "bug" | "risk" | "improvement";
export const FINDING_TYPES: FindingType[] = ["bug", "risk", "improvement"];

/** Confidence level — how well the evidence supports the finding. */
export type FindingConfidence = "high" | "medium" | "low";
export const FINDING_CONFIDENCES: FindingConfidence[] = ["high", "medium", "low"];

/** A single prioritized task in the living task list. */
export interface ReviewTask {
  priority: TaskPriority;
  /** Concise issue title (one short phrase). */
  issue: string;
  /** One crisp sentence describing the core problem. */
  mainFinding: string;
  /** One crisp sentence describing the proposed solution. */
  fix: string;
  /** Lens ids that flagged this task. */
  lenses: string[];
  /** Reviewer model ids that flagged this task. */
  reviewers: string[];
  /** One crisp sentence describing the real-world consequence. */
  impact: string;
  /** GitHub-issue-ready markdown body. */
  issueBody: string;
  /** Labels for GitHub issue creation. */
  labels: string[];
  /** Finding type: bug (confirmed defect), risk (likely but unverified), or
   *  improvement (valid engineering improvement, not a defect). Only `bug`
   *  should reach P0. */
  type?: FindingType;
  /** How well the evidence supports the finding. */
  confidence?: FindingConfidence;
  /** URL of the created GitHub issue, if any. */
  githubUrl?: string;
  /** Whether this task was resolved/dismissed since the last run. */
  resolved?: boolean;
  /** Who resolved it: the user (sticky — stays resolved even if re-flagged)
   *  or auto (missing from the latest run — reopens if re-flagged). */
  resolvedBy?: "user" | "auto";
  /** Stable fingerprint derived from the issue text — used to match the same
   *  finding across runs so the living task list never duplicates. */
  fingerprint?: string;
  /** ISO timestamp of the first run that flagged this task. */
  firstSeenAt?: string;
  /** ISO timestamp of the most recent run that flagged this task. */
  lastSeenAt?: string;
}

/** The per-config living task list, persisted across runs. */
export interface LivingTaskList {
  configId: string;
  tasks: ReviewTask[];
  updatedAt: string;
}

/** A saved, reusable review configuration. */
export interface ReviewConfig {
  id: string;
  name: string;
  /** The lenses (personas) that make up the committee. */
  lenses: ReviewLens[];
  /** Expertise level injected into every lens prompt. */
  expertise: ExpertiseLevel;
  /** Which model pool to draw from. */
  modelTier: ModelTier;
  /** Specific reviewer model ids. When empty, auto-picks from the tier. */
  reviewerModels: string[];
  /** Aggregator/judge model that merges all reviewer outputs. "auto" = first reviewer. */
  aggregatorModel: string;
  /** Schedule: every N units. 0 = manual only. */
  intervalValue: number;
  /** Schedule unit. */
  intervalUnit: "hours" | "days" | "weeks";
  /** Optional target path (relative to workspace root) to limit the review. */
  targetPath?: string;
  /** Absolute workspace root path this config reviews. */
  workspaceRoot?: string;
  /** Whether to auto-create GitHub issues for P0/P1 tasks. */
  createGitHubIssues: boolean;
  /** Whether to write the living task list to TASKS.md in the workspace root
   *  after each run. */
  writeTasksFile?: boolean;
  /** Per-request hard deadline in ms for reviewer and aggregator LLM calls.
   *  Review prompts are large (10k+ tokens) and models with reasoning can
   *  take 2-4 minutes. Default 300s. 0 = use provider default (180s). */
  timeoutMs?: number;
  /** Whether this config's schedule is active. */
  enabled: boolean;
  /** ISO timestamp of the last scheduled run. */
  lastRunAt?: string;
}

/** A completed (or in-progress) review run. */
export interface ReviewResult {
  id: string;
  configId: string;
  configName: string;
  startedAt: string;
  completedAt?: string;
  expertise: ExpertiseLevel;
  reviewerModels: string[];
  aggregatorModel: string;
  targetPath?: string;
  tasks: ReviewTask[];
  /** Raw outputs from each reviewer model, keyed by model id. For uploaded
   *  analyses these are the pasted texts, keyed by the pasted names. */
  rawOutputs: Record<string, string>;
  /** Raw text output from the aggregator/judge model (its JSON response).
   *  Kept for debugging the task-list generation. */
  aggregatorOutput?: string;
  /** Reasoning text streamed from the aggregator/judge model (when the
   *  model exposes a reasoning channel, e.g. GLM/o-series). Kept so the
   *  raw-output modal can show the judge's thinking rather than just the
   *  final JSON task list. */
  aggregatorReasoning?: string;
  /** How this run was produced: a full committee review or an uploaded
   *  (pasted) analysis judged after the fact. */
  source?: "review" | "upload";
  /** Estimated cost in USD (for paid models). */
  estimatedCost?: number;
  /** Actual total cost in USD summed from OpenRouter generation metadata. */
  actualCost?: number;
  /** Estimated total tokens consumed. */
  estimatedTokens?: number;
  /** Actual total tokens consumed summed from OpenRouter generation metadata. */
  actualTokens?: number;
  /** `interrupted` = the server process stopped (quit/restart) while this run
   *  was in progress. Completed reviewer outputs are preserved in rawOutputs
   *  so the run can be resumed instead of re-run from scratch. */
  status: "running" | "complete" | "error" | "cancelled" | "interrupted";
  error?: string;
  triggeredBy: "manual" | "schedule";
  /** Living-list merge statistics for this run. */
  mergeStats?: { added: number; carried: number; autoResolved: number; reopened: number; keptResolved: number };
  /** OpenRouter generation IDs captured from the SSE stream, keyed by model
   *  id. Used for post-hoc auditing via GET /api/v1/generation?id=<genId>
   *  to retrieve per-generation metadata (provider, latency, TTFT, tokens,
   *  cost, routing). Includes both reviewer and aggregator generations. */
  generationIds?: Record<string, string>;
  /** Actual generation metadata fetched from the OpenRouter Generation API
   *  after the run completes, keyed by the requested model id. Shows what
   *  model/provider OpenRouter actually routed to — critical for
   *  understanding failover (e.g. requested gemma → got cohere via 429
   *  failover) and auto-router decisions (e.g. openrouter/auto → GPT-5.6). */
  generationMetadata?: Record<string, GenerationMetadata>;
  /** Reviewer same-model retries that occurred during this run — each entry
   *  records a slot where the model errored, returned empty, or truncated,
   *  and was retried on the SAME model (possibly with a raised token budget
   *  for truncation) before any spare-model failover. Distinct from
   *  `failovers` which records swaps to a different model. */
  retries?: { model: string; reviewerIndex: number; reason: string; maxTokens: number }[];
  /** Reviewer failovers that occurred during this run — each entry records
   *  a slot that errored or produced empty output and was retried on a spare
   *  model from the same tier pool. Useful for explaining why a run's
   *  `reviewerModels` differ from the config's selected models. */
  failovers?: { from: string; to: string; reviewerIndex: number; reason: string }[];
  /** Aggregator same-model retries — the judge was retried on the SAME model
   *  (possibly with a raised token budget) before any spare-model failover. */
  aggregatorRetries?: { model: string; reason: string; maxTokens: number }[];
  /** Aggregator failovers that occurred during this run — the judge model
   *  errored, produced only truncated/degenerate reasoning, or returned no
   *  parseable JSON, and was retried on a spare model from the same tier
   *  pool. Useful for explaining why `aggregatorModel` differs from the
   *  config's selected model. */
  aggregatorFailovers?: { from: string; to: string; reason: string }[];
  /** Where the final task list came from. `aggregator` = judge emitted
   *  parseable JSON; `fallback` = deterministic consolidate of reviewer
   *  priority tables after the judge failed. */
  taskListSource?: "aggregator" | "fallback";
}

/** Metadata for a single OpenRouter generation, fetched from
 *  GET /api/v1/generation?id=<genId>. Captures what actually happened —
 *  the real model, provider, cost, tokens, and routing — vs what was
 *  requested. */
export interface GenerationMetadata {
  /** The generation id (e.g. "gen-..."). */
  id: string;
  /** The model slug OpenRouter actually routed to (may differ from the
   *  requested model on failover or when using openrouter/auto). */
  model: string;
  /** The upstream provider that served the request (e.g. "Cohere",
   *  "Google AI Studio", "OpenAI"). */
  providerName?: string;
  /** The router used (e.g. "openrouter/auto" or the model slug itself). */
  router?: string;
  /** Total cost in USD for this generation. 0 for free models. */
  totalCost: number;
  /** Prompt (input) tokens. */
  tokensPrompt: number;
  /** Completion (output) tokens. */
  tokensCompletion: number;
  /** Reasoning tokens (if the model exposes a reasoning channel). */
  tokensReasoning?: number;
  /** Cached tokens (if prompt caching was applied). */
  tokensCached?: number;
  /** Latency in ms (total request time). */
  latency?: number;
  /** Time to first token in ms. */
  timeToFirstToken?: number;
  /** Finish reason ("stop", "length", "error", etc.). */
  finishReason?: string;
  /** Whether this generation used BYOK (bring-your-own-key). */
  isByok?: boolean;
  /** When the generation was created (ISO string). */
  createdAt?: string;
}

/** SSE progress event yielded by the runner. */
export type ReviewProgress =
  /** Emitted first by the run manager (also replayed to re-attaching clients)
   *  so the client knows the run id for re-attach. `resumed` marks a run that
   *  continued from an interrupted result. */
  | { phase: "run.started"; runId: string; configId: string; configName: string; resumed?: boolean }
  | { phase: "context"; message: string }
  | { phase: "cost"; estimatedCost: number; estimatedTokens: number }
  | { phase: "committee"; message: string; model: string; reviewerIndex: number; reviewerCount: number }
  | { phase: "committee.start"; model: string; reviewerIndex: number; reviewerCount: number }
  | { phase: "committee.queued"; model: string; reviewerIndex: number; reviewerCount: number }
  | { phase: "committee.delta"; model: string; reviewerIndex: number; text: string }
  | { phase: "committee.retry"; model: string; reviewerIndex: number; reviewerCount: number; reason: string; maxTokens: number }
  | { phase: "committee.failover"; from: string; to: string; reviewerIndex: number; reviewerCount: number; reason: string }
  | { phase: "committee.done"; model: string; reviewerIndex: number; error?: string }
  | { phase: "cancelled"; message: string }
  | { phase: "aggregator"; message: string; model: string }
  | { phase: "aggregator.queued"; model: string }
  | { phase: "aggregator.delta"; text: string }
  | { phase: "aggregator.reasoning"; text: string }
  | { phase: "aggregator.retry"; model: string; reason: string; maxTokens: number }
  | { phase: "aggregator.failover"; from: string; to: string; reason: string }
  | { phase: "parse"; message: string }
  | { phase: "github"; message: string; taskIndex: number }
  | { phase: "complete"; result: ReviewResult }
  | { phase: "error"; message: string };

/** A named preset committee. */
export interface ReviewPreset {
  id: string;
  name: string;
  description: string;
  lenses: ReviewLens[];
  /** Whether this is a quick smoke-test preset (few lenses, fast). */
  smokeTest?: boolean;
}
