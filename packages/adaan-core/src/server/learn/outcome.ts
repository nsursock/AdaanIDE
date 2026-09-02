/**
 * Phase 4: Richer task outcomes.
 *
 * Today a task is `success | error | cancelled` — too coarse to learn from.
 * These implicit outcome signals are all detected locally (zero LLM calls).
 */

export type Outcome =
  | "verified"    // task ran run_tests and the final run passed
  | "accepted"    // the editor's diff-review Accept button was clicked
  | "silent"      // none of the above (default; weakest positive)
  | "corrected"   // next user message matches a correction pattern
  | "rejected"    // the editor's diff-review Reject button was clicked
  | "rolled_back"; // git_rollback executed within first 2 iterations of next task

/**
 * Outcome weights for learning. Higher = stronger positive signal.
 * verified/accepted = 1.0 (strongest), silent = 0.7 (weak positive),
 * corrected = 0.2 (barely positive), rejected/rolled_back = near zero.
 */
export const OUTCOME_WEIGHTS: Record<Outcome, number> = {
  verified: 1.0,
  accepted: 1.0,
  silent: 0.7,
  corrected: 0.2,
  rejected: 0.0,
  rolled_back: 0.1,
};

/**
 * Outcome rank for monotonicity — relabelOutcome never downgrades.
 * Higher rank = stronger outcome.
 */
export const OUTCOME_RANK: Record<Outcome, number> = {
  verified: 5,
  accepted: 4,
  silent: 3,
  corrected: 2,
  rolled_back: 1,
  rejected: 0,
};

/**
 * Whether a relabel from `current` to `proposed` is an upgrade.
 * Never downgrades verified/accepted.
 */
export function isUpgrade(current: Outcome, proposed: Outcome): boolean {
  return OUTCOME_RANK[proposed] > OUTCOME_RANK[current];
}

/**
 * Conservative correction pattern — matches user messages that indicate
 * the previous task's output was wrong. Deliberately conservative to avoid
 * false positives on follow-up requests like "no, add a sidebar too".
 */
const CORRECTION_RE =
  /^(no[,!.]?\s|wrong[,!.]?\s|that broke|undo|revert\b|not what I meant|you misunderstood)/i;

/**
 * Check if a user message matches the correction pattern.
 * Pure function — used by the engine to detect corrections.
 */
export function isCorrectionMessage(message: string): boolean {
  return CORRECTION_RE.test(message.trim());
}

/**
 * Check if a tool result from run_tests indicates a passing test run.
 * The run_tests handler returns a ShellResult with exitCode.
 */
export function isTestPass(toolResult: unknown): boolean {
  if (!toolResult || typeof toolResult !== "object") return false;
  const output = (toolResult as any).output ?? toolResult;
  if (typeof output !== "object") return false;
  const exitCode = (output as any).exitCode;
  return exitCode === 0;
}

/**
 * Detect the outcome of a task based on available signals.
 * Pure function — given the task's tool results and feedback, returns
 * the strongest outcome signal.
 *
 * @param testResults - array of run_tests tool results (last one matters)
 * @param feedback - explicit feedback from the editor (accept/reject)
 * @param rolledBack - whether git_rollback was executed in the next task
 * @param nextMessageIsCorrection - whether the next user message is a correction
 */
export function detectOutcome(
  testResults: unknown[],
  feedback?: "accepted" | "rejected" | null,
  rolledBack?: boolean,
  nextMessageIsCorrection?: boolean,
): Outcome {
  // Explicit feedback is strongest.
  if (feedback === "rejected") return "rejected";
  if (feedback === "accepted") return "accepted";

  // Rolled back is a strong negative signal.
  if (rolledBack) return "rolled_back";

  // Correction from the next user message.
  if (nextMessageIsCorrection) return "corrected";

  // Verified: last run_tests passed.
  if (testResults.length > 0) {
    const lastResult = testResults[testResults.length - 1];
    if (isTestPass(lastResult)) return "verified";
  }

  // Default: silent (weak positive).
  return "silent";
}
