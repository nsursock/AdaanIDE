import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintTask, mergeTaskList, buildTasksMarkdown } from "../src/server/review/tasklist.js";
import type { ReviewTask } from "../src/server/review/types.js";

function task(issue: string, priority: ReviewTask["priority"] = "P2", extra: Partial<ReviewTask> = {}): ReviewTask {
  return {
    priority,
    issue,
    mainFinding: "finding",
    fix: "fix",
    lenses: ["security"],
    reviewers: ["model-a"],
    impact: "impact",
    issueBody: "",
    labels: [],
    ...extra,
  };
}

const NOW = "2026-09-05T12:00:00.000Z";

test("fingerprintTask: stable across reordering, case and punctuation", () => {
  const a = fingerprintTask("No stop-loss guard!");
  const b = fingerprintTask("no stop loss guard");
  const c = fingerprintTask("Guard no stop-loss");
  assert.equal(a, b);
  assert.equal(a, c);
  assert.notEqual(fingerprintTask("No stop-loss guard"), fingerprintTask("Missing rate limiting"));
});

test("mergeTaskList: first run marks everything as added and open", () => {
  const { tasks, stats } = mergeTaskList([], [task("A"), task("B")], NOW);
  assert.equal(stats.added, 2);
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((t) => !t.resolved));
  assert.ok(tasks.every((t) => t.fingerprint && t.firstSeenAt === NOW && t.lastSeenAt === NOW));
});

test("mergeTaskList: re-flagged task keeps identity (no duplicate)", () => {
  const first = mergeTaskList([], [task("No stop-loss")], NOW).tasks;
  const later = "2026-09-06T12:00:00.000Z";
  const { tasks, stats } = mergeTaskList(first, [task("no stop loss!")], later);
  assert.equal(tasks.length, 1);
  assert.equal(stats.carried, 1);
  assert.equal(stats.added, 0);
  assert.equal(tasks[0].firstSeenAt, NOW);
  assert.equal(tasks[0].lastSeenAt, later);
});

test("mergeTaskList: carried task keeps githubUrl from previous run", () => {
  const first = mergeTaskList([], [task("A", "P1", { githubUrl: "https://github.com/x/y/issues/3" })], NOW).tasks;
  const { tasks } = mergeTaskList(first, [task("A")], NOW);
  assert.equal(tasks[0].githubUrl, "https://github.com/x/y/issues/3");
});

test("mergeTaskList: missing task auto-resolves; reappearing reopens", () => {
  const run1 = mergeTaskList([], [task("A"), task("B")], NOW).tasks;
  const run2 = mergeTaskList(run1, [task("A")], NOW);
  assert.equal(run2.stats.autoResolved, 1);
  const b = run2.tasks.find((t) => t.issue === "B")!;
  assert.equal(b.resolved, true);
  assert.equal(b.resolvedBy, "auto");

  // B comes back in run 3 → reopened
  const run3 = mergeTaskList(run2.tasks, [task("A"), task("B")], NOW);
  assert.equal(run3.stats.reopened, 1);
  const b3 = run3.tasks.find((t) => t.issue === "B")!;
  assert.equal(b3.resolved, false);
  assert.equal(b3.resolvedBy, undefined);
});

test("mergeTaskList: user-resolved tasks stay resolved when re-flagged", () => {
  const run1 = mergeTaskList([], [task("A")], NOW).tasks;
  run1[0].resolved = true;
  run1[0].resolvedBy = "user";
  const run2 = mergeTaskList(run1, [task("A")], NOW);
  assert.equal(run2.stats.keptResolved, 1);
  assert.equal(run2.tasks[0].resolved, true);
  assert.equal(run2.tasks[0].resolvedBy, "user");
});

test("mergeTaskList: dedups within a single incoming batch", () => {
  const { tasks } = mergeTaskList(
    [],
    [task("No stop-loss", "P0", { lenses: ["quant"] }), task("no stop loss", "P0", { lenses: ["risk"], reviewers: ["model-b"] })],
    NOW,
  );
  assert.equal(tasks.length, 1);
  assert.deepEqual([...tasks[0].lenses].sort(), ["quant", "risk"]);
  assert.deepEqual([...tasks[0].reviewers].sort(), ["model-a", "model-b"]);
});

test("mergeTaskList: sorts open-by-priority first, resolved last", () => {
  const run1 = mergeTaskList([], [task("low", "P3"), task("crit", "P0"), task("gone", "P1")], NOW).tasks;
  const { tasks } = mergeTaskList(run1, [task("low", "P3"), task("crit", "P0")], NOW);
  assert.deepEqual(tasks.map((t) => t.issue), ["crit", "low", "gone"]);
  assert.equal(tasks[2].resolved, true);
});

test("buildTasksMarkdown: groups open tasks by priority, resolved as checked", () => {
  const { tasks } = mergeTaskList([], [task("Fix auth", "P0"), task("Add tests", "P2")], NOW);
  tasks[1].resolved = true;
  tasks[1].resolvedBy = "user";
  const md = buildTasksMarkdown({ configId: "c1", tasks, updatedAt: NOW }, "My Review");
  assert.match(md, /# Task List — My Review/);
  assert.match(md, /## P0/);
  assert.match(md, /- \[ \] \*\*Fix auth\*\*/);
  assert.match(md, /## Resolved/);
  assert.match(md, /- \[x\] ~~Add tests~~/);
  assert.ok(!md.includes("## P1"));
});
