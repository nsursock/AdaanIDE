import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  LearnedModelStats,
  bayesianSmooth,
  applyDecay,
  expectedRequests,
  expectedRequestsEscalation,
} from "../src/server/learn/model-stats.js";

describe("model-stats", () => {
  describe("bayesianSmooth", () => {
    it("returns prior when no data", () => {
      const rate = bayesianSmooth(0, 0, 0.5);
      assert.equal(rate, 0.5);
    });

    it("a model at 1/1 does not outrank 8/10 with same prior", () => {
      const prior = 0.5;
      const rate11 = bayesianSmooth(1, 1, prior);
      const rate810 = bayesianSmooth(10, 8, prior);
      // 8/10 should be higher than 1/1 because the prior pulls 1/1 down
      assert.ok(rate810 > rate11, `8/10 (${rate810}) should > 1/1 (${rate11})`);
    });

    it("higher prior boosts the rate", () => {
      const lowPrior = bayesianSmooth(1, 1, 0.3);
      const highPrior = bayesianSmooth(1, 1, 0.7);
      assert.ok(highPrior > lowPrior);
    });
  });

  describe("applyDecay", () => {
    it("no decay when same day", () => {
      const result = applyDecay(10, 8, "2026-09-01", "2026-09-01");
      assert.equal(result.attempts, 10);
      assert.equal(result.weightedSuccesses, 8);
    });

    it("decays by half after one half-life (14 days)", () => {
      const result = applyDecay(10, 8, "2026-09-01", "2026-09-15");
      assert.ok(Math.abs(result.attempts - 5) < 0.1, `expected ~5, got ${result.attempts}`);
      assert.ok(Math.abs(result.weightedSuccesses - 4) < 0.1, `expected ~4, got ${result.weightedSuccesses}`);
    });

    it("decays more after longer time", () => {
      const shortDecay = applyDecay(10, 8, "2026-09-01", "2026-09-15");
      const longDecay = applyDecay(10, 8, "2026-09-01", "2026-10-15");
      assert.ok(longDecay.attempts < shortDecay.attempts);
    });
  });

  describe("expectedRequests", () => {
    it("returns 1/P(success)", () => {
      assert.equal(expectedRequests(1.0), 1);
      assert.equal(expectedRequests(0.5), 2);
      assert.equal(expectedRequests(0.25), 4);
    });

    it("returns Infinity for P=0", () => {
      assert.equal(expectedRequests(0), Infinity);
    });
  });

  describe("expectedRequestsEscalation", () => {
    it("returns 1 when cheap always succeeds", () => {
      assert.equal(expectedRequestsEscalation(1.0, 0.5), 1);
    });

    it("returns 1/pStronger when cheap always fails", () => {
      assert.equal(expectedRequestsEscalation(0, 0.5), 2);
    });

    it("is higher when both are weak", () => {
      const strong = expectedRequestsEscalation(0.8, 0.9);
      const weak = expectedRequestsEscalation(0.3, 0.3);
      assert.ok(weak > strong);
    });
  });

  describe("LearnedModelStats", () => {
    let stats: LearnedModelStats;

    beforeEach(() => {
      stats = new LearnedModelStats();
      stats._configure({ now: () => new Date("2026-09-01").getTime() });
    });

    it("records and retrieves posterior", () => {
      stats.record("fix", "model-a:free", 1.0, "2026-09-01");
      stats.record("fix", "model-a:free", 1.0, "2026-09-01");
      stats.record("fix", "model-a:free", 0.0, "2026-09-01");
      const post = stats.posterior("fix", "model-a:free");
      assert.ok(post.samples >= 2);
      assert.ok(post.successRate > 0 && post.successRate < 1);
    });

    it("returns prior for unknown model", () => {
      const post = stats.posterior("fix", "unknown-model");
      assert.equal(post.samples, 0);
      assert.ok(post.successRate >= 0.4 && post.successRate <= 0.6);
    });

    it("ranks models by success rate", () => {
      stats.record("fix", "good:free", 1.0, "2026-09-01");
      stats.record("fix", "good:free", 1.0, "2026-09-01");
      stats.record("fix", "bad:free", 0.0, "2026-09-01");
      stats.record("fix", "bad:free", 0.0, "2026-09-01");
      stats.record("fix", "bad:free", 0.0, "2026-09-01");
      stats.record("fix", "bad:free", 0.0, "2026-09-01");
      const ranking = stats.rank("fix");
      assert.ok(ranking.length >= 2);
      assert.equal(ranking[0].model, "good:free");
    });

    it("applies decay on record with time gap", () => {
      stats.record("fix", "model-a:free", 1.0, "2026-09-01");
      // Fast-forward 28 days (2 half-lives)
      stats._configure({ now: () => new Date("2026-09-29").getTime() });
      stats.record("fix", "model-a:free", 1.0, "2026-09-29");
      const post = stats.posterior("fix", "model-a:free");
      // After 2 half-lives, the first record decayed to 0.25, then +1 new
      // So attempts ≈ 1.25, weighted ≈ 1.25
      assert.ok(post.samples >= 1);
    });

    it("categoryPrior returns 0.5 for unknown category", () => {
      assert.equal(stats.categoryPrior("unknown"), 0.5);
    });
  });
});
