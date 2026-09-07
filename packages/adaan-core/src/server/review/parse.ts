import type { ReviewLens, ReviewTask, TaskPriority, FindingType, FindingConfidence } from "./types.js";
import { TASK_PRIORITIES, FINDING_TYPES, FINDING_CONFIDENCES } from "./types.js";

/** Derive a 3-5 letter short code from a lens label:
 *  1 word → first 4 letters (Statistician → STAT), 2 words → first 2 letters
 *  of each (Data Scientist → DASC), more → initials (max 5). */
export function lensShortCode(label: string): string {
  const words = label.replace(/[^a-zA-Z\s]/g, "").split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
  if (words.length === 2) return (words[0].slice(0, 2) + words[1].slice(0, 2)).toUpperCase();
  return words.map((w) => w[0]).join("").slice(0, 5).toUpperCase();
}

/** The canonical short code for a lens: the user-defined code when set,
 *  otherwise derived from the label. */
export function lensCode(lens: Pick<ReviewLens, "label" | "code">): string {
  const custom = lens.code?.trim();
  return custom ? custom.toUpperCase() : lensShortCode(lens.label);
}

function safePriority(s: string): TaskPriority {
  const up = s.trim().toUpperCase();
  return (TASK_PRIORITIES as string[]).includes(up) ? (up as TaskPriority) : "P3";
}

function safeFindingType(s: unknown): FindingType | undefined {
  if (typeof s !== "string") return undefined;
  const low = s.trim().toLowerCase();
  return (FINDING_TYPES as string[]).includes(low) ? (low as FindingType) : undefined;
}

function safeConfidence(s: unknown): FindingConfidence | undefined {
  if (typeof s !== "string") return undefined;
  const low = s.trim().toLowerCase();
  return (FINDING_CONFIDENCES as string[]).includes(low) ? (low as FindingConfidence) : undefined;
}

function splitList(s: string): string[] {
  return s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}

/** Parse the trailing priority table from a reviewer's markdown output. */
export function parsePriorityTable(markdown: string): ReviewTask[] {
  const lines = markdown.split("\n");
  let tableStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*\|?\s*priority\s*\|/i.test(lines[i])) { tableStart = i; break; }
  }
  if (tableStart < 0) return [];

  const rows: string[][] = [];
  for (let i = tableStart + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) break;
    if (!line.startsWith("|")) { if (rows.length > 0) break; continue; }
    if (/^\|[\s:|-]+\|?$/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length >= 4) rows.push(cells);
  }

  const tasks: ReviewTask[] = [];
  for (const cells of rows) {
    const [priority, issue, mainFinding, fix, lensesRaw, reviewersRaw, impact] = cells;
    if (!priority || !issue) continue;
    const hasReviewersCol = cells.length >= 7;
    tasks.push({
      priority: safePriority(priority),
      issue: issue.replace(/\*\*/g, "").trim(),
      mainFinding: mainFinding.replace(/\*\*/g, "").trim(),
      fix: fix.replace(/\*\*/g, "").trim(),
      lenses: splitList((lensesRaw || "").replace(/\*\*/g, "")),
      reviewers: hasReviewersCol ? splitList((reviewersRaw || "").replace(/\*\*/g, "")) : [],
      impact: (hasReviewersCol ? impact : reviewersRaw || "").replace(/\*\*/g, "").trim(),
      issueBody: "",
      labels: [],
    });
  }
  return tasks;
}

export interface AggregatorOutput {
  tasks: ReviewTask[];
}

/** Parse the aggregator's JSON response: { tasks: [...] } */
export function parseAggregatorJSON(text: string): AggregatorOutput {
  const json = extractFirstJSON(text);
  if (!json) return { tasks: [] };
  const tasks: ReviewTask[] = Array.isArray(json.tasks)
    ? json.tasks.map(normalizeTask).filter(Boolean) as ReviewTask[]
    : [];
  return { tasks };
}

