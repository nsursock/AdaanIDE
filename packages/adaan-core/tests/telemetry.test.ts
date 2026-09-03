import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { TelemetryStore } from "../src/server/telemetry/store.js";

/** Fresh store with a deterministic clock and isolated temp file. */
function freshStore(): { store: TelemetryStore; start: number; file: string; tick: (ms: number) => void } {
  const start = Date.now();
  let clock = start;
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "tel-")), "telemetry.json");
  const store = new TelemetryStore();
  store._configure({ now: () => clock, filePath: file });
  return {
    store,
    start,
    file,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

function recordOne(
  store: TelemetryStore,
  task: ReturnType<TelemetryStore["startTask"]>,
  opts: Partial<{
    model: string;
    requestType: any;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
    cost: number;
    contextTokens: number;
    rawContextTokens: number;
    prunedMessages: number;
    iteration: number;
    latencyMs: number;
    success: boolean;
  }> = {},
) {
  store.recordRequest(task, {
    model: opts.model ?? "test/model:free",
    requestType: opts.requestType ?? "planning",
    contextTokens: opts.contextTokens ?? 1000,
    rawContextTokens: opts.rawContextTokens ?? 1000,
    prunedMessages: opts.prunedMessages ?? 0,
    iteration: opts.iteration ?? 0,
    latencyMs: opts.latencyMs ?? 500,
    inputTokens: opts.inputTokens ?? 100,
    outputTokens: opts.outputTokens ?? 50,
    cachedTokens: opts.cachedTokens ?? 0,
    reasoningTokens: opts.reasoningTokens ?? 0,
    cost: opts.cost ?? 0.001,
    success: opts.success ?? true,
  });
}

describe("TelemetryStore — request-type classification", () => {
  it("classifies the first request as planning", () => {
    const { store } = freshStore();
    const task = store.startTask("s1", "test/model:free", "fix the bug");
    assert.equal(store.classifyRequest(task), "planning");
  });

  it("classifies as coding after a successful tool call", () => {
    const { store } = freshStore();
    const task = store.startTask("s1", "test/model:free", "fix the bug");
    store.recordToolCall(task, "read_file", { cached: false, success: true });
    store.markIterationEnd(task, false);
    recordOne(store, task, { requestType: store.classifyRequest(task) });
    assert.equal(store.classifyRequest(task), "coding");
  });

  it("classifies as debugging after a tool error", () => {
    const { store } = freshStore();
    const task = store.startTask("s1", "test/model:free", "fix the bug");
    store.recordToolCall(task, "read_file", { cached: false, success: true });
    store.markIterationEnd(task, false);
    recordOne(store, task, { requestType: store.classifyRequest(task) });
    store.recordToolCall(task, "apply_patch", { cached: false, success: false });
    store.markIterationEnd(task, true);
    assert.equal(store.classifyRequest(task), "debugging");
  });
});

describe("TelemetryStore — aggregation & rollups", () => {
  it("folds request tokens, cost, and latency into the daily rollup", () => {
    const { store } = freshStore();
    const task = store.startTask("s1", "test/model:free", "do thing");
    recordOne(store, task, { inputTokens: 200, outputTokens: 80, cost: 0.02, latencyMs: 1200 });
    recordOne(store, task, { inputTokens: 300, outputTokens: 120, cost: 0.03, latencyMs: 800, iteration: 1 });
    store.finishTask(task, "success");

    const summary = store.getSummary();
    const t = summary.today;
    assert.equal(t.requests, 2);
    assert.equal(t.inputTokens, 500);
    assert.equal(t.outputTokens, 200);
    assert.equal(t.cost, 0.05);
    assert.equal(t.tasks, 1);
    assert.equal(t.successfulTasks, 1);
  });

  it("counts failed requests separately", () => {
    const { store } = freshStore();
    const task = store.startTask("s1", "test/model:free", "do thing");
    recordOne(store, task, { success: true });
    recordOne(store, task, { success: false, iteration: 1 });
    store.finishTask(task, "error");

    const t = store.getSummary().today;
    assert.equal(t.requests, 2);
    assert.equal(t.failedRequests, 1);
    assert.equal(t.erroredTasks, 1);
  });

  it("aggregates per-model stats", () => {
    const { store } = freshStore();
    const taskA = store.startTask("s1", "alpha/model:free", "a");
    recordOne(store, taskA, { model: "alpha/model:free", inputTokens: 100 });
    store.finishTask(taskA, "success");

    const taskB = store.startTask("s1", "beta/model:free", "b");
    recordOne(store, taskB, { model: "beta/model:free", inputTokens: 400, success: false });
    store.finishTask(taskB, "error");

    const perModel = store.getSummary().today.perModel;
    assert.equal(perModel["alpha/model:free"].requests, 1);
    assert.equal(perModel["alpha/model:free"].taskSuccesses, 1);
    assert.equal(perModel["beta/model:free"].errors, 1);
    assert.equal(perModel["beta/model:free"].tasks, 1);
  });

  it("classifies tool calls into read/modify/command/test buckets", () => {
    const { store } = freshStore();
    const task = store.startTask("s1", "test/model:free", "do thing");
    store.recordToolCall(task, "read_file", { cached: false, success: true });
    store.recordToolCall(task, "list_files", { cached: false, success: true });
    store.recordToolCall(task, "apply_patch", { cached: false, success: true });
    store.recordToolCall(task, "execute_command", { cached: false, success: true });
    store.recordToolCall(task, "run_tests", { cached: false, success: true });
    store.recordToolCall(task, "read_file", { cached: true, success: true });
    store.finishTask(task, "success");

    const t = store.getSummary().today;
    assert.equal(t.toolCalls, 5);
    assert.equal(t.cacheHits, 1);
    assert.equal(t.filesRead, 2);
    assert.equal(t.filesModified, 1);
  });
});

describe("TelemetryStore — summary metrics", () => {
  it("computes successful tasks per 1,000 requests", () => {
    const { store } = freshStore();
    // 3 successful tasks, 10 requests → 300 per 1,000
    for (let i = 0; i < 3; i++) {
      const task = store.startTask("s1", "m:free", `task ${i}`);
      for (let r = 0; r < 3; r++) recordOne(store, task);
      // one extra request on the last task to reach 10 total
      if (i === 2) recordOne(store, task, { iteration: 1 });
      store.finishTask(task, "success");
    }
    const summary = store.getSummary();
    assert.equal(summary.today.requests, 10);
    assert.equal(summary.today.successfulTasks, 3);
    assert.equal(summary.successfulTasksPer1000Requests, 300);
  });

  it("computes context-pruning savings and cache hit rate", () => {
    const { store } = freshStore();
    const task = store.startTask("s1", "m:free", "task");
    // raw 2000, actual 1000 → 50% savings
    recordOne(store, task, { rawContextTokens: 2000, contextTokens: 1000 });
    store.recordToolCall(task, "read_file", { cached: false, success: true });
    store.recordToolCall(task, "read_file", { cached: true, success: true });
    store.recordToolCall(task, "read_file", { cached: true, success: true });
    store.finishTask(task, "success");

    const summary = store.getSummary();
    assert.equal(summary.contextSavingsPct, 0.5);
    // 2 cache hits / 3 total ops = 0.6667
    assert.ok(Math.abs(summary.cacheHitRate - 2 / 3) < 1e-9);
  });

  it("returns a 14-day trend with today last", () => {
    const { store } = freshStore();
    const summary = store.getSummary();
    assert.equal(summary.trend.length, 14);
    // today is the last entry
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(summary.trend[13].day, today);
  });

  it("caps recent tasks and recent requests", () => {
    const { store } = freshStore();
    for (let i = 0; i < 5; i++) {
      const task = store.startTask("s1", "m:free", `task ${i}`);
      recordOne(store, task);
      store.finishTask(task, "success");
    }
    const summary = store.getSummary();
    assert.equal(summary.recentTasks.length, 5);
    // most-recent first
    assert.equal(summary.recentTasks[0].prompt, "task 4");
  });

  it("configure() updates tunable params and getConfig() reflects them", () => {
    const { store } = freshStore();
    const defaults = store.getConfig();
    assert.equal(defaults.maxRecentTasks, 500);
    assert.equal(defaults.trendDays, 14);

    store.configure({ maxRecentTasks: 100, trendDays: 7, writeDebounceMs: 500 });
    const cfg = store.getConfig();
    assert.equal(cfg.maxRecentTasks, 100);
    assert.equal(cfg.trendDays, 7);
    assert.equal(cfg.writeDebounceMs, 500);
    // untouched param stays at default
    assert.equal(cfg.maxRecentRequests, 2000);
  });

  it("configure() trims in-memory buffers when caps are lowered", () => {
    const { store } = freshStore();
    for (let i = 0; i < 10; i++) {
      const task = store.startTask("s1", "m:free", `task ${i}`);
      store.finishTask(task, "success");
    }
    assert.equal(store.getSummary().recentTasks.length, 10);
    store.configure({ maxRecentTasks: 3 });
    assert.equal(store.getSummary().recentTasks.length, 3);
  });

  it("configure() trendDays changes the summary trend length", () => {
    const { store } = freshStore();
    store.configure({ trendDays: 7 });
    const summary = store.getSummary();
    assert.equal(summary.trend.length, 7);
  });

  it("configure() ignores invalid (non-positive) values", () => {
    const { store } = freshStore();
    store.configure({ maxRecentTasks: -5, writeDebounceMs: -1, trendDays: 0 });
    const cfg = store.getConfig();
    assert.equal(cfg.maxRecentTasks, 500);
    assert.equal(cfg.writeDebounceMs, 1500);
    assert.equal(cfg.trendDays, 14);
  });
});

describe("TelemetryStore — persistence", () => {
  it("round-trips data through a debounced flush + reload", async () => {
    const env = freshStore() as any;
    const store: TelemetryStore = env.store;
    const file: string = env.file;

    const task = store.startTask("s1", "persist/model:free", "persist me");
    recordOne(store, task, { inputTokens: 42, cost: 0.007 });
    store.finishTask(task, "success");

    await store.flush();

    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.recentTasks.length, 1);
    assert.equal(parsed.recentTasks[0].inputTokens, 42);

    // Reload into a new store pointed at the same file.
    const reloaded = new TelemetryStore();
    reloaded._configure({ filePath: file });
    await reloaded.load();
    const summary = reloaded.getSummary();
    assert.equal(summary.today.requests, 1);
    assert.equal(summary.today.inputTokens, 42);
    assert.equal(summary.recentTasks[0].prompt, "persist me");
  });

  it("survives a missing/corrupt file by starting fresh", async () => {
    const env = freshStore() as any;
    const store: TelemetryStore = env.store;
    const file: string = env.file;
    await fs.writeFile(file, "{not valid json");
    await store.load();
    const summary = store.getSummary();
    assert.equal(summary.today.tasks, 0);
  });
});

