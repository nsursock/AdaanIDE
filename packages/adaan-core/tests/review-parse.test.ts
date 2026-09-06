import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePriorityTable,
  parseAggregatorJSON,
  buildIssueBody,
  buildLabels,
  backfillTaskFields,
  extractIssueBodySummary,
} from "../src/server/review/parse.js";
import type { ReviewTask } from "../src/server/review/types.js";

test("parsePriorityTable: extracts rows from a well-formed table", () => {
  const md = `
## Priority list

| Priority | Issue | Main finding | Fix | Lens(es) | Reviewer(s) | Impact |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | No stop-loss | Trades execute without any stop-loss guard. | Add a per-position stop in the executor. | quant,risk | claude | can blow up the account in one trade |
| P1 | Lookahead bias | Features use future close prices. | Shift features by one bar. | stats,backtesting | gemini | inflates backtest returns by ~30% |
`;
  const out = parsePriorityTable(md);
  assert.equal(out.length, 2);
  assert.equal(out[0].priority, "P0");
  assert.equal(out[0].issue, "No stop-loss");
  assert.equal(out[0].lenses.join(","), "quant,risk");
  assert.equal(out[0].reviewers.join(","), "claude");
  assert.equal(out[1].priority, "P1");
});

test("parsePriorityTable: tolerates a missing Reviewer(s) column", () => {
  const md = `
## Priority list

| Priority | Issue | Main finding | Fix | Lens(es) | Impact |
| --- | --- | --- | --- | --- | --- |
| P0 | No tests | Nothing is tested. | Add unit tests. | software | no regression protection |
`;
  const out = parsePriorityTable(md);
  assert.equal(out.length, 1);
  assert.equal(out[0].issue, "No tests");
  assert.deepEqual(out[0].reviewers, []);
  assert.equal(out[0].impact, "no regression protection");
});

test("parsePriorityTable: returns empty when no table present", () => {
  assert.deepEqual(parsePriorityTable("just prose, no table"), []);
});

test("parsePriorityTable: uses the last priority table when multiple exist", () => {
  const md = `
| Priority | Issue | Main finding | Fix | Lens(es) | Reviewer(s) | Impact |
| --- | --- | --- | --- | --- | --- | --- |
| P3 | old | x | y | z | m | n |

| Priority | Issue | Main finding | Fix | Lens(es) | Reviewer(s) | Impact |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | new | x | y | z | m | n |
`;
  const out = parsePriorityTable(md);
  assert.equal(out.length, 1);
  assert.equal(out[0].priority, "P0");
  assert.equal(out[0].issue, "new");
});

test("parseAggregatorJSON: parses a fenced JSON object with tasks", () => {
  const text = 'Here you go:\n```json\n{"tasks":[{"priority":"P0","issue":"X","mainFinding":"m","fix":"f","lenses":["a"],"reviewers":["b"],"impact":"i","issueBody":"body","labels":["x"]}]}\n```\n';
  const out = parseAggregatorJSON(text);
  assert.equal(out.tasks.length, 1);
  assert.equal(out.tasks[0].priority, "P0");
  assert.equal(out.tasks[0].issue, "X");
});

test("parseAggregatorJSON: parses raw JSON without fences", () => {
  const text = '{"tasks":[]}';
  const out = parseAggregatorJSON(text);
  assert.equal(out.tasks.length, 0);
});

test("parseAggregatorJSON: returns empty on garbage", () => {
  assert.deepEqual(parseAggregatorJSON("no json here"), { tasks: [] });
});

test("parseAggregatorJSON: drops tasks without an issue field", () => {
  const text = '{"tasks":[{"priority":"P2","issue":"","mainFinding":"m"}]}';
  const out = parseAggregatorJSON(text);
  assert.equal(out.tasks.length, 0);
});

test("buildIssueBody: produces a structured GitHub-issue body", () => {
  const task: Pick<ReviewTask, "priority" | "issue" | "mainFinding" | "fix" | "impact" | "lenses" | "reviewers"> = {
    priority: "P0",
    issue: "No stop-loss",
    mainFinding: "Trades execute without a stop.",
    fix: "Add a stop in the executor.",
    lenses: ["quant", "risk"],
    reviewers: ["claude"],
    impact: "can blow up the account",
  };
  const body = buildIssueBody(task);
  assert.ok(body.includes("## Summary"));
  assert.ok(body.includes("## Current behavior"));
  assert.ok(body.includes("## Expected behavior"));
  assert.ok(body.includes("## Affected code"));
  assert.ok(body.includes("## Acceptance criteria"));
  assert.ok(body.includes("## References"));
  assert.ok(body.includes("**Priority:** P0"));
});

test("buildLabels: produces priority + lens labels", () => {
  const labels = buildLabels({ priority: "P0", lenses: ["quant", "risk"] });
  assert.ok(labels.includes("priority:p0"));
  assert.ok(labels.includes("lens:quant"));
  assert.ok(labels.includes("lens:risk"));
});

