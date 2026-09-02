import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TaskRecord, RequestRecord, Regime } from "../src/server/telemetry/types.js";
import {
  computeRegimeMetrics,
  computeModelMatrix,
  computeModelTable,
} from "../src/server/telemetry/metrics.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let idCounter = 0;
function uid(prefix: string): string {
  return `${prefix}-${++idCounter}`;
}

function makeTask(opts: Partial<TaskRecord> = {}): TaskRecord {
  const taskId = opts.taskId ?? uid("t");
  return {
    taskId,
    sessionId: opts.sessionId ?? "s1",
    model: opts.model ?? "test/model:free",
    requestedModel: opts.requestedModel ?? opts.model ?? "test/model:free",
    prompt: opts.prompt ?? "do something",
    timestamp: opts.timestamp ?? 1000,
    day: opts.day ?? "2026-09-01",
    durationMs: opts.durationMs ?? 5000,
    status: opts.status ?? "success",
    requestCount: opts.requestCount ?? 3,
    toolCalls: opts.toolCalls ?? 2,
    cacheHits: opts.cacheHits ?? 0,
    filesRead: opts.filesRead ?? 1,
    filesModified: opts.filesModified ?? 1,
    commandsRun: opts.commandsRun ?? 0,
    testsRun: opts.testsRun ?? 0,
    inputTokens: opts.inputTokens ?? 1000,
    outputTokens: opts.outputTokens ?? 500,
    cachedTokens: opts.cachedTokens ?? 0,
    reasoningTokens: opts.reasoningTokens ?? 0,
    cost: opts.cost ?? 0,
    rawContextTokens: opts.rawContextTokens ?? 2000,
    actualContextTokens: opts.actualContextTokens ?? 1500,
    prunedMessages: opts.prunedMessages ?? 0,
    truncationTokensSaved: opts.truncationTokensSaved ?? 0,
    compactionTokensSaved: opts.compactionTokensSaved ?? 0,
    redundantCallsAvoided: opts.redundantCallsAvoided ?? 0,
    snapshotInjected: opts.snapshotInjected ?? false,
    routedBy: opts.routedBy ?? "manual",
    category: opts.category ?? null,
    escalations: opts.escalations ?? 0,
    retries: opts.retries ?? 0,
    fallbacks: opts.fallbacks ?? 0,
    outcome: opts.outcome ?? "silent",
    regime: opts.regime ?? "free",
    provider: opts.provider ?? "openrouter",
  };
}

function makeRequest(task: TaskRecord, opts: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requestId: uid("r"),
    sessionId: task.sessionId,
    taskId: task.taskId,
    model: opts.model ?? task.model,
    provider: opts.provider ?? "openrouter",
    timestamp: opts.timestamp ?? 1000,
    day: opts.day ?? task.day,
    inputTokens: opts.inputTokens ?? 300,
    outputTokens: opts.outputTokens ?? 150,
    cachedTokens: opts.cachedTokens ?? 0,
    reasoningTokens: opts.reasoningTokens ?? 0,
    latencyMs: opts.latencyMs ?? 500,
    cost: opts.cost ?? 0,
    requestType: opts.requestType ?? "planning",
    contextTokens: opts.contextTokens ?? 500,
    toolCallsBeforeRequest: opts.toolCallsBeforeRequest ?? 0,
    iteration: opts.iteration ?? 0,
    success: opts.success ?? true,
  };
}

// Build a request set matching a task's requestCount.
function requestsForTask(task: TaskRecord, overrides: Partial<RequestRecord>[] = []): RequestRecord[] {
  const reqs: RequestRecord[] = [];
  for (let i = 0; i < task.requestCount; i++) {
    reqs.push(makeRequest(task, { iteration: i, ...overrides[i] }));
  }
  return reqs;
}

// ---------------------------------------------------------------------------
// computeRegimeMetrics
// ---------------------------------------------------------------------------

