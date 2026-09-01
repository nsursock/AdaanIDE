/**
 * Task classifier — 100% local heuristics, zero LLM calls.
 * Classifies a user prompt into complexity dimensions and a task category
 * so the router can pick the cheapest model likely to succeed.
 */

export type TaskCategory =
  | "fix"
  | "test"
  | "refactor"
  | "greenfield"
  | "exploration"
  | "chat"
  | "workflow";

export interface TaskClassification {
  complexity: number;      // 0..1 — how hard is this overall?
  reasoning: number;       // 0..1 — needs deep thinking?
  coding: number;          // 0..1 — involves writing code?
  toolUse: number;         // 0..1 — needs multiple tool calls?
  contextNeeded: number;   // 0..1 — needs lots of file context?
  multiFile: number;       // 0..1 — touches multiple files?
  category: TaskCategory;
}

// --- Keyword sets ------------------------------------------------------------

const FIX_KEYWORDS = [
  "bug", "fix", "error", "fails", "failing", "broken", "crash", "traceback",
  "exception", "stack trace", "not working", "issue", "wrong", "incorrect",
  "debug", "debugging",
];

const TEST_KEYWORDS = [
  "test", "tests", "testing", "pytest", "jest", "vitest", "unittest",
  "test coverage", "write tests", "add tests", "unit test", "integration test",
];

const REFACTOR_KEYWORDS = [
  "refactor", "clean up", "cleanup", "restructure", "reorganize", "simplify",
  "extract", "rename", "move", "consolidate", "deduplicate", "dry",
];

const GREENFIELD_KEYWORDS = [
  "build", "create", "implement", "develop", "make a", "write a",
  "scaffold", "new app", "new project", "new component", "new file",
  "from scratch", "set up", "setup",
];

const EXPLORATION_KEYWORDS = [
  "what", "explain", "how does", "how do", "why", "show me",
  "describe", "understand", "overview", "explore", "find", "where is",
  "list", "what is",
];

const WORKFLOW_KEYWORDS = [
  "deploy", "ci", "cd", "pipeline", "docker", "kubernetes", "k8s",
  "github actions", "gitlab", "jenkins", "automation", "script",
];

const MULTIFILE_KEYWORDS = [
  "across", "multiple files", "every file", "all files", "entire project",
  "whole project", "refactor the", "restructure the", "migration",
];

const CODE_BLOCK_RE = /```[\s\S]*?```/;
const STACK_TRACE_RE = /(?:Traceback|Error:|Exception:|\bat\s+\w+\s+\(|#\d+\s+in|FAILED|AssertionError)/i;
const LONG_PROMPT_THRESHOLD = 500;

function countMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) count++;
  }
  return count;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Classify a user prompt into complexity dimensions + a category.
 * Pure function — fully deterministic, zero LLM calls.
 */
export function classifyTask(
  prompt: string,
  hints?: { fileCount?: number; hasTests?: boolean },
): TaskClassification {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  const len = text.length;

  // Keyword match counts.
  const fixHits = countMatches(lower, FIX_KEYWORDS);
  const testHits = countMatches(lower, TEST_KEYWORDS);
  const refactorHits = countMatches(lower, REFACTOR_KEYWORDS);
  const greenfieldHits = countMatches(lower, GREENFIELD_KEYWORDS);
  const explorationHits = countMatches(lower, EXPLORATION_KEYWORDS);
  const workflowHits = countMatches(lower, WORKFLOW_KEYWORDS);
  const multiFileHits = countMatches(lower, MULTIFILE_KEYWORDS);

  const hasCodeBlock = CODE_BLOCK_RE.test(text);
  const hasStackTrace = STACK_TRACE_RE.test(text);
  const isLong = len > LONG_PROMPT_THRESHOLD;

  // --- Dimensions (0..1) ---

  const coding = clamp01(
    (fixHits * 0.2) +
    (greenfieldHits * 0.25) +
    (refactorHits * 0.2) +
    (testHits * 0.15) +
    (hasCodeBlock ? 0.2 : 0),
  );

  const reasoning = clamp01(
    (fixHits * 0.15) +
    (refactorHits * 0.15) +
    (workflowHits * 0.1) +
    (isLong ? 0.1 : 0) +
    (hasStackTrace ? 0.2 : 0),
  );

  const toolUse = clamp01(
    (greenfieldHits * 0.2) +
    (fixHits * 0.15) +
    (refactorHits * 0.15) +
    (testHits * 0.1) +
    (workflowHits * 0.1),
  );

  const contextNeeded = clamp01(
    (fixHits * 0.15) +
    (refactorHits * 0.2) +
    (multiFileHits * 0.2) +
    (isLong ? 0.1 : 0) +
    ((hints?.fileCount ?? 0) > 10 ? 0.15 : 0),
  );

  const multiFile = clamp01(
    (multiFileHits * 0.3) +
    (refactorHits * 0.15) +
    (greenfieldHits * 0.1) +
    ((hints?.fileCount ?? 0) > 5 ? 0.2 : 0),
  );

  const complexity = clamp01(
    (coding * 0.3) +
    (reasoning * 0.2) +
    (toolUse * 0.2) +
    (contextNeeded * 0.15) +
    (multiFile * 0.15),
  );

  // --- Category (pick the strongest signal) ---

  const scores: Record<TaskCategory, number> = {
    fix: fixHits + (hasStackTrace ? 2 : 0),
    test: testHits,
    refactor: refactorHits + multiFileHits,
    greenfield: greenfieldHits,
    exploration: explorationHits - (fixHits + greenfieldHits + refactorHits),
    chat: explorationHits > 0 && coding < 0.2 ? explorationHits * 0.5 : 0,
    workflow: workflowHits,
  };

  let category: TaskCategory = "chat";
  let bestScore = 0;
  for (const [cat, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      category = cat as TaskCategory;
    }
  }

  // Default to chat if nothing scored.
  if (bestScore === 0) {
    category = coding > 0.1 ? "greenfield" : "chat";
  }

  return {
    complexity,
    reasoning,
    coding,
    toolUse,
    contextNeeded,
    multiFile,
    category,
  };
}
