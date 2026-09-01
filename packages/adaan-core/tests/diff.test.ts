import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLineDiff, changedNewLines, diffStats } from "../src/diff.js";

describe("computeLineDiff", () => {
  it("classifies a pure insertion as adds", () => {
    const diff = computeLineDiff("a\nb\n", "a\nNEW\nb\n");
    const adds = diff.filter((d) => d.type === "add");
    assert.equal(adds.length, 1);
    assert.equal(adds[0].content, "NEW");
    assert.equal(adds[0].newLine, 2);
  });

  it("classifies a pure deletion as removes", () => {
    const diff = computeLineDiff("a\nGONE\nb\n", "a\nb\n");
    const removes = diff.filter((d) => d.type === "remove");
    assert.equal(removes.length, 1);
    assert.equal(removes[0].content, "GONE");
    assert.equal(removes[0].oldLine, 2);
  });

  it("classifies an in-place edit as modify", () => {
    const diff = computeLineDiff("a\nold\nb\n", "a\nnew\nb\n");
    const modifies = diff.filter((d) => d.type === "modify");
    assert.equal(modifies.length, 1);
    assert.equal(modifies[0].content, "new");
    assert.equal(modifies[0].oldContent, "old");
    assert.equal(modifies[0].newLine, 2);
    assert.equal(modifies[0].oldLine, 2);
  });

  it("handles multiple changes in one diff", () => {
    const old = "line1\nline2\nline3\nline4\n";
    const next = "line1\nCHANGED\nline3\nADDED\n";
    const diff = computeLineDiff(old, next);
    const stats = diffStats(diff);
    // line2->CHANGED (modify), line4->ADDED (modify) — both are in-place edits
    assert.equal(stats.modified, 2);
    assert.equal(stats.added, 0);
    assert.equal(stats.removed, 0);
  });

  it("returns all-equal for identical content", () => {
    const diff = computeLineDiff("a\nb\nc\n", "a\nb\nc\n");
    assert.ok(diff.every((d) => d.type === "equal"));
  });

  it("handles empty old content (all adds)", () => {
    const diff = computeLineDiff("", "a\nb\n");
    const adds = diff.filter((d) => d.type === "add");
    assert.equal(adds.length, 2);
  });

  it("handles empty new content (all removes)", () => {
    const diff = computeLineDiff("a\nb\n", "");
    const removes = diff.filter((d) => d.type === "remove");
    assert.equal(removes.length, 2);
  });
});

describe("changedNewLines", () => {
  it("returns 1-indexed new-doc line numbers for adds and modifies", () => {
    const diff = computeLineDiff("a\nb\nc\n", "a\nB\nc\nD\n");
    const lines = changedNewLines(diff);
    assert.deepEqual(lines.sort((x, y) => x - y), [2, 4]);
  });
});

describe("diffStats", () => {
  it("counts adds, modifies, and removes", () => {
    const diff = computeLineDiff("a\nb\nc\nd\n", "a\nB\nc\nD\ne\n");
    const stats = diffStats(diff);
    // b->B (modify), d->D (modify), e (add)
    assert.equal(stats.modified, 2);
    assert.equal(stats.added, 1);
    assert.equal(stats.removed, 0);
  });
});