describe("computeRegimeMetrics — basic aggregation", () => {
  it("returns zeros for an empty regime", () => {
    const m = computeRegimeMetrics([], [], "free");
    assert.equal(m.tasks, 0);
    assert.equal(m.successRate, 0);
    assert.equal(m.tasksPer1000Requests, 0);
    assert.equal(m.requestsPerTask, 0);
    assert.equal(m.quotaConsumed, 0);
    assert.equal(m.quotaRemaining, 1000);
    assert.equal(m.quotaUsedPct, 0);
  });

  it("filters to only the requested regime", () => {
    const freeTask = makeTask({ regime: "free", requestCount: 2 });
    const paidTask = makeTask({ regime: "paid", requestCount: 5 });
    const reqs = [...requestsForTask(freeTask), ...requestsForTask(paidTask)];
    const m = computeRegimeMetrics([freeTask, paidTask], reqs, "free");
    assert.equal(m.tasks, 1);
    assert.equal(m.requests, 2);
  });

  it("computes tasksPer1000Requests correctly", () => {
    // 5 successful tasks, 25 requests → 200 / 1k
    const tasks: TaskRecord[] = [];
    for (let i = 0; i < 5; i++) {
      tasks.push(makeTask({ taskId: `t${i}`, regime: "free", status: "success", requestCount: 5 }));
    }
    const reqs = tasks.flatMap((t: TaskRecord) => requestsForTask(t));
    const m = computeRegimeMetrics(tasks, reqs, "free");
    assert.equal(m.tasks, 5);
    assert.equal(m.successfulTasks, 5);
    assert.equal(m.requests, 25);
    assert.equal(m.tasksPer1000Requests, 200);
    assert.equal(m.tasksPer100Requests, 20);
  });

  it("counts only successful tasks in tasksPer1000Requests", () => {
    const tasks = [
      makeTask({ taskId: "ok1", regime: "free", status: "success", requestCount: 2 }),
      makeTask({ taskId: "ok2", regime: "free", status: "success", requestCount: 3 }),
      makeTask({ taskId: "err1", regime: "free", status: "error", requestCount: 5 }),
    ];
    const reqs = tasks.flatMap((t: TaskRecord) => requestsForTask(t));
    const m = computeRegimeMetrics(tasks, reqs, "free");
    // 2 successful / 10 requests * 1000 = 200
    assert.equal(m.successfulTasks, 2);
    assert.equal(m.requests, 10);
    assert.equal(m.tasksPer1000Requests, 200);
    assert.equal(m.successRate, 2 / 3);
  });
});

describe("computeRegimeMetrics — latency percentiles", () => {
  it("computes p50 and p95 via nearest-rank", () => {
    // 10 tasks with durations 1000..10000
    const tasks: TaskRecord[] = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(makeTask({ taskId: `t${i}`, regime: "free", durationMs: (i + 1) * 1000, requestCount: 1 }));
    }
    const reqs = tasks.flatMap((t) =>
      requestsForTask(t, [{ latencyMs: (t.durationMs) / 2 }]),
    );
    const m = computeRegimeMetrics(tasks, reqs, "free");
    // p50 nearest-rank: ceil(0.5 * 10) = 5th → index 4 → 5000
    assert.equal(m.p50DurationMs, 5000);
    // p95: ceil(0.95 * 10) = 10th → index 9 → 10000
    assert.equal(m.p95DurationMs, 10000);
    // Latencies are half the durations: 500..5000
    assert.equal(m.p50LatencyMs, 2500);
    assert.equal(m.p95LatencyMs, 5000);
  });

  it("handles a single task", () => {
    const task = makeTask({ regime: "free", durationMs: 3000, requestCount: 1 });
    const reqs = requestsForTask(task, [{ latencyMs: 800 }]);
    const m = computeRegimeMetrics([task], reqs, "free");
    assert.equal(m.p50DurationMs, 3000);
    assert.equal(m.p95DurationMs, 3000);
    assert.equal(m.p50LatencyMs, 800);
    assert.equal(m.p95LatencyMs, 800);
  });
});

