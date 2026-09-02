/**
 * Single-shot weak-tier pipeline (Phase C).
 *
 * Replaces the multi-turn ReAct loop for weak (sub-5B local) models with
 * 2 narrow, stateless, code-orchestrated LLM calls: classify → edit.
 * Each call uses a FRESH provider message array — no transcript accumulation,
 * which prevents the drift that plagues weak models in long ReAct loops.
 *
 * All functions here are pure and unit-testable — no provider access, no
 * workspace I/O. The engine integration (C2) wires them together with
 * the provider and workspace.
 */

// --- Types ------------------------------------------------------------------

export interface ClassifyResult {
  action: "edit" | "create" | "explain" | "search" | "reject";
  targetFiles: string[];
  reason: string;
}

export interface FileContent {
  path: string;
  content: string;
}

// --- Token estimation (rough — 4 chars per token) ---------------------------

const CHARS_PER_TOKEN = 4;
const CLASSIFY_INPUT_BUDGET = 1500;
const EDIT_INPUT_BUDGET = 6000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// --- Classify prompt + parser -----------------------------------------------

export function buildClassifyPrompt(request: string, fileTree: string): string {
  // Truncate file tree to stay within the classify input budget.
  const requestTokens = estimateTokens(request);
  const remainingBudget = CLASSIFY_INPUT_BUDGET - requestTokens - 200; // 200 for template
  let tree = fileTree;
  if (estimateTokens(tree) > remainingBudget) {
    const maxChars = remainingBudget * CHARS_PER_TOKEN;
    tree = tree.slice(0, maxChars) + "\n... (truncated)";
  }

  return `You are a task classifier. Analyze the user's request and determine the action type and target files.

User request:
${request}

Workspace files:
${tree}

Respond in one of these formats:

Option A (JSON):
{"action": "edit", "targetFiles": ["path/to/file.py"], "reason": "fix a bug"}
{"action": "create", "targetFiles": ["new_file.py"], "reason": "new file"}
{"action": "explain", "targetFiles": [], "reason": "user wants explanation"}
{"action": "search", "targetFiles": [], "reason": "needs exploration"}

Option B (tagged lines):
ACTION: edit
FILES: src/main.py, src/utils.py
REASON: fix import error

Rules:
- action "edit" = modify existing files (targetFiles required, non-empty)
- action "create" = create new files (targetFiles required, non-empty)
- action "explain" = user wants an explanation, no file changes
- action "search" = needs exploration/search before acting
- action "reject" = task is too large or unclear for a single-shot approach
- If the total size of target files would exceed ~6000 tokens, use "reject" with reason "too large for single-shot"
- For multi-file refactors or complex tasks, use "reject"`;
}

export function parseClassifyResponse(raw: string): ClassifyResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try JSON first.
  try {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (
        typeof parsed.action === "string" &&
        ["edit", "create", "explain", "search", "reject"].includes(parsed.action)
      ) {
        const targetFiles = Array.isArray(parsed.targetFiles)
          ? parsed.targetFiles.filter((f: unknown) => typeof f === "string").map((f: string) => f.trim()).filter(Boolean)
          : [];
        return {
          action: parsed.action as ClassifyResult["action"],
          targetFiles,
          reason: typeof parsed.reason === "string" ? parsed.reason : "",
        };
      }
    }
  } catch {
    // Fall through to tagged-line format.
  }

  // Tagged-line fallback: ACTION: ..., FILES: ..., REASON: ...
  const actionMatch = trimmed.match(/^ACTION:\s*(\w+)/im);
  if (actionMatch) {
    const action = actionMatch[1].toLowerCase();
    if (["edit", "create", "explain", "search", "reject"].includes(action)) {
      const filesMatch = trimmed.match(/^FILES:\s*(.+)$/im);
      const reasonMatch = trimmed.match(/^REASON:\s*(.+)$/im);
      const targetFiles = filesMatch
        ? filesMatch[1].split(",").map((f) => f.trim()).filter(Boolean)
        : [];
      return {
        action: action as ClassifyResult["action"],
        targetFiles,
        reason: reasonMatch ? reasonMatch[1].trim() : "",
      };
    }
  }

  return null;
}

