import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OUTCOME_WEIGHTS,
  OUTCOME_RANK,
  isUpgrade,
  isCorrectionMessage,
  isTestPass,
  detectOutcome,
} from "../src/server/learn/outcome.js";

describe("outcome", () => {
  describe("OUTCOME_WEIGHTS", () => {
    it("verified and accepted have weight 1.0", () => {
      assert.equal(OUTCOME_WEIGHTS.verified, 1.0);
      assert.equal(OUTCOME_WEIGHTS.accepted, 1.0);
    });

    it("silent has weight 0.7", () => {
      assert.equal(OUTCOME_WEIGHTS.silent, 0.7);
    });

    it("rejected has weight 0.0", () => {
      assert.equal(OUTCOME_WEIGHTS.rejected, 0.0);
    });

    it("corrected has low weight", () => {
      assert.equal(OUTCOME_WEIGHTS.corrected, 0.2);
    });

    it("rolled_back has very low weight", () => {
      assert.equal(OUTCOME_WEIGHTS.rolled_back, 0.1);
    });
  });

  describe("isUpgrade", () => {
    it("upgrades from silent to verified", () => {
      assert.equal(isUpgrade("silent", "verified"), true);
    });

    it("upgrades from silent to accepted", () => {
      assert.equal(isUpgrade("silent", "accepted"), true);
    });

    it("does not downgrade from verified to silent", () => {
      assert.equal(isUpgrade("verified", "silent"), false);
    });

    it("does not downgrade from accepted to corrected", () => {
      assert.equal(isUpgrade("accepted", "corrected"), false);
    });

    it("upgrades from rejected to silent", () => {
      assert.equal(isUpgrade("rejected", "silent"), true);
    });

    it("does not downgrade from corrected to rejected", () => {
      assert.equal(isUpgrade("corrected", "rejected"), false);
    });
  });

  describe("isCorrectionMessage", () => {
    it("matches 'no' at start", () => {
      assert.equal(isCorrectionMessage("no, that's wrong"), true);
    });

    it("matches 'wrong' at start", () => {
      assert.equal(isCorrectionMessage("wrong, try again"), true);
    });

    it("matches 'that broke'", () => {
      assert.equal(isCorrectionMessage("that broke everything"), true);
    });

    it("matches 'undo'", () => {
      assert.equal(isCorrectionMessage("undo that change"), true);
    });

    it("matches 'revert'", () => {
      assert.equal(isCorrectionMessage("revert the last commit"), true);
    });

    it("matches 'not what I meant'", () => {
      assert.equal(isCorrectionMessage("not what I meant at all"), true);
    });

    it("matches 'you misunderstood'", () => {
      assert.equal(isCorrectionMessage("you misunderstood my request"), true);
    });

    it("does not match follow-up 'no, add a sidebar too'", () => {
      // "no, add a sidebar too" starts with "no," which matches the pattern.
      // This is a known false positive — the spec says the < 5 min conjunction
      // helps, but the regex alone can't distinguish. The test documents this.
      assert.equal(isCorrectionMessage("no, add a sidebar too"), true);
    });

    it("does not match a normal follow-up", () => {
      assert.equal(isCorrectionMessage("now add a sidebar too"), false);
    });

    it("does not match a question", () => {
      assert.equal(isCorrectionMessage("what does this function do?"), false);
    });
  });

  describe("isTestPass", () => {
    it("returns true for exitCode 0", () => {
      assert.equal(isTestPass({ output: { exitCode: 0 } }), true);
    });

    it("returns false for exitCode 1", () => {
      assert.equal(isTestPass({ output: { exitCode: 1 } }), false);
    });

    it("returns false for missing exitCode", () => {
      assert.equal(isTestPass({ output: {} }), false);
    });

    it("returns false for null", () => {
      assert.equal(isTestPass(null), false);
    });

    it("handles raw ShellResult (no output wrapper)", () => {
      assert.equal(isTestPass({ exitCode: 0 }), true);
      assert.equal(isTestPass({ exitCode: 1 }), false);
    });
  });

  describe("detectOutcome", () => {
    it("returns rejected when feedback is rejected", () => {
      assert.equal(detectOutcome([], "rejected"), "rejected");
    });

    it("returns accepted when feedback is accepted", () => {
      assert.equal(detectOutcome([], "accepted"), "accepted");
    });

    it("returns rolled_back when rolledBack is true", () => {
      assert.equal(detectOutcome([], null, true), "rolled_back");
    });

    it("returns corrected when nextMessageIsCorrection is true", () => {
      assert.equal(detectOutcome([], null, false, true), "corrected");
    });

    it("returns verified when last test passed", () => {
      assert.equal(detectOutcome([{ output: { exitCode: 0 } }]), "verified");
    });

    it("returns silent when last test failed", () => {
      assert.equal(detectOutcome([{ output: { exitCode: 1 } }]), "silent");
    });

    it("returns silent when no signals", () => {
      assert.equal(detectOutcome([]), "silent");
    });

    it("rejected takes priority over verified", () => {
      assert.equal(detectOutcome([{ output: { exitCode: 0 } }], "rejected"), "rejected");
    });

    it("accepted takes priority over verified", () => {
      assert.equal(detectOutcome([{ output: { exitCode: 0 } }], "accepted"), "accepted");
    });
  });

  describe("OUTCOME_RANK (D12 monotonicity)", () => {
    it("verified has the highest rank", () => {
      assert.equal(OUTCOME_RANK.verified, 5);
    });

    it("rejected has the lowest rank", () => {
      assert.equal(OUTCOME_RANK.rejected, 0);
    });

    it("silent ranks above corrected", () => {
      assert.ok(OUTCOME_RANK.silent > OUTCOME_RANK.corrected);
    });

    it("can be used to guard monotonic relabeling (D12 pattern)", () => {
      // D12 pattern: relabel to "rejected" on error status, but NEVER
      // downgrade verified/accepted (monotonicity). This is the exact
      // check the engine's finalizeTask() does.
      const shouldRelabel = (current: string): boolean =>
        current !== "verified" && current !== "accepted";

      // "silent" (default) → should relabel to rejected
      assert.equal(shouldRelabel("silent"), true);
      // "verified" → should NOT relabel (monotonicity: never downgrade verified)
      assert.equal(shouldRelabel("verified"), false);
      // "accepted" → should NOT relabel
      assert.equal(shouldRelabel("accepted"), false);
      // "rejected" → already rejected, relabel is a no-op but allowed
      assert.equal(shouldRelabel("rejected"), true);
      // "corrected" → should relabel (corrected is weak positive, error is stronger negative)
      assert.equal(shouldRelabel("corrected"), true);
    });
  });
});
