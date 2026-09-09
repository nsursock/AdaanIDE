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
  /** true if valid JSON was found and parsed (even if tasks is empty).
   *  false if no JSON object could be extracted from the text. Callers
   *  use this to distinguish "judge returned {tasks: []}" (a valid result
   *  when there are no findings) from "judge produced no JSON at all"
   *  (a failure that should trigger failover). */
  parsed: boolean;
}

/** Parse the aggregator's JSON response: { tasks: [...] } */
export function parseAggregatorJSON(text: string): AggregatorOutput {
  const json = extractFirstJSON(text);
  if (!json) return { tasks: [], parsed: false };
  const tasks: ReviewTask[] = Array.isArray(json.tasks)
    ? json.tasks.map(normalizeTask).filter(Boolean) as ReviewTask[]
    : [];
  return { tasks, parsed: true };
}

/** Parse judge output from content and/or reasoning. Reasoning-channel models
 *  often dump the JSON (or a fenced block) into reasoning and leave content
 *  empty — treating that as failure burned retries in production. */
export function parseAggregatorResponse(content: string, reasoning = ""): AggregatorOutput {
  const fromContent = parseAggregatorJSON(content);
  if (fromContent.parsed) return fromContent;
  if (reasoning.trim()) {
    const fromReasoning = parseAggregatorJSON(reasoning);
    if (fromReasoning.parsed) return fromReasoning;
  }
  if (content.trim() && reasoning.trim()) {
    const fromBoth = parseAggregatorJSON(`${content}\n${reasoning}`);
    if (fromBoth.parsed) return fromBoth;
  }
  return fromContent;
}

const PRIO_RANK: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "over", "under",
  "when", "than", "then", "also", "only", "just", "have", "has", "are", "was",
  "were", "been", "being", "does", "did", "not", "but", "via", "per", "any",
  "all", "can", "may", "its", "use", "used", "using",
]);

function taskTokens(text: string): Set<string> {
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const out = new Set(raw);
  // "look ahead" ↔ "lookahead"
  for (let i = 0; i < raw.length - 1; i++) {
    if (raw[i].length <= 6 && raw[i + 1].length <= 6) out.add(raw[i] + raw[i + 1]);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function significantOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (x.length >= 5 && b.has(x)) n++;
  return n;
}

/** True when two findings likely share a root cause (same bug, different
 *  wording across reviewers). Exact fingerprint match always merges; otherwise
 *  require token overlap on title/finding text. */
export function tasksLikelyDuplicate(a: ReviewTask, b: ReviewTask): boolean {
  const fa = a.fingerprint ?? fingerprintIssue(a.issue);
  const fb = b.fingerprint ?? fingerprintIssue(b.issue);
  if (fa === fb) return true;
  const fullA = taskTokens(`${a.issue} ${a.mainFinding}`);
  const fullB = taskTokens(`${b.issue} ${b.mainFinding}`);
  const jFull = jaccard(fullA, fullB);
  if (jFull >= 0.28) return true;
  if (significantOverlap(fullA, fullB) >= 2) return true;
  const titleA = taskTokens(a.issue);
  const titleB = taskTokens(b.issue);
  if (significantOverlap(titleA, titleB) >= 1 && jaccard(titleA, titleB) >= 0.35) return true;
  return false;
}

function fingerprintIssue(issue: string): string {
  const words = issue
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort();
  const s = words.join(" ");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function mergeTaskPair(primary: ReviewTask, other: ReviewTask): ReviewTask {
  const out: ReviewTask = { ...primary };
  if (PRIO_RANK[other.priority] < PRIO_RANK[out.priority]) out.priority = other.priority;
  out.lenses = [...new Set([...out.lenses, ...other.lenses])];
  out.reviewers = [...new Set([...out.reviewers, ...other.reviewers])];
  if ((other.mainFinding?.length ?? 0) > (out.mainFinding?.length ?? 0)) out.mainFinding = other.mainFinding;
  if ((other.fix?.length ?? 0) > (out.fix?.length ?? 0)) out.fix = other.fix;
  if ((other.impact?.length ?? 0) > (out.impact?.length ?? 0)) out.impact = other.impact;
  if ((other.issueBody?.length ?? 0) > (out.issueBody?.length ?? 0)) out.issueBody = other.issueBody;
  if (other.type && (!out.type || out.type === "improvement")) out.type = other.type;
  if (other.confidence === "high" || (!out.confidence && other.confidence)) out.confidence = other.confidence;
  // Prefer the more specific issue title when priorities tie.
  if (other.issue.length > out.issue.length + 8 && PRIO_RANK[other.priority] <= PRIO_RANK[primary.priority]) {
    out.issue = other.issue;
  }
  return out;
}

/** Deterministic dedupe + priority sort of reviewer priority-table rows.
 *  Used when the judge fails to emit JSON so the run still ends with a clean
 *  priority list instead of a raw concat of near-duplicate rows. */
export function consolidateReviewerTasks(tasks: ReviewTask[]): ReviewTask[] {
  if (tasks.length <= 1) {
    return tasks.map((t) => ({ ...t, fingerprint: t.fingerprint ?? fingerprintIssue(t.issue) }));
  }
  const clusters: ReviewTask[][] = [];
  for (const raw of tasks) {
    const t = { ...raw, fingerprint: raw.fingerprint ?? fingerprintIssue(raw.issue) };
    let matched = -1;
    for (let i = 0; i < clusters.length; i++) {
      if (clusters[i].some((m) => tasksLikelyDuplicate(m, t))) {
        matched = i;
        break;
      }
    }
    if (matched >= 0) clusters[matched].push(t);
    else clusters.push([t]);
  }

  const merged = clusters.map((cluster) => {
    // Seed with highest-priority member, then fold the rest in.
    const ordered = [...cluster].sort((a, b) => {
      const pd = PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
      if (pd !== 0) return pd;
      return (b.mainFinding?.length ?? 0) - (a.mainFinding?.length ?? 0);
    });
    let acc = { ...ordered[0] };
    for (const other of ordered.slice(1)) acc = mergeTaskPair(acc, other);
    if (acc.reviewers.length >= 2) acc.confidence = acc.confidence ?? "high";
    else acc.confidence = acc.confidence ?? "medium";
    if (!acc.type) acc.type = acc.priority === "P0" || acc.priority === "P1" ? "bug" : "risk";
    return acc;
  });

  merged.sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority]);
  return merged;
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