describe("computeRegimeMetrics — quota (free regime)", () => {
  it("computes quota consumed and remaining", () => {
    const tasks = [
      makeTask({ taskId: "t1", regime: "free", requestCount: 100 }),
      makeTask({ taskId: "t2", regime: "free", requestCount: 50 }),
    ];
    const reqs = tasks.flatMap((t: TaskRecord) => requestsForTask(t));
    const m = computeRegimeMetrics(tasks, reqs, "free", { quotaDailyLimit: 1000 });
    assert.equal(m.quotaConsumed, 150);
    assert.equal(m.quotaRemaining, 850);
    assert.equal(m.quotaUsedPct, 0.15);
  });

  it("clamps quota remaining at 0 when over limit", () => {
    const task = makeTask({ regime: "free", requestCount: 1200 });
    const reqs = requestsForTask(task);
    const m = computeRegimeMetrics([task], reqs, "free", { quotaDailyLimit: 1000 });
    assert.equal(m.quotaConsumed, 1200);
    assert.equal(m.quotaRemaining, 0);
    assert.equal(m.quotaUsedPct, 1);
  });

  it("leaves quota fields at 0 for paid and local regimes", () => {
    const task = makeTask({ regime: "paid", requestCount: 10 });
    const reqs = requestsForTask(task);
    const m = computeRegimeMetrics([task], reqs, "paid");
    assert.equal(m.quotaConsumed, 0);
    assert.equal(m.quotaRemaining, 0);
    assert.equal(m.quotaUsedPct, 0);
  });

  it("uses quotaConsumedToday override instead of counting requests", () => {
    // Simulates production: recentRequests is capped at 2000 and would
    // undercount. The API endpoint passes the uncapped rollup value.
    const task = makeTask({ regime: "free", requestCount: 3 });
    const reqs = requestsForTask(task); // only 3 in the array
    const m = computeRegimeMetrics([task], reqs, "free", {
      quotaDailyLimit: 1000,
      quotaConsumedToday: 850, // from rollups[today].requests
    });
    assert.equal(m.quotaConsumed, 850);
    assert.equal(m.quotaRemaining, 150);
    assert.equal(m.quotaUsedPct, 0.85);
  });

  it("quotaConsumedToday override ignored for non-free regimes", () => {
    const task = makeTask({ regime: "paid", requestCount: 5 });
    const reqs = requestsForTask(task);
    const m = computeRegimeMetrics([task], reqs, "paid", { quotaConsumedToday: 999 });
    assert.equal(m.quotaConsumed, 0);
  });
});

describe("computeRegimeMetrics — local regime specifics", () => {
  it("computes tasksPerHour and tokensPerSecond", () => {
    // 2 successful tasks, total duration 2 hours = 7200000ms
    // 10 requests, each 1000ms latency, 200 output tokens each
    const tasks = [
      makeTask({ taskId: "t1", regime: "local", status: "success", durationMs: 3_600_000, requestCount: 5 }),
      makeTask({ taskId: "t2", regime: "local", status: "success", durationMs: 3_600_000, requestCount: 5 }),
    ];
    // Override ALL requests (requestsForTask applies overrides[i] per index,
    // so we need one entry per request).
    const overrides = Array.from({ length: 5 }, () => ({ latencyMs: 1000, outputTokens: 200 }));
    const reqs = tasks.flatMap((t) => requestsForTask(t, overrides));
    const m = computeRegimeMetrics(tasks, reqs, "local");
    // 2 successes / 2 hours = 1 task/hour
    assert.equal(m.tasksPerHour, 1);
    // 10 reqs * 200 tokens / 10 reqs * 1000ms * 1000 = 200 tok/s
    assert.equal(m.tokensPerSecond, 200);
    // 7200000ms / 2 successes = 3600000ms
    assert.equal(m.timePerSuccessfulTaskMs, 3_600_000);
  });

  it("returns 0 for local-specific fields when no successful tasks", () => {
    const task = makeTask({ regime: "local", status: "error", durationMs: 1000, requestCount: 1 });
    const reqs = requestsForTask(task);
    const m = computeRegimeMetrics([task], reqs, "local");
    assert.equal(m.tasksPerHour, 0);
    assert.equal(m.timePerSuccessfulTaskMs, 0);
  });
});