function extractFirstJSON(text: string): Record<string, unknown> | null {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)) as Record<string, unknown>; }
        catch { return null; }
      }
    }
  }
  return null;
}

function normalizeTask(raw: unknown): ReviewTask | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const issue = typeof o.issue === "string" ? o.issue.trim() : "";
  if (!issue) return null;
  return {
    priority: safePriority(String(o.priority ?? "P3")),
    issue,
    mainFinding: typeof o.mainFinding === "string" ? o.mainFinding.trim() : "",
    fix: typeof o.fix === "string" ? o.fix.trim() : "",
    lenses: Array.isArray(o.lenses) ? o.lenses.map(String) : splitList(String(o.lenses ?? "")),
    reviewers: Array.isArray(o.reviewers) ? o.reviewers.map(String) : splitList(String(o.reviewers ?? "")),
    impact: typeof o.impact === "string" ? o.impact.trim() : "",
    issueBody: typeof o.issueBody === "string" ? o.issueBody : typeof o.body === "string" ? o.body : "",
    labels: Array.isArray(o.labels) ? o.labels.map(String) : splitList(String(o.labels ?? "")),
    type: safeFindingType(o.type),
    confidence: safeConfidence(o.confidence),
    githubUrl: typeof o.githubUrl === "string" ? o.githubUrl : undefined,
  };
}

/** Build a GitHub-issue-style body for a task that's missing one.
 *  Follows the format: Summary → Current behavior → Expected behavior →
 *  Affected code → Acceptance criteria → References */
export function buildIssueBody(
  task: Pick<ReviewTask, "priority" | "issue" | "mainFinding" | "fix" | "impact" | "lenses" | "reviewers" | "type" | "confidence">,
): string {
  return [
    "## Summary",
    task.mainFinding || task.issue,
    "",
    "## Current behavior",
    `The code currently exhibits: ${task.mainFinding || task.issue}.`,
    `Impact: ${task.impact || "—"}`,
    "",
    "## Expected behavior",
    `After the fix: ${task.fix || "—"}`,
    "",
    "## Affected code",
    `**Lens(es):** ${task.lenses.join(", ") || "—"}`,
    `**Reviewer(s):** ${task.reviewers.join(", ") || "—"}`,
    "",
    "## Acceptance criteria",
    "- [ ] The issue described in the Summary is resolved",
    "- [ ] No new regressions introduced",
    "- [ ] Tests pass and cover the fix",
    "",
    "## References",
    ...(task.type ? [`- **Type:** ${task.type}`] : []),
    ...(task.confidence ? [`- **Confidence:** ${task.confidence}`] : []),
    `- **Lenses:** ${task.lenses.join(", ") || "—"}`,
    `- **Reviewers:** ${task.reviewers.join(", ") || "—"}`,
    `- **Priority:** ${task.priority}`,
  ].join("\n");
}

/** Extract the "## Summary" section text from a GitHub-style issue body. */
export function extractIssueBodySummary(issueBody: string): string {
  const m = issueBody.match(/^##\s*Summary\s*\n([\s\S]+?)(?=\n##\s|$)/im);
  return m ? m[1].trim() : "";
}

/** Backfill empty structured fields from the issue body so partial judge
 *  output (a common failure mode) doesn't leave blank table columns.
 *  Only fills fields that are empty — never overwrites. */
export function backfillTaskFields(task: ReviewTask): void {
  if (!task.mainFinding) {
    task.mainFinding = extractIssueBodySummary(task.issueBody) || task.issue;
  }
}

/** Build labels for a task. */
export function buildLabels(task: Pick<ReviewTask, "priority" | "lenses" | "type">): string[] {
  return [
    `priority:${task.priority.toLowerCase()}`,
    ...task.lenses.map((l) => `lens:${l.toLowerCase().replace(/\s+/g, "-")}`),
    ...(task.type ? [`type:${task.type}`] : []),
  ];
}
