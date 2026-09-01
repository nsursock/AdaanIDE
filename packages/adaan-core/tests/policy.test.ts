import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  thompsonSelect,
  seededRng,
  routeWithLearning,
  detectDrift,
  buildReport,
} from "../src/server/learn/policy.js";
import { LearnedModelStats } from "../src/server/learn/model-stats.js";
import { ModelRegistry } from "../src/server/registry/store.js";
import { classifyTask } from "../src/server/router/classifier.js";
import { DEFAULT_ROUTER_SETTINGS } from "../src/server/router/router.js";
import type { RegistryEntry } from "../src/server/registry/types.js";
import type { DailyRollup } from "../src/server/telemetry/types.js";

function makeEntry(
  id: string,
  tier: "free" | "mid" | "frontier",
  toolsCapable = true,
): RegistryEntry {
  return {
    id, name: id, free: tier === "free",
    pricing: { prompt: "0", completion: "0" },
    contextLength: 4096, toolsCapable, modalities: [], reasoning: false,
    empirical: null, tier,
  };
}

class StubRegistry extends ModelRegistry {
  private entries: RegistryEntry[];
  constructor(entries: RegistryEntry[]) { super(); this.entries = entries; }
  override all(): RegistryEntry[] { return this.entries; }
  override tierOf(id: string) { return this.entries.find((e) => e.id === id)?.tier ?? "free"; }
  override byTier(t: "free" | "mid" | "frontier") { return this.entries.filter((e) => e.tier === t); }
}

function makeRollup(day: string, perModel: Record<string, any>): DailyRollup {
  return {
    day, tasks: 0, successfulTasks: 0, erroredTasks: 0, cancelledTasks: 0,
    requests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0,
    cachedTokens: 0, reasoningTokens: 0, cost: 0,
    toolCalls: 0, filesRead: 0, filesModified: 0, cacheHits: 0,
    rawContextTokens: 0, actualContextTokens: 0, prunedMessages: 0,
    truncationTokensSaved: 0, compactionTokensSaved: 0,
    redundantCallsAvoided: 0, snapshotTasks: 0,
    autoRoutedTasks: 0, escalations: 0, escalationSuccesses: 0,
    totalTaskDurationMs: 0, perModel,
  };
}

describe("policy", () => {
  describe("seededRng", () => {
    it("is deterministic with same seed", () => {
      const rng1 = seededRng(42);
      const rng2 = seededRng(42);
      assert.equal(rng1(), rng2());
      assert.equal(rng1(), rng2());
    });

    it("produces values in [0, 1)", () => {
      const rng = seededRng(123);
      for (let i = 0; i < 100; i++) {
        const v = rng();
        assert.ok(v >= 0 && v < 1, `value ${v} out of range`);
      }
    });
  });

  describe("thompsonSelect", () => {
    it("returns a model from the registry", () => {
      const registry = new StubRegistry([makeEntry("a:free", "free")]);
      const stats = new LearnedModelStats();
      stats._configure({ now: () => new Date("2026-09-01").getTime() });
      const cls = classifyTask("fix the bug");
      const result = thompsonSelect(cls, registry, { ...DEFAULT_ROUTER_SETTINGS, mode: "auto" }, stats, seededRng(42));
      assert.ok(result);
      assert.equal(result!.model, "a:free");
    });

    it("is deterministic with seeded RNG", () => {
      const registry = new StubRegistry([
        makeEntry("a:free", "free"),
        makeEntry("b:free", "free"),
      ]);
      const stats = new LearnedModelStats();
      stats._configure({ now: () => new Date("2026-09-01").getTime() });
      const cls = classifyTask("fix the bug");
      const r1 = thompsonSelect(cls, registry, { ...DEFAULT_ROUTER_SETTINGS, mode: "auto" }, stats, seededRng(42));
      const r2 = thompsonSelect(cls, registry, { ...DEFAULT_ROUTER_SETTINGS, mode: "auto" }, stats, seededRng(42));
      assert.equal(r1!.model, r2!.model);
    });

    it("returns null when registry is empty", () => {
      const registry = new StubRegistry([]);
      const stats = new LearnedModelStats();
      const cls = classifyTask("fix the bug");
      const result = thompsonSelect(cls, registry, { ...DEFAULT_ROUTER_SETTINGS, mode: "auto" }, stats, seededRng(42));
      assert.equal(result, null);
    });

    it("respects allowed tiers", () => {
      const registry = new StubRegistry([
        makeEntry("free:free", "free"),
        makeEntry("paid", "mid"),
      ]);
      const stats = new LearnedModelStats();
      const cls = classifyTask("fix the bug");
      const result = thompsonSelect(
        cls, registry,
        { ...DEFAULT_ROUTER_SETTINGS, mode: "auto", allowedTiers: ["mid"] },
        stats, seededRng(42),
        { explorationPaidEnabled: true },
      );
      assert.ok(result);
      assert.equal(result!.model, "paid");
    });
  });

  describe("routeWithLearning", () => {
    it("returns null in manual mode", () => {
      const registry = new StubRegistry([makeEntry("a:free", "free")]);
      const stats = new LearnedModelStats();
      const cls = classifyTask("fix the bug");
      const result = routeWithLearning(cls, registry, { ...DEFAULT_ROUTER_SETTINGS, mode: "manual" }, stats, seededRng(42));
      assert.equal(result, null);
    });

    it("returns null when not enough data (falls back to Phase 3)", () => {
      const registry = new StubRegistry([makeEntry("a:free", "free")]);
      const stats = new LearnedModelStats();
      const cls = classifyTask("fix the bug");
      const result = routeWithLearning(cls, registry, { ...DEFAULT_ROUTER_SETTINGS, mode: "auto" }, stats, seededRng(42));
      // With no data, routeWithLearning returns null so caller falls back
      assert.equal(result, null);
    });
  });

  describe("detectDrift", () => {
    it("returns empty array with no data", () => {
      const stats = new LearnedModelStats();
      const rollups: Record<string, DailyRollup> = {};
      const alerts = detectDrift(stats, rollups, "2026-09-01");
      assert.equal(alerts.length, 0);
    });
  });

  describe("buildReport", () => {
    it("builds a report from fixture data", () => {
      const stats = new LearnedModelStats();
      stats._configure({ now: () => new Date("2026-09-01").getTime() });
      const rollups: Record<string, DailyRollup> = {
        "2026-09-01": makeRollup("2026-09-01", {}),
      };
      const tasks = [
        { routedBy: "auto", status: "success", outcome: "silent", prompt: "fix bug", requestCount: 3, category: "fix" },
        { routedBy: "manual", status: "error", outcome: "rejected", prompt: "build app", requestCount: 5, category: "greenfield" },
      ];
      const report = buildReport(rollups, stats, tasks, "2026-09-01");
      assert.equal(report.autoRoutedTasks, 1);
      assert.equal(report.manualTasks, 1);
      assert.equal(report.autoSuccessRate, 1.0);
      assert.equal(report.manualSuccessRate, 0.0);
      assert.equal(report.topCorrections.length, 0);
    });

    it("counts corrections", () => {
      const stats = new LearnedModelStats();
      const tasks = [
        { routedBy: "auto", status: "success", outcome: "corrected", prompt: "fix the bug", requestCount: 3, category: "fix" },
      ];
      const report = buildReport({}, stats, tasks, "2026-09-01");
      assert.equal(report.topCorrections.length, 1);
      assert.equal(report.topCorrections[0], "fix the bug");
    });
  });
});