describe("computeRegimeMetrics — retry/fallback/escalation rates", () => {
  it("sums and rates correctly", () => {
    const tasks = [
      makeTask({ taskId: "t1", regime: "free", escalations: 1, retries: 2, fallbacks: 0, requestCount: 3 }),
      makeTask({ taskId: "t2", regime: "free", escalations: 0, retries: 0, fallbacks: 1, requestCount: 2 }),
    ];
    const reqs = tasks.flatMap((t: TaskRecord) => requestsForTask(t));
    const m = computeRegimeMetrics(tasks, reqs, "free");
    assert.equal(m.escalationRate, 0.5);
    assert.equal(m.retryRate, 1);
    assert.equal(m.fallbackRate, 0.5);
  });
});

// ---------------------------------------------------------------------------
// computeModelMatrix
// ---------------------------------------------------------------------------

describe("computeModelMatrix — N is first-class", () => {
  it("every cell has n, never undefined", () => {
    const tasks = [
      makeTask({ model: "a/free:free", category: "fix", status: "success" }),
      makeTask({ model: "a/free:free", category: "fix", status: "error" }),
      makeTask({ model: "b/free:free", category: "fix", status: "success" }),
    ];
    const matrix = computeModelMatrix(tasks);
    for (const cell of matrix.cells) {
      assert.equal(typeof cell.n, "number");
      assert.ok(cell.n >= 0);
    }
  });

  it("groups by model × category and counts successes", () => {
    const tasks = [
      makeTask({ model: "m1:free", category: "fix", status: "success" }),
      makeTask({ model: "m1:free", category: "fix", status: "success" }),
      makeTask({ model: "m1:free", category: "fix", status: "error" }),
      makeTask({ model: "m1:free", category: "test", status: "success" }),
      makeTask({ model: "m2:free", category: "fix", status: "error" }),
    ];
    const matrix = computeModelMatrix(tasks);
    const fixM1 = matrix.cells.find((c) => c.model === "m1:free" && c.category === "fix")!;
    assert.equal(fixM1.n, 3);
    assert.equal(fixM1.successes, 2);
    assert.equal(fixM1.rate, 2 / 3);

    const testM1 = matrix.cells.find((c) => c.model === "m1:free" && c.category === "test")!;
    assert.equal(testM1.n, 1);
    assert.equal(testM1.successes, 1);
    assert.equal(testM1.rate, 1);

    const fixM2 = matrix.cells.find((c) => c.model === "m2:free" && c.category === "fix")!;
    assert.equal(fixM2.n, 1);
    assert.equal(fixM2.successes, 0);
    assert.equal(fixM2.rate, 0);
  });

  it("flags lowConfidence when n < 3", () => {
    const tasks = [
      makeTask({ model: "m1:free", category: "fix", status: "success" }),
      makeTask({ model: "m1:free", category: "fix", status: "success" }),
      makeTask({ model: "m1:free", category: "fix", status: "success" }),
      makeTask({ model: "m2:free", category: "fix", status: "success" }),
    ];
    const matrix = computeModelMatrix(tasks);
    const m1 = matrix.cells.find((c) => c.model === "m1:free")!;
    const m2 = matrix.cells.find((c) => c.model === "m2:free")!;
    assert.equal(m1.lowConfidence, false);
    assert.equal(m2.lowConfidence, true);
  });

  it("assigns uncategorized tasks to 'uncategorized'", () => {
    const task = makeTask({ model: "m1:free", category: null });
    const matrix = computeModelMatrix([task]);
    assert.ok(matrix.categories.includes("uncategorized"));
    assert.equal(matrix.cells[0].category, "uncategorized");
  });

  it("sorts models by descending task count", () => {
    const tasks = [
      makeTask({ model: "rare:free", category: "fix" }),
      makeTask({ model: "common:free", category: "fix" }),
      makeTask({ model: "common:free", category: "fix" }),
      makeTask({ model: "common:free", category: "test" }),
    ];
    const matrix = computeModelMatrix(tasks);
    assert.equal(matrix.models[0], "common:free");
    assert.equal(matrix.models[1], "rare:free");
  });

  it("computes avgReqs per cell", () => {
    const tasks = [
      makeTask({ model: "m1:free", category: "fix", requestCount: 4 }),
      makeTask({ model: "m1:free", category: "fix", requestCount: 6 }),
    ];
    const matrix = computeModelMatrix(tasks);
    const cell = matrix.cells[0];
    assert.equal(cell.avgReqs, 5);
  });

  it("handles empty input", () => {
    const matrix = computeModelMatrix([]);
    assert.equal(matrix.cells.length, 0);
    assert.equal(matrix.categories.length, 0);
    assert.equal(matrix.models.length, 0);
  });
});

