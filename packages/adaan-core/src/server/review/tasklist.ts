import type { LivingTaskList, ReviewTask, TaskPriority } from "./types.js";

/**
 * The living task list.
 *
 * Each review run produces a fresh set of tasks; this module merges them into
 * the persisted per-config list so the list *updates* instead of duplicating:
 *
 * - Tasks are matched across runs by a fingerprint of the issue text
 *   (word-set hash — tolerant of reordering and punctuation changes).
 * - A task flagged again keeps its identity: `firstSeenAt`, `githubUrl`, and
 *   a user-set resolved state all carry over.
 * - A task missing from the latest run is auto-resolved (the committee no
 *   longer sees the problem). If it reappears later, it reopens.
 * - A task the user resolved stays resolved even if re-flagged.
 */

const PRIO_ORDER: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Stable fingerprint for a task — djb2 over the sorted lowercase word set. */
export function fingerprintTask(issue: string): string {
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

export interface MergeStats {
  /** Brand-new findings never seen before. */
  added: number;
  /** Findings matched to a previous task. */
  carried: number;
  /** Previous tasks missing from this run → auto-resolved. */
  autoResolved: number;
  /** Previously auto-resolved tasks that came back. */
  reopened: number;
  /** User-resolved tasks still flagged (left resolved). */
  keptResolved: number;
}

/** Merge a run's tasks into the previous living list. Pure. */
export function mergeTaskList(
  previous: ReviewTask[],
  incoming: ReviewTask[],
  now: string,
): { tasks: ReviewTask[]; stats: MergeStats } {
  const stats: MergeStats = { added: 0, carried: 0, autoResolved: 0, reopened: 0, keptResolved: 0 };

  // 1. Dedup within the incoming batch itself (two reviewers can produce the
  //    same finding even after aggregation).
  const incomingByFp = new Map<string, ReviewTask>();
  for (const raw of incoming) {
    const t = { ...raw };
    t.fingerprint = t.fingerprint ?? fingerprintTask(t.issue);
    const existing = incomingByFp.get(t.fingerprint);
    if (existing) {
      existing.lenses = [...new Set([...existing.lenses, ...t.lenses])];
      existing.reviewers = [...new Set([...existing.reviewers, ...t.reviewers])];
    } else {
      incomingByFp.set(t.fingerprint, t);
    }
  }

  const prevByFp = new Map<string, ReviewTask>();
  for (const p of previous) {
    const fp = p.fingerprint ?? fingerprintTask(p.issue);
    if (!prevByFp.has(fp)) prevByFp.set(fp, { ...p, fingerprint: fp });
  }

  const tasks: ReviewTask[] = [];

  // 2. Match incoming against previous.
  for (const t of incomingByFp.values()) {
    const prev = prevByFp.get(t.fingerprint!);
    if (!prev) {
      stats.added++;
      tasks.push({ ...t, firstSeenAt: now, lastSeenAt: now, resolved: false });
      continue;
    }
    prevByFp.delete(t.fingerprint!);
    stats.carried++;
    const carried: ReviewTask = {
      ...t,
      githubUrl: t.githubUrl ?? prev.githubUrl,
      firstSeenAt: prev.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    if (prev.resolved && prev.resolvedBy === "user") {
      // Sticky user dismissal — the committee still sees it, user said no.
      carried.resolved = true;
      carried.resolvedBy = "user";
      stats.keptResolved++;
    } else {
      if (prev.resolved) stats.reopened++;
      carried.resolved = false;
      carried.resolvedBy = undefined;
    }
    tasks.push(carried);
  }

  // 3. Previous tasks not re-flagged → auto-resolve (unless already resolved).
  for (const prev of prevByFp.values()) {
    if (prev.resolved) {
      tasks.push(prev);
    } else {
      stats.autoResolved++;
      tasks.push({ ...prev, resolved: true, resolvedBy: "auto" });
    }
  }

  // 4. Open tasks first (by priority), resolved last.
  tasks.sort((a, b) => {
    const ra = a.resolved ? 1 : 0;
    const rb = b.resolved ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority];
  });

  return { tasks, stats };
}

/** Render the living task list as a GitHub-style TASKS.md markdown file. */
export function buildTasksMarkdown(list: LivingTaskList, configName: string): string {
  const open = list.tasks.filter((t) => !t.resolved);
  const resolved = list.tasks.filter((t) => t.resolved);
  const lines: string[] = [
    `# Task List — ${configName}`,
    "",
    `<!-- Living list maintained by AdaanIDE monitoring. Last updated ${list.updatedAt}. -->`,
    "",
  ];
  for (const p of ["P0", "P1", "P2", "P3"] as TaskPriority[]) {
    const bucket = open.filter((t) => t.priority === p);
    if (bucket.length === 0) continue;
    lines.push(`## ${p}`);
    for (const t of bucket) {
      const lenses = t.lenses.length ? ` _(${t.lenses.join(", ")})_` : "";
      const gh = t.githubUrl ? ` — ${t.githubUrl}` : "";
      lines.push(`- [ ] **${t.issue}** — ${t.fix}${lenses}${gh}`);
    }
    lines.push("");
  }
  if (open.length === 0) lines.push("No open tasks. 🎉", "");
  if (resolved.length > 0) {
    lines.push("## Resolved");
    for (const t of resolved) lines.push(`- [x] ~~${t.issue}~~`);
    lines.push("");
  }
  return lines.join("\n");
}
