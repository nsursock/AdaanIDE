import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCapabilityMatrix, type BenchmarkResult } from "../src/server/benchmark/capability.js";
import type { DailyRollup } from "../src/server/telemetry/types.js";

function makeRollup(perModel: Record<string, any>): DailyRollup {
  return {
    day: "2026-09-01",
    tasks: 0, successfulTasks: 0, erroredTasks: 0, cancelledTasks: 0,
    requests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0,
    cachedTokens: 0, reasoningTokens: 0, cost: 0,
    toolCalls: 0, filesRead: 0, filesModified: 0, cacheHits: 0,
    rawContextTokens: 0, actualContextTokens: 0, prunedMessages: 0,
    truncationTokensSaved: 0, compactionTokensSaved: 0,
    redundantCallsAvoided: 0, snapshotTasks: 0,
    autoRoutedTasks: 0, escalations: 0, escalationSuccesses: 0,
    totalTaskDurationMs: 0,
    perModel,
  };
}

describe("capability matrix", () => {
  it("builds empty matrix with no data", () => {
    const matrix = buildCapabilityMatrix([], {});
    assert.ok(matrix.fix);
    assert.ok(matrix.test);
    assert.ok(matrix.refactor);
    assert.equal(Object.keys(matrix.fix).length, 0);
  });

  it("fills from benchmark results", () => {
    const results: BenchmarkResult[] = [
      {
        taskId: "simple-edit", model: "a:free", day: "2026-09-01",
        success: true, requests: 3, retries: 0, inputTokens: 1000,
        outputTokens: 500, cost: 0, latencyMs: 5000, verifyDetail: "ok",
      },
      {
        taskId: "simple-edit", model: "a:free", day: "2026-09-01",
        success: false, requests: 4, retries: 1, inputTokens: 1200,
        outputTokens: 600, cost: 0, latencyMs: 6000, verifyDetail: "fail",
      },
    ];
    const matrix = buildCapabilityMatrix(results, {});
    // "simple-edit" is the taskId but not a valid TaskCategory — it should
    // be skipped. Let's test with a valid category.
    assert.equal(Object.keys(matrix.fix).length, 0);
  });

  it("fills from benchmark results with valid category", () => {
    const results: BenchmarkResult[] = [
      {
        taskId: "fix", model: "a:free", day: "2026-09-01",
        success: true, requests: 3, retries: 0, inputTokens: 1000,
        outputTokens: 500, cost: 0, latencyMs: 5000, verifyDetail: "ok",
      },
      {
        taskId: "fix", model: "a:free", day: "2026-09-01",
        success: false, requests: 4, retries: 1, inputTokens: 1200,
        outputTokens: 600, cost: 0, latencyMs: 6000, verifyDetail: "fail",
      },
    ];
    const matrix = buildCapabilityMatrix(results, {});
    assert.equal(matrix.fix["a:free"].successRate, 0.5);
    assert.equal(matrix.fix["a:free"].samples, 2);
    assert.equal(matrix.fix["a:free"].source, "benchmark");
  });

  it("fills gaps from organic telemetry when no benchmark data", () => {
    const rollups = {
      "2026-09-01": makeRollup({
        "a:free": {
          model: "a:free", requests: 10, errors: 2, inputTokens: 5000,
          outputTokens: 3000, cachedTokens: 0, reasoningTokens: 0, cost: 0,
          totalLatencyMs: 20000, tasks: 3, taskSuccesses: 2,
        },
      }),
    };
    const matrix = buildCapabilityMatrix([], rollups);
    // Without taskRecords, uses aggregate per-model as rough proxy.
    assert.ok(matrix.fix["a:free"]);
    assert.equal(matrix.fix["a:free"].source, "organic");
    assert.equal(matrix.fix["a:free"].successRate, 2 / 3);
  });

  it("fills from organic task records with categories", () => {
    const taskRecords = [
      { prompt: "fix the bug", model: "a:free", status: "success", category: "fix" },
      { prompt: "fix the bug", model: "a:free", status: "error", category: "fix" },
      { prompt: "write tests", model: "b:free", status: "success", category: "test" },
    ];
    const matrix = buildCapabilityMatrix([], {}, taskRecords);
    assert.equal(matrix.fix["a:free"].successRate, 0.5);
    assert.equal(matrix.fix["a:free"].samples, 2);
    assert.equal(matrix.test["b:free"].successRate, 1);
    assert.equal(matrix.test["b:free"].samples, 1);
  });

  it("benchmark data takes priority over organic", () => {
    const results: BenchmarkResult[] = [
      {
        taskId: "fix", model: "a:free", day: "2026-09-01",
        success: true, requests: 1, retries: 0, inputTokens: 100,
        outputTokens: 50, cost: 0, latencyMs: 1000, verifyDetail: "ok",
      },
    ];
    const taskRecords = [
      { prompt: "fix", model: "a:free", status: "error", category: "fix" },
    ];
    const matrix = buildCapabilityMatrix(results, {}, taskRecords);
    // Benchmark data should be used, not organic.
    assert.equal(matrix.fix["a:free"].source, "benchmark");
    assert.equal(matrix.fix["a:free"].successRate, 1);
    assert.equal(matrix.fix["a:free"].samples, 1);
  });
});
