import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenRouterProvider, DEFAULT_FREE_POOL } from "../src/server/agent/providers/openrouter.js";

describe("OpenRouterProvider — model rotation", () => {
  it("has a default free pool with at least 4 models", () => {
    assert.ok(DEFAULT_FREE_POOL.length >= 4);
    assert.ok(DEFAULT_FREE_POOL.every((m) => m.endsWith(":free")));
  });

  it("picks LRU model from pool", () => {
    const provider = new OpenRouterProvider({ apiKey: "test-key" });
    const first = provider.pickModel();
    assert.ok(DEFAULT_FREE_POOL.includes(first));

    // Wait a tiny bit, pick again — should be a different model (LRU)
    const second = provider.pickModel();
    assert.notEqual(first, second);
    assert.ok(DEFAULT_FREE_POOL.includes(second));
  });

  it("returns next model for failover", () => {
    const provider = new OpenRouterProvider({ apiKey: "test-key" });
    const first = provider.pickModel();
    const next = provider.nextModel(first);
    assert.ok(next);
    assert.notEqual(next, first);
    assert.ok(DEFAULT_FREE_POOL.includes(next!));
  });

  it("returns null for failover when model not in pool", () => {
    const provider = new OpenRouterProvider({ apiKey: "test-key" });
    const next = provider.nextModel("some/paid-model:free");
    // If the model isn't in the pool, nextModel returns null
    // But "some/paid-model:free" isn't in the pool, so it should return null
    assert.equal(next, null);
  });

  it("respects preferred paid model (non-free)", () => {
    const provider = new OpenRouterProvider({ apiKey: "test-key" });
    const picked = provider.pickModel("anthropic/claude-3.5-sonnet");
    assert.equal(picked, "anthropic/claude-3.5-sonnet");
  });

  it("respects preferred free model if in pool", () => {
    const provider = new OpenRouterProvider({ apiKey: "test-key" });
    const preferred = DEFAULT_FREE_POOL[0];
    const picked = provider.pickModel(preferred);
    assert.equal(picked, preferred);
  });
});
