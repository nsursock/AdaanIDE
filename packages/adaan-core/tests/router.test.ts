import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { routeModel, DEFAULT_ROUTER_SETTINGS } from "../src/server/router/router.js";
import { classifyTask } from "../src/server/router/classifier.js";
import { ModelRegistry } from "../src/server/registry/store.js";
import type { RegistryEntry } from "../src/server/registry/types.js";

function makeEntry(
  id: string,
  tier: "free" | "mid" | "frontier",
  opts?: { toolsCapable?: boolean; taskSuccessRate?: number; errorRate?: number },
): RegistryEntry {
  return {
    id,
    name: id,
    free: tier === "free",
    pricing: { prompt: "0", completion: "0" },
    contextLength: 4096,
    toolsCapable: opts?.toolsCapable ?? true,
    modalities: [],
    reasoning: false,
    empirical: opts?.taskSuccessRate !== undefined
      ? {
          requests: 10,
          errors: (opts.errorRate ?? 0) * 10,
          errorRate: opts.errorRate ?? 0,
          avgLatencyMs: 1000,
          tasks: 5,
          taskSuccessRate: opts.taskSuccessRate,
          avgInputTokens: 1000,
          lastUsed: "2026-09-01",
        }
      : null,
    tier,
  };
}

// Stub registry that returns fixed entries.
class StubRegistry extends ModelRegistry {
  private entries: RegistryEntry[];

  constructor(entries: RegistryEntry[]) {
    super();
    this.entries = entries;
  }

  override all(): RegistryEntry[] {
    return this.entries;
  }

  override tierOf(id: string): "free" | "mid" | "frontier" {
    return this.entries.find((e) => e.id === id)?.tier ?? "free";
  }

  override byTier(tier: "free" | "mid" | "frontier"): RegistryEntry[] {
    return this.entries.filter((e) => e.tier === tier);
  }
}

describe("router", () => {
  let cls = classifyTask("Fix the bug in the code");

  it("returns null in manual mode", () => {
    const registry = new StubRegistry([makeEntry("a:free", "free")]);
    const result = routeModel(cls, registry, { ...DEFAULT_ROUTER_SETTINGS, mode: "manual" });
    assert.equal(result, null);
  });

  it("returns null when registry is empty", () => {
    const registry = new StubRegistry([]);
    const result = routeModel(cls, registry, { ...DEFAULT_ROUTER_SETTINGS, mode: "auto" });
    assert.equal(result, null);
  });

  it("picks free model at equal confidence", () => {
    const registry = new StubRegistry([
      makeEntry("free-a:free", "free", { taskSuccessRate: 0.8 }),
      makeEntry("paid-b", "frontier", { taskSuccessRate: 0.8 }),
    ]);
    const result = routeModel(cls, registry, { ...DEFAULT_ROUTER_SETTINGS, mode: "auto" });
    assert.ok(result);
    assert.equal(result!.model, "free-a:free");
  });

  it("respects success threshold", () => {
    const registry = new StubRegistry([
      makeEntry("free-a:free", "free", { taskSuccessRate: 0.3 }),
      makeEntry("paid-b", "mid", { taskSuccessRate: 0.8 }),
    ]);
    const result = routeModel(cls, registry, {
      ...DEFAULT_ROUTER_SETTINGS,
      mode: "auto",
      successThreshold: 0.6,
    });
    // Free model is below threshold (0.3 < 0.6), so the confident list
    // only has paid-b (0.8 >= 0.6). The router picks the confident paid model.
    assert.ok(result);
    assert.equal(result!.model, "paid-b");
  });

  it("falls back to free model when no empirical data", () => {
    const registry = new StubRegistry([
      makeEntry("free-a:free", "free"),
      makeEntry("paid-b", "mid"),
    ]);
    const result = routeModel(cls, registry, { ...DEFAULT_ROUTER_SETTINGS, mode: "auto" });
    assert.ok(result);
    assert.equal(result!.model, "free-a:free");
    assert.ok(result!.reason.includes("no empirical data"));
  });

  it("respects allowed tiers", () => {
    const registry = new StubRegistry([
      makeEntry("free-a:free", "free", { taskSuccessRate: 0.8 }),
      makeEntry("paid-b", "mid", { taskSuccessRate: 0.9 }),
    ]);
    const result = routeModel(cls, registry, {
      ...DEFAULT_ROUTER_SETTINGS,
      mode: "auto",
      allowedTiers: ["mid"],
    });
    assert.ok(result);
    assert.equal(result!.model, "paid-b");
  });

  it("filters by tools capability for coding tasks", () => {
    const registry = new StubRegistry([
      makeEntry("no-tools:free", "free", { toolsCapable: false, taskSuccessRate: 0.9 }),
      makeEntry("with-tools:free", "free", { toolsCapable: true, taskSuccessRate: 0.7 }),
    ]);
    const codingCls = classifyTask("Fix the bug and refactor the code");
    const result = routeModel(codingCls, registry, { ...DEFAULT_ROUTER_SETTINGS, mode: "auto" });
    assert.ok(result);
    assert.equal(result!.model, "with-tools:free");
  });

  it("includes classification in result", () => {
    const registry = new StubRegistry([makeEntry("a:free", "free", { taskSuccessRate: 0.8 })]);
    const result = routeModel(cls, registry, { ...DEFAULT_ROUTER_SETTINGS, mode: "auto" });
    assert.ok(result);
    assert.equal(result!.category, cls.category);
    assert.equal(result!.classification, cls);
  });
});
