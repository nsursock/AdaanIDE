import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeEmpirical, assignTiers } from "../src/server/registry/types.js";
import type { DailyRollup } from "../src/server/telemetry/types.js";

function makeBaseEntry(id: string, free: boolean, prompt = "0", completion = "0") {
  return {
    id,
    name: id,
    free,
    pricing: { prompt, completion },
    contextLength: 4096,
    toolsCapable: true,
    modalities: [] as string[],
    reasoning: false,
  };
}

function makeRollup(day: string, perModel: Record<string, any>): DailyRollup {
  return {
    day,
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

describe("registry/types", () => {
  describe("mergeEmpirical", () => {
    it("returns null empirical when no rollup data", () => {
      const entries = [makeBaseEntry("model-a:free", true)];
      const result = mergeEmpirical(entries, {});
      assert.equal(result[0].empirical, null);
    });

    it("merges per-model stats from rollups", () => {
      const entries = [makeBaseEntry("model-a:free", true)];
      const rollups = {
        "2026-09-01": makeRollup("2026-09-01", {
          "model-a:free": {
            model: "model-a:free", requests: 10, errors: 2, inputTokens: 5000,
            outputTokens: 3000, cachedTokens: 0, reasoningTokens: 0, cost: 0,
            totalLatencyMs: 20000, tasks: 3, taskSuccesses: 2,
          },
        }),
      };
      const result = mergeEmpirical(entries, rollups);
      assert.ok(result[0].empirical);
      assert.equal(result[0].empirical!.requests, 10);
      assert.equal(result[0].empirical!.errorRate, 0.2);
      assert.equal(result[0].empirical!.avgLatencyMs, 2000);
      assert.equal(result[0].empirical!.taskSuccessRate, 2 / 3);
      assert.equal(result[0].empirical!.avgInputTokens, 500);
      assert.equal(result[0].empirical!.lastUsed, "2026-09-01");
    });

    it("aggregates across multiple days", () => {
      const entries = [makeBaseEntry("model-a:free", true)];
      const rollups = {
        "2026-09-01": makeRollup("2026-09-01", {
          "model-a:free": {
            model: "model-a:free", requests: 5, errors: 1, inputTokens: 1000,
            outputTokens: 500, cachedTokens: 0, reasoningTokens: 0, cost: 0,
            totalLatencyMs: 5000, tasks: 2, taskSuccesses: 1,
          },
        }),
        "2026-09-02": makeRollup("2026-09-02", {
          "model-a:free": {
            model: "model-a:free", requests: 5, errors: 0, inputTokens: 2000,
            outputTokens: 1000, cachedTokens: 0, reasoningTokens: 0, cost: 0,
            totalLatencyMs: 5000, tasks: 1, taskSuccesses: 1,
          },
        }),
      };
      const result = mergeEmpirical(entries, rollups);
      assert.equal(result[0].empirical!.requests, 10);
      assert.equal(result[0].empirical!.errors, 1);
      assert.equal(result[0].empirical!.tasks, 3);
      assert.equal(result[0].empirical!.taskSuccessRate, 2 / 3);
      assert.equal(result[0].empirical!.lastUsed, "2026-09-02");
    });
  });

  describe("assignTiers", () => {
    it("assigns free tier to free models", () => {
      const entries = mergeEmpirical([makeBaseEntry("a:free", true)], {});
      const tiered = assignTiers(entries);
      assert.equal(tiered[0].tier, "free");
    });

    it("splits paid models by price percentile", () => {
      const base = [
        makeBaseEntry("cheap", false, "0.001", "0.002"),
        makeBaseEntry("mid", false, "0.005", "0.01"),
        makeBaseEntry("expensive", false, "0.02", "0.04"),
      ];
      const entries = mergeEmpirical(base, {});
      const tiered = assignTiers(entries);
      const cheap = tiered.find((e) => e.id === "cheap")!;
      const expensive = tiered.find((e) => e.id === "expensive")!;
      assert.equal(cheap.tier, "mid"); // cheapest paid → mid
      assert.equal(expensive.tier, "frontier"); // most expensive → frontier
    });

    it("handles all-free models", () => {
      const base = [makeBaseEntry("a:free", true), makeBaseEntry("b:free", true)];
      const entries = mergeEmpirical(base, {});
      const tiered = assignTiers(entries);
      assert.equal(tiered.every((e) => e.tier === "free"), true);
    });
  });
});
