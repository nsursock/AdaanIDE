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
  /** How this run was produced: a full committee review or an uploaded
   *  (pasted) analysis judged after the fact. */
  source?: "review" | "upload";
  /** Estimated cost in USD (for paid models). */
  estimatedCost?: number;
  /** Estimated total tokens consumed. */
  estimatedTokens?: number;
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
  | { phase: "committee.done"; model: string; reviewerIndex: number; error?: string }
  | { phase: "cancelled"; message: string }
  | { phase: "aggregator"; message: string; model: string }
  | { phase: "aggregator.queued"; model: string }
  | { phase: "aggregator.delta"; text: string }
  | { phase: "aggregator.reasoning"; text: string }
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