// --- Edit prompt builder ----------------------------------------------------

export function buildEditPrompt(
  request: string,
  files: FileContent[],
): string {
  // Check total size budget.
  const requestTokens = estimateTokens(request);
  const fileTokens = files.reduce((s, f) => s + estimateTokens(f.content), 0);
  const total = requestTokens + fileTokens;
  if (total > EDIT_INPUT_BUDGET) {
    // This shouldn't happen if classify worked correctly, but guard anyway.
    // Truncate the largest files to fit.
    const overflow = total - EDIT_INPUT_BUDGET;
    const charsToCut = overflow * CHARS_PER_TOKEN;
    // Sort by content size descending, truncate from the largest.
    const sorted = [...files].sort((a, b) => b.content.length - a.content.length);
    let cut = 0;
    for (const f of sorted) {
      if (cut >= charsToCut) break;
      const cutFromThis = Math.min(f.content.length, charsToCut - cut);
      f.content = f.content.slice(0, f.content.length - cutFromThis) + "\n... (truncated to fit budget)";
      cut += cutFromThis;
    }
  }

  const fileSections = files.map((f) =>
    `FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
  ).join("\n\n");

  return `You are a code editor. The user wants to modify the file(s) below. Output the COMPLETE new content for each file.

User request:
${request}

Current file contents:
${fileSections}

Output format — for each file you want to modify, output:
FILE: <path>
\`\`\`
<complete new file content>
\`\`\`

Rules:
- Output the COMPLETE file content, not just the changed lines.
- Preserve all existing code that should not change.
- Do NOT include files you are not modifying.
- Do NOT add commentary outside the FILE blocks.
- If creating a new file, use the same format with the new path.`;
}

// --- Edit response parser ---------------------------------------------------

export interface ParsedEdit {
  path: string;
  content: string;
}

export function parseEditResponse(raw: string): ParsedEdit[] {
  const results: ParsedEdit[] = [];
  // Match: FILE: <path> followed by a fenced code block. The content match
  // is greedy up to the last ``` before the next FILE: or end of string,
  // so nested code fences inside the content are preserved.
  const pattern = /FILE:\s*(\S+)\s*\n\s*```\w*\n([\s\S]*?)\n```(?=\s*(?:FILE:|$))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const path = match[1].trim();
    const content = match[2];
    if (path && content !== null) {
      results.push({ path, content });
    }
  }

  // Fallback: try non-greedy match (for simple cases without nested fences).
  if (results.length === 0) {
    const simplePattern = /FILE:\s*(\S+)\s*\n\s*```\w*\n([\s\S]*?)\n```/g;
    while ((match = simplePattern.exec(raw)) !== null) {
      const path = match[1].trim();
      const content = match[2];
      if (path && content !== null) {
        results.push({ path, content });
      }
    }
  }

  // Fallback: also accept unfenced format (FILE: path, then content until
  // next FILE: or end). Weak models sometimes skip the fence.
  if (results.length === 0) {
    const sections = raw.split(/^FILE:\s*/m).filter((s) => s.trim());
    for (const section of sections) {
      const newlineIdx = section.indexOf("\n");
      if (newlineIdx < 0) continue;
      const path = section.slice(0, newlineIdx).trim();
      const content = section.slice(newlineIdx + 1).trim();
      if (path && content) {
        results.push({ path, content });
      }
    }
  }

  return results;
}

// --- Budget check -----------------------------------------------------------

/** Returns true if the total content of the given files exceeds the edit
 *  input budget. Used by the engine to decide whether to fall back to ReAct. */
export function exceedsEditBudget(files: FileContent[]): boolean {
  const total = files.reduce((s, f) => s + estimateTokens(f.content), 0);
  return total > EDIT_INPUT_BUDGET;
}