// ---------------------------------------------------------------------------
// computeModelTable
// ---------------------------------------------------------------------------

describe("computeModelTable — global per-model rollup", () => {
  it("produces one row per model sorted by task count", () => {
    const tasks = [
      makeTask({ model: "a:free", status: "success", requestCount: 2 }),
      makeTask({ model: "a:free", status: "error", requestCount: 3 }),
      makeTask({ model: "b:free", status: "success", requestCount: 1 }),
    ];
    const rows = computeModelTable(tasks);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].model, "a:free");
    assert.equal(rows[0].n, 2);
    assert.equal(rows[1].model, "b:free");
    assert.equal(rows[1].n, 1);
  });

  it("computes successRate, requestsPerTask, tokensPerTask", () => {
    const tasks = [
      makeTask({ model: "m:free", status: "success", requestCount: 4, inputTokens: 1000, outputTokens: 500 }),
      makeTask({ model: "m:free", status: "error", requestCount: 6, inputTokens: 2000, outputTokens: 1000 }),
    ];
    const rows = computeModelTable(tasks);
    const row = rows[0];
    assert.equal(row.n, 2);
    assert.equal(row.successes, 1);
    assert.equal(row.successRate, 0.5);
    assert.equal(row.requests, 10);
    assert.equal(row.requestsPerTask, 5);
    assert.equal(row.tokens, 4500);
    assert.equal(row.tokensPerTask, 2250);
  });

  it("flags lowConfidence when n < 3", () => {
    const rows = computeModelTable([
      makeTask({ model: "rare:free" }),
      makeTask({ model: "common:free" }),
      makeTask({ model: "common:free" }),
      makeTask({ model: "common:free" }),
    ]);
    const rare = rows.find((r) => r.model === "rare:free")!;
    const common = rows.find((r) => r.model === "common:free")!;
    assert.equal(rare.lowConfidence, true);
    assert.equal(common.lowConfidence, false);
  });

  it("sums escalations, retries, fallbacks", () => {
    const rows = computeModelTable([
      makeTask({ model: "m:free", escalations: 1, retries: 2, fallbacks: 0 }),
      makeTask({ model: "m:free", escalations: 0, retries: 1, fallbacks: 3 }),
    ]);
    assert.equal(rows[0].escalations, 1);
    assert.equal(rows[0].retries, 3);
    assert.equal(rows[0].fallbacks, 3);
  });

  it("handles empty input", () => {
    const rows = computeModelTable([]);
    assert.equal(rows.length, 0);
  });
});