test("TASK_PRIORITIES: contains P0..P3", async () => {
  const { TASK_PRIORITIES } = await import("../src/server/review/types.js");
  assert.deepEqual(TASK_PRIORITIES, ["P0", "P1", "P2", "P3"]);
});

test("EXPERTISE_LEVELS: contains top-0.1% through top-25%", async () => {
  const { EXPERTISE_LEVELS } = await import("../src/server/review/types.js");
  assert.deepEqual(EXPERTISE_LEVELS, ["top-0.1%", "top-1%", "top-10%", "top-25%"]);
});

test("MODEL_TIERS: contains free, paid, all", async () => {
  const { MODEL_TIERS } = await import("../src/server/review/types.js");
  assert.deepEqual(MODEL_TIERS, ["free", "paid", "all"]);
});

test("REVIEW_PRESETS: trading-bot preset has 12 lenses", async () => {
  const { REVIEW_PRESETS } = await import("../src/server/review/presets.js");
  const tb = REVIEW_PRESETS.find((p) => p.id === "trading-bot");
  assert.ok(tb);
  assert.equal(tb!.lenses.length, 12);
});

test("REVIEW_PRESETS: smoke-test preset has 2 lenses and is marked smokeTest", async () => {
  const { REVIEW_PRESETS } = await import("../src/server/review/presets.js");
  const st = REVIEW_PRESETS.find((p) => p.id === "smoke-test");
  assert.ok(st);
  assert.equal(st!.lenses.length, 2);
  assert.equal(st!.smokeTest, true);
});

test("REVIEW_PRESETS: at least 9 presets available", async () => {
  const { REVIEW_PRESETS } = await import("../src/server/review/presets.js");
  assert.ok(REVIEW_PRESETS.length >= 9, `expected >= 9 presets, got ${REVIEW_PRESETS.length}`);
});

test("estimateReviewCost: computes cost for paid models", async () => {
  const { estimateReviewCost } = await import("../src/server/review/models.js");
  const fakeModel = {
    id: "test/paid",
    name: "Test",
    contextLength: 200000,
    pricing: { prompt: "15", completion: "75" },
    toolsCapable: true,
    free: false,
  };
  const aggModel = {
    id: "test/agg",
    name: "Agg",
    contextLength: 200000,
    pricing: { prompt: "15", completion: "75" },
    toolsCapable: true,
    free: false,
  };
  const { cost, tokens } = estimateReviewCost([fakeModel], aggModel as any, 12000, 2);
  assert.ok(cost > 0, `cost should be > 0, got ${cost}`);
  assert.ok(tokens > 0);
  // 2 reviewers × (14k input + 4k output) + aggregator (10k input + 2k output) = 44k tokens
  // cost = (28000/1M * 15) + (8000/1M * 75) + (10000/1M * 15) + (2000/1M * 75) = 0.42 + 0.6 + 0.15 + 0.15 = 1.32
  assert.ok(cost < 5, `cost should be reasonable, got ${cost}`);
});

function mkTask(extra: Partial<ReviewTask> = {}): ReviewTask {
  return {
    priority: "P0",
    issue: "Broken OHLC invariants",
    mainFinding: "",
    fix: "",
    lenses: ["STAT"],
    reviewers: ["Claude"],
    impact: "",
    issueBody: "",
    labels: [],
    ...extra,
  };
}

test("extractIssueBodySummary: returns the Summary section text", () => {
  const body = "## Summary\nCloses can fall outside highs and lows.\n\n## Current behavior\nNoise is added independently.";
  assert.equal(extractIssueBodySummary(body), "Closes can fall outside highs and lows.");
});

test("extractIssueBodySummary: empty when no Summary section", () => {
  assert.equal(extractIssueBodySummary("## Current behavior\nfoo"), "");
  assert.equal(extractIssueBodySummary(""), "");
});

test("backfillTaskFields: fills empty mainFinding from issue body summary", () => {
  const t = mkTask({ issueBody: "## Summary\nThe validator misses negative prices.\n\n## Current behavior\nx" });
  backfillTaskFields(t);
  assert.equal(t.mainFinding, "The validator misses negative prices.");
});

test("backfillTaskFields: falls back to the issue title", () => {
  const t = mkTask();
  backfillTaskFields(t);
  assert.equal(t.mainFinding, "Broken OHLC invariants");
});

test("backfillTaskFields: never overwrites existing fields", () => {
  const t = mkTask({ mainFinding: "Original finding", issueBody: "## Summary\nOther text" });
  backfillTaskFields(t);
  assert.equal(t.mainFinding, "Original finding");
});

test("lensShortCode: derives codes by word count", async () => {
  const { lensShortCode, lensCode } = await import("../src/server/review/parse.js");
  assert.equal(lensShortCode("Statistician"), "STAT");
  assert.equal(lensShortCode("Data Scientist"), "DASC");
  assert.equal(lensShortCode("Evaluation & Metrics Specialist"), "EMS");
  assert.equal(lensCode({ label: "Statistician" }), "STAT");
  assert.equal(lensCode({ label: "Statistician", code: "st" }), "ST");
  assert.equal(lensCode({ label: "Evaluation & Metrics Specialist", code: " eval " }), "EVAL");
});