describe("TelemetryStore — task lifecycle", () => {
  it("finishTask records duration from the injected clock", () => {
    const env = freshStore() as any;
    const store: TelemetryStore = env.store;
    const task = store.startTask("s1", "m:free", "timed");
    env.tick(3500);
    const rec = store.finishTask(task, "success");
    assert.equal(rec.durationMs, 3500);
    assert.equal(rec.status, "success");
  });

  it("cancelled tasks are counted separately from errors", () => {
    const { store } = freshStore();
    const task = store.startTask("s1", "m:free", "cancel me");
    recordOne(store, task);
    store.finishTask(task, "cancelled");
    const t = store.getSummary().today;
    assert.equal(t.cancelledTasks, 1);
    assert.equal(t.erroredTasks, 0);
    assert.equal(t.successfulTasks, 0);
  });
});

describe("TelemetryStore — Phase 2 reduction fields", () => {
  it("rolls up truncation, compaction, redundant calls, and snapshot", () => {
    const { store } = freshStore();
    const task = store.startTask("s1", "m:free", "reduce me");
    task.truncationTokensSaved = 5000;
    task.compactionTokensSaved = 3000;
    task.redundantCallsAvoided = 2;
    task.snapshotInjected = true;
    recordOne(store, task);
    store.finishTask(task, "success");

    const summary = store.getSummary();
    assert.equal(summary.today.truncationTokensSaved, 5000);
    assert.equal(summary.today.compactionTokensSaved, 3000);
    assert.equal(summary.today.redundantCallsAvoided, 2);
    assert.equal(summary.today.snapshotTasks, 1);

    // Reduction block in summary.
    assert.equal(summary.reduction.truncationTokensSaved, 5000);
    assert.equal(summary.reduction.compactionTokensSaved, 3000);
    assert.equal(summary.reduction.redundantCallsAvoided, 2);
    assert.equal(summary.reduction.snapshotTasks, 1);
  });

  it("defaults to zero when no reduction happened", () => {
    const { store } = freshStore();
    const task = store.startTask("s1", "m:free", "plain task");
    recordOne(store, task);
    store.finishTask(task, "success");
    const summary = store.getSummary();
    assert.equal(summary.reduction.truncationTokensSaved, 0);
    assert.equal(summary.reduction.compactionTokensSaved, 0);
    assert.equal(summary.reduction.redundantCallsAvoided, 0);
    assert.equal(summary.reduction.snapshotTasks, 0);
  });
});
