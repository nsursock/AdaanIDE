import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runReview } from "../src/server/review/runner.js";
import { reviewStore } from "../src/server/review/store.js";
import type { LLMProvider } from "../src/server/agent/provider.js";
import type { Workspace } from "../src/server/workspace.js";
import type { ReviewConfig, ReviewProgress, ReviewResult } from "../src/server/review/types.js";
import type { ProviderEvent, ProviderMessage, ProviderChatOptions } from "../src/types.js";

// ---------------------------------------------------------------------------
// A provider where specific reviewer models fail (error or empty) and spare
// models from the tier pool succeed — exercises the reviewer failover path.
// ---------------------------------------------------------------------------

const AGG_JSON = JSON.stringify({
  tasks: [
    {
      priority: "P1",
      issue: "Fake finding",
      mainFinding: "This is a synthetic finding for tests only",
      fix: "Apply the synthetic fix to the fake code",
      lenses: ["TEST"],
      reviewers: ["Spare"],
      impact: "Keeps the test suite green forever",
      issueBody: "## Summary\nfake",
      labels: ["priority:p1"],
    },
  ],
});

/** Models that should error when used as a committee reviewer. */
class FailoverProvider implements LLMProvider {
  errorModels = new Set<string>();
  emptyModels = new Set<string>();
  reasoningOnlyModels = new Set<string>();
  reasoningTruncatedModels = new Set<string>();
  reasoningDegenerateModels = new Set<string>();
  reasoningErroredModels = new Set<string>();
  toolCallModels = new Set<string>();
  aggErrorModels = new Set<string>();
  aggTruncatedModels = new Set<string>();
  aggDegenerateModels = new Set<string>();
  calls: string[] = [];

  async *chat(messages: ProviderMessage[], options: ProviderChatOptions): AsyncIterable<ProviderEvent> {
    const system = String(messages[0]?.content ?? "");
    const isAggregator = system.includes("ONLY a JSON object");
    const model = (options as { model: string }).model;
    this.calls.push(model);
    if (isAggregator) {
      if (this.aggErrorModels.has(model)) {
        yield { type: "error", data: { message: `Aggregator upstream error: fetch failed` } };
        return;
      }
      if (this.aggTruncatedModels.has(model)) {
        // Aggregator produces only reasoning, hits token limit, no JSON.
        yield { type: "reasoning.delta", data: { text: `We need to produce a single deduplicated prioritized task list as JSON. `.repeat(100) } };
        yield { type: "finish", data: { finishReason: "length", model } };
        return;
      }
      if (this.aggDegenerateModels.has(model)) {
        // Aggregator produces degenerate repetitive reasoning, finishes
        // normally, but no JSON content.
        yield { type: "reasoning.delta", data: { text: `We need to produce a single deduplicated prioritized task list as json.\n`.repeat(100) } };
        yield { type: "finish", data: { finishReason: "stop", model } };
        return;
      }
      yield { type: "text.delta", data: { text: AGG_JSON } };
      return;
    }
    if (this.errorModels.has(model)) {
      yield { type: "error", data: { message: `Upstream error: ResourceExhausted (16/16)` } };
      return;
    }
    if (this.emptyModels.has(model)) {
      // Stream completes with no text.
      return;
    }
    if (this.reasoningOnlyModels.has(model)) {
      // Model produces only reasoning (chain-of-thought), no content, and
      // completes normally (finish: stop). The reasoning is diverse enough
      // to pass the degeneracy check.
      yield { type: "reasoning.delta", data: { text: `Let me analyze this project step by step. `.repeat(20) } };
      yield { type: "reasoning.delta", data: { text: `The PPO implementation has a bug in the MLP class. `.repeat(20) } };
      yield { type: "finish", data: { finishReason: "stop", model } };
      return;
    }
    if (this.reasoningTruncatedModels.has(model)) {
      // Model produces only reasoning but hits the token limit (finish:
      // length). The reasoning is incomplete — this is the degenerate case
      // from the real run where Cohere-backed Gemma filled 9k tokens with
      // repetitive reasoning and never emitted content.
      yield { type: "reasoning.delta", data: { text: `The PPO class also has a _compile_update method that uses mx.grad and optimizer. It may have issues with the learning rate. `.repeat(100) } };
      yield { type: "finish", data: { finishReason: "length", model } };
      return;
    }
    if (this.reasoningDegenerateModels.has(model)) {
      // Model produces degenerate repetitive reasoning but finishes
      // normally (finish: stop). The reasoning is a loop of the same
      // sentence with minor variations — not usable as output.
      yield { type: "reasoning.delta", data: { text: `The PPO class also has a _compile_update method that uses mx.grad and optimizer. It may have issues with the learning rate.\n`.repeat(100) } };
      yield { type: "finish", data: { finishReason: "stop", model } };
      return;
    }
    if (this.reasoningErroredModels.has(model)) {
      // Model produces reasoning then the stream errors (terminated/fetch
      // failed/timeout). The reasoning is incomplete — the model was
      // interrupted mid-thought. This is the case from the real run where
      // Nemotron produced 3k chars of reasoning then was terminated.
      yield { type: "reasoning.delta", data: { text: `We need to read all files and look for defects across lenses. `.repeat(20) } };
      yield { type: "reasoning.delta", data: { text: `The PPO implementation has a bug in the MLP class. `.repeat(20) } };
      yield { type: "error", data: { message: "terminated" } };
      return;
    }
    if (this.toolCallModels.has(model)) {
      // Model hallucinates tool calls instead of following the review
      // prompt. This happens with small free models like Liquid lfm-2.5.
      yield { type: "text.delta", data: { text: `<|tool_call_start|>[find_pattern(path='/workspace', pattern='volatility'), find_pattern(path='/workspace', pattern='generate_market_data')]<|tool_call_end|>` } };
      return;
    }
    yield { type: "text.delta", data: { text: `findings from ${model}` } };
  }

  async listModels() {
    return {
      free: [
        { id: "m/a:free", name: "A", pricing: { prompt: "0", completion: "0" } },
        { id: "m/b:free", name: "B", pricing: { prompt: "0", completion: "0" } },
        { id: "m/spare1:free", name: "Spare1", pricing: { prompt: "0", completion: "0" } },
        { id: "m/spare2:free", name: "Spare2", pricing: { prompt: "0", completion: "0" } },
        { id: "m/agg", name: "Agg", pricing: { prompt: "0", completion: "0" } },
      ] as any,
      paid: [],
    };
  }
}

const workspace = {
  rootPath: "/tmp/rev-failover-ws",
  listTree: async () => [],
  readFile: async () => { throw new Error("no files"); },
} as unknown as Workspace;

function config(overrides: Partial<ReviewConfig> = {}): ReviewConfig {
  return {
    id: `cfg-${Math.random().toString(36).slice(2, 8)}`,
    name: "Failover Test",
    lenses: [{ id: "test", emoji: "🧪", label: "Tester", role: "tester" }],
    expertise: "top-1%",
    modelTier: "free",
    reviewerModels: ["m/a:free", "m/b:free"],
    aggregatorModel: "m/agg",
    intervalValue: 0,
    intervalUnit: "hours",
    createGitHubIssues: false,
    writeTasksFile: false,
    enabled: false,
    ...overrides,
  };
}

async function drain(gen: AsyncIterable<ReviewProgress>): Promise<{ events: ReviewProgress[]; result: ReviewResult | undefined }> {
  const events: ReviewProgress[] = [];
  let result: ReviewResult | undefined;
  for await (const ev of gen) {
    events.push(ev);
    if (ev.phase === "complete") result = (ev as { result: ReviewResult }).result;
    if (["complete", "error", "cancelled"].includes(ev.phase)) break;
  }
  return { events, result };
}

let tmpDir: string;
before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-failover-"));
  reviewStore._configure({ filePath: path.join(tmpDir, "reviews.json") });
  await reviewStore.load();
});

// ---------------------------------------------------------------------------

test("reviewer failover: erroring primary retries on a spare and the run completes", async () => {
  const provider = new FailoverProvider();
  provider.errorModels.add("m/a:free"); // primary for slot 0 errors
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  const failovers = events.filter((e) => e.phase === "committee.failover") as any[];
  assert.ok(failovers.length >= 1, "at least one failover event emitted");
  assert.equal(failovers[0].from, "m/a:free");
  assert.equal(failovers[0].to, "m/spare1:free", "first spare drawn from tier pool");

  assert.equal(result?.status, "complete", "run completes despite primary failure");
  assert.ok(result!.rawOutputs["m/spare1:free"], "spare output recorded");
  assert.ok(!result!.rawOutputs["m/a:free"]?.startsWith("[REVIEWER ERROR"), "errored primary not left as a rawOutput key");
  assert.ok(result!.failovers && result!.failovers.length >= 1, "failover recorded on result");
  assert.ok(result!.reviewerModels.includes("m/spare1:free"), "actual model reflected in reviewerModels");
});

test("reviewer failover: empty output triggers failover to a spare", async () => {
  const provider = new FailoverProvider();
  provider.emptyModels.add("m/a:free"); // primary returns empty
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  const failovers = events.filter((e) => e.phase === "committee.failover") as any[];
  assert.ok(failovers.length >= 1, "empty output triggered a failover");
  assert.equal(failovers[0].from, "m/a:free");
  assert.equal(result?.status, "complete");
  assert.ok(result!.rawOutputs["m/spare1:free"], "spare output recorded after empty primary");
});

test("reviewer failover: when all models (primary + spares) fail, the run errors", async () => {
  const provider = new FailoverProvider();
  provider.errorModels.add("m/a:free");
  provider.errorModels.add("m/b:free");
  // Make all spares error too.
  provider.errorModels.add("m/spare1:free");
  provider.errorModels.add("m/spare2:free");
  const cfg = config();

  let captured: ReviewResult | undefined;
  const { events } = await drain(runReview({
    config: cfg,
    workspace,
    provider,
    triggeredBy: "manual",
    onResultUpdate: (r) => { captured = r; },
  }));

  assert.equal(captured?.status, "error", "run errors when every model fails");
  const errEvent = events.find((e) => e.phase === "error") as any;
  assert.ok(errEvent, "error phase emitted");
  assert.match(errEvent.message, /All reviewer models failed/i);
});

test("reviewer failover: partial text (>200 chars) is preserved, no failover", async () => {
  const provider = new FailoverProvider();
  // Make m/a:free stream a long partial response then error.
  class PartialProvider extends FailoverProvider {
    async *chat(messages: ProviderMessage[], options: ProviderChatOptions): AsyncIterable<ProviderEvent> {
      const system = String(messages[0]?.content ?? "");
      const isAggregator = system.includes("ONLY a JSON object");
      const model = (options as { model: string }).model;
      this.calls.push(model);
      if (isAggregator) {
        yield { type: "text.delta", data: { text: AGG_JSON } };
        return;
      }
      if (model === "m/a:free") {
        yield { type: "text.delta", data: { text: "x".repeat(250) } };
        yield { type: "error", data: { message: "stopped early" } };
        return;
      }
      if (this.emptyModels.has(model)) return;
      yield { type: "text.delta", data: { text: `findings from ${model}` } };
    }
  }
  const p = new PartialProvider();
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider: p, triggeredBy: "manual" }));

  const failovers = events.filter((e) => e.phase === "committee.failover") as any[];
  assert.equal(failovers.length, 0, "no failover when partial text is preserved");
  assert.equal(result?.status, "complete");
  const raw = result!.rawOutputs["m/a:free"];
  assert.ok(raw && raw.includes("[NOTE: Reviewer stopped early"), "partial text preserved with NOTE");
});

test("reviewer failover: reasoning-only model (finish: stop, diverse) uses reasoning as output, no failover", async () => {
  const provider = new FailoverProvider();
  provider.reasoningOnlyModels.add("m/a:free"); // produces only reasoning, finishes normally
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  // No failover should happen — the model produced reasoning which is used as output.
  const failovers = events.filter((e) => e.phase === "committee.failover") as any[];
  assert.equal(failovers.length, 0, "no failover when reasoning was produced and model finished normally");

  assert.equal(result?.status, "complete", "run completes using reasoning as output");
  const raw = result!.rawOutputs["m/a:free"];
  assert.ok(raw, "raw output recorded for the reasoning-only model");
  assert.ok(raw!.includes("[NOTE: Model produced only reasoning"), "reasoning output marked with NOTE");
  assert.ok(raw!.length > 200, "reasoning output is substantial");
});

test("reviewer failover: reasoning truncated by token limit (finish: length) triggers failover", async () => {
  const provider = new FailoverProvider();
  provider.reasoningTruncatedModels.add("m/a:free"); // reasoning hits token limit
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  // Failover should happen — the model hit the token limit during reasoning,
  // so the reasoning is incomplete and not usable.
  const failovers = events.filter((e) => e.phase === "committee.failover") as any[];
  assert.ok(failovers.length >= 1, "failover triggered when reasoning was truncated by token limit");
  assert.match(failovers[0].reason, /token limit/i, "failover reason mentions token limit");

  assert.equal(result?.status, "complete", "run completes via failover to a spare");
  // The truncated model's output should NOT be in rawOutputs.
  assert.ok(!result!.rawOutputs["m/a:free"], "truncated reasoning not kept as output");
});

test("reviewer failover: degenerate repetitive reasoning (finish: stop) triggers failover", async () => {
  const provider = new FailoverProvider();
  provider.reasoningDegenerateModels.add("m/a:free"); // degenerate reasoning, finishes normally
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  // Failover should happen — the reasoning is degenerate/repetitive even
  // though the model finished normally.
  const failovers = events.filter((e) => e.phase === "committee.failover") as any[];
  assert.ok(failovers.length >= 1, "failover triggered when reasoning is degenerate");
  assert.match(failovers[0].reason, /degenerate/i, "failover reason mentions degenerate");

  assert.equal(result?.status, "complete", "run completes via failover to a spare");
  assert.ok(!result!.rawOutputs["m/a:free"], "degenerate reasoning not kept as output");
});

test("reviewer failover: reasoning then stream error (terminated/fetch failed) triggers failover, not partial acceptance", async () => {
  const provider = new FailoverProvider();
  provider.reasoningErroredModels.add("m/a:free"); // reasoning then stream error
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  // Failover should happen — the reasoning was interrupted by a stream
  // error, so it's incomplete and not usable as output.
  const failovers = events.filter((e) => e.phase === "committee.failover") as any[];
  assert.ok(failovers.length >= 1, "failover triggered when reasoning was interrupted by stream error");
  assert.match(failovers[0].reason, /stream errored|terminated|incomplete/i, "failover reason mentions the stream error");

  assert.equal(result?.status, "complete", "run completes via failover to a spare");
  // The errored model's reasoning should NOT be in rawOutputs.
  assert.ok(!result!.rawOutputs["m/a:free"], "interrupted reasoning not kept as output");
});

test("aggregator failover: truncated reasoning (finish: length, no JSON) triggers failover to a spare", async () => {
  const provider = new FailoverProvider();
  provider.aggTruncatedModels.add("m/agg"); // aggregator hits token limit during reasoning
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  const failovers = events.filter((e) => e.phase === "aggregator.failover") as any[];
  assert.ok(failovers.length >= 1, "aggregator failover triggered when judge hit token limit during reasoning");
  assert.match(failovers[0].reason, /token limit/i, "failover reason mentions token limit");
  assert.equal(failovers[0].from, "m/agg", "failover from the original aggregator");

  assert.equal(result?.status, "complete", "run completes via aggregator failover");
  assert.notEqual(result!.aggregatorModel, "m/agg", "aggregatorModel reflects the spare");
  assert.ok(result!.aggregatorFailovers && result!.aggregatorFailovers.length >= 1, "failover recorded in result");
});

test("aggregator failover: degenerate reasoning (finish: stop, no JSON) triggers failover", async () => {
  const provider = new FailoverProvider();
  provider.aggDegenerateModels.add("m/agg"); // degenerate reasoning, no JSON
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  const failovers = events.filter((e) => e.phase === "aggregator.failover") as any[];
  assert.ok(failovers.length >= 1, "aggregator failover triggered when judge reasoning is degenerate");
  assert.match(failovers[0].reason, /degenerate/i, "failover reason mentions degenerate");

  assert.equal(result?.status, "complete", "run completes via aggregator failover");
  assert.notEqual(result!.aggregatorModel, "m/agg", "aggregatorModel reflects the spare");
});

test("aggregator failover: stream error triggers failover", async () => {
  const provider = new FailoverProvider();
  provider.aggErrorModels.add("m/agg"); // aggregator stream errors
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  const failovers = events.filter((e) => e.phase === "aggregator.failover") as any[];
  assert.ok(failovers.length >= 1, "aggregator failover triggered when judge stream errored");
  assert.match(failovers[0].reason, /stream errored|fetch failed/i, "failover reason mentions the stream error");

  assert.equal(result?.status, "complete", "run completes via aggregator failover");
  assert.notEqual(result!.aggregatorModel, "m/agg", "aggregatorModel reflects the spare");
});

test("reviewer failover: tool-call output (hallucinated tools instead of review) triggers failover", async () => {
  const provider = new FailoverProvider();
  provider.toolCallModels.add("m/a:free"); // produces tool calls, not a review
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  // Failover should happen — the model produced tool-call syntax instead
  // of review content. It didn't follow the review prompt.
  const failovers = events.filter((e) => e.phase === "committee.failover") as any[];
  assert.ok(failovers.length >= 1, "failover triggered when model produced tool-call syntax");
  assert.match(failovers[0].reason, /tool.call/i, "failover reason mentions tool-call");

  assert.equal(result?.status, "complete", "run completes via failover to a spare");
  // The tool-call output should NOT be in rawOutputs.
  assert.ok(!result!.rawOutputs["m/a:free"], "tool-call output not kept as reviewer output");
});

test("aggregator: valid empty JSON ({\"tasks\": []}) does NOT trigger failover", async () => {
  // When the judge correctly returns {"tasks": []} (no findings to
  // aggregate), that's a valid result — not a failure. The aggregator
  // should NOT failover.
  const provider = new FailoverProvider();
  // Override the aggregator to return empty JSON.
  class EmptyJSONProvider extends FailoverProvider {
    async *chat(messages: ProviderMessage[], options: ProviderChatOptions): AsyncIterable<ProviderEvent> {
      const system = String(messages[0]?.content ?? "");
      const isAggregator = system.includes("ONLY a JSON object");
      const model = (options as { model: string }).model;
      this.calls.push(model);
      if (isAggregator) {
        yield { type: "text.delta", data: { text: `{"tasks": []}` } };
        yield { type: "finish", data: { finishReason: "stop", model } };
        return;
      }
      yield* super.chat(messages, options);
    }
  }
  const p = new EmptyJSONProvider();
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider: p, triggeredBy: "manual" }));

  // No aggregator failover should happen — {"tasks": []} is valid JSON.
  const failovers = events.filter((e) => e.phase === "aggregator.failover") as any[];
  assert.equal(failovers.length, 0, "no aggregator failover when judge returned valid empty JSON");

  assert.equal(result?.status, "complete", "run completes");
  assert.equal(result!.aggregatorModel, "m/agg", "aggregatorModel unchanged (no failover)");
  assert.ok(!result!.aggregatorFailovers || result!.aggregatorFailovers.length === 0, "no failovers recorded");
});

// ---------------------------------------------------------------------------
// Same-model retry tests — the new strategy retries the SAME model (possibly
// with a raised token budget for truncation) before swapping to a spare.
// ---------------------------------------------------------------------------

/** A provider where a model truncates on the first call but succeeds on the
 *  second call with a higher maxTokens — exercises the same-model retry with
 *  budget escalation path. */
class BudgetEscalationProvider implements LLMProvider {
  /** Models that succeed when given enough tokens (>= threshold). */
  successThresholds = new Map<string, number>();
  /** Track maxTokens passed per call to decide whether to succeed. */
  calls: { model: string; maxTokens: number }[] = [];

  async *chat(messages: ProviderMessage[], options: ProviderChatOptions): AsyncIterable<ProviderEvent> {
    const system = String(messages[0]?.content ?? "");
    const isAggregator = system.includes("ONLY a JSON object");
    const model = (options as { model: string }).model;
    const maxTokens = (options as { maxTokens?: number }).maxTokens ?? 8192;
    this.calls.push({ model, maxTokens });
    if (isAggregator) {
      yield { type: "text.delta", data: { text: AGG_JSON } };
      return;
    }
    const threshold = this.successThresholds.get(model);
    if (threshold !== undefined && maxTokens < threshold) {
      // Not enough tokens — produce truncated reasoning.
      yield { type: "reasoning.delta", data: { text: `Analyzing the project step by step with detailed reasoning. `.repeat(100) } };
      yield { type: "finish", data: { finishReason: "length", model } };
      return;
    }
    // Enough tokens (or no threshold) — produce real content.
    yield { type: "text.delta", data: { text: `findings from ${model} at maxTokens=${maxTokens}` } };
  }

  async listModels() {
    return {
      free: [
        { id: "m/a:free", name: "A", pricing: { prompt: "0", completion: "0" } },
        { id: "m/b:free", name: "B", pricing: { prompt: "0", completion: "0" } },
        { id: "m/spare1:free", name: "Spare1", pricing: { prompt: "0", completion: "0" } },
        { id: "m/spare2:free", name: "Spare2", pricing: { prompt: "0", completion: "0" } },
        { id: "m/agg", name: "Agg", pricing: { prompt: "0", completion: "0" } },
      ] as any,
      paid: [],
    };
  }
}

test("same-model retry: truncation triggers same-model retry with raised budget before failover", async () => {
  const provider = new BudgetEscalationProvider();
  // m/a:free needs 16384 tokens to succeed — it truncates at 8192.
  provider.successThresholds.set("m/a:free", 16384);
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  // Should emit a retry event (same model, higher budget), NOT a failover.
  const retries = events.filter((e) => e.phase === "committee.retry") as any[];
  const failovers = events.filter((e) => e.phase === "committee.failover") as any[];

  assert.ok(retries.length >= 1, "same-model retry emitted for truncation");
  assert.equal(retries[0].model, "m/a:free", "retry is on the same model");
  assert.equal(retries[0].maxTokens, 16384, "retry uses raised budget");
  assert.match(retries[0].reason, /token limit/i, "retry reason mentions token limit");

  assert.equal(failovers.length, 0, "no failover — same-model retry succeeded");

  assert.equal(result?.status, "complete", "run completes via same-model retry");
  assert.ok(result!.rawOutputs["m/a:free"], "output recorded under the original model");
  assert.ok(result!.retries && result!.retries.length >= 1, "retry recorded in result metadata");
  assert.ok(!result!.failovers || result!.failovers.length === 0, "no failovers recorded");
});

test("same-model retry: transient error (empty) retries same model once before failover", async () => {
  // A provider where m/a:free returns empty on the first call but succeeds
  // on the second call (simulating a transient non-deterministic failure).
  class TransientEmptyProvider implements LLMProvider {
    emptyOnFirstCall = new Set<string>();
    callCount = new Map<string, number>();
    calls: string[] = [];

    async *chat(messages: ProviderMessage[], options: ProviderChatOptions): AsyncIterable<ProviderEvent> {
      const system = String(messages[0]?.content ?? "");
      const isAggregator = system.includes("ONLY a JSON object");
      const model = (options as { model: string }).model;
      this.calls.push(model);
      if (isAggregator) {
        yield { type: "text.delta", data: { text: AGG_JSON } };
        return;
      }
      const count = (this.callCount.get(model) ?? 0) + 1;
      this.callCount.set(model, count);
      if (this.emptyOnFirstCall.has(model) && count === 1) {
        // First call: empty (no text, no finish — just returns).
        return;
      }
      yield { type: "text.delta", data: { text: `findings from ${model}` } };
    }

    async listModels() {
      return {
        free: [
          { id: "m/a:free", name: "A", pricing: { prompt: "0", completion: "0" } },
          { id: "m/b:free", name: "B", pricing: { prompt: "0", completion: "0" } },
          { id: "m/spare1:free", name: "Spare1", pricing: { prompt: "0", completion: "0" } },
          { id: "m/spare2:free", name: "Spare2", pricing: { prompt: "0", completion: "0" } },
          { id: "m/agg", name: "Agg", pricing: { prompt: "0", completion: "0" } },
        ] as any,
        paid: [],
      };
    }
  }

  const provider = new TransientEmptyProvider();
  provider.emptyOnFirstCall.add("m/a:free");
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  // Should retry the same model (not failover) — the second call succeeds.
  const retries = events.filter((e) => e.phase === "committee.retry") as any[];
  const failovers = events.filter((e) => e.phase === "committee.failover") as any[];

  assert.ok(retries.length >= 1, "same-model retry emitted for transient empty");
  assert.equal(retries[0].model, "m/a:free", "retry is on the same model");
  assert.equal(failovers.length, 0, "no failover — same-model retry succeeded");

  assert.equal(result?.status, "complete", "run completes via same-model retry");
  assert.ok(result!.rawOutputs["m/a:free"], "output recorded under the original model");
  assert.ok(result!.retries && result!.retries.length >= 1, "retry recorded in result metadata");
});

test("same-model retry: model-specific failure (tool-call) skips same-model retry, goes straight to failover", async () => {
  const provider = new FailoverProvider();
  provider.toolCallModels.add("m/a:free");
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  // Tool-call output is model-specific — should NOT retry the same model.
  const retries = events.filter((e) => e.phase === "committee.retry") as any[];
  const failovers = events.filter((e) => e.phase === "committee.failover") as any[];

  assert.equal(retries.length, 0, "no same-model retry for model-specific failure");
  assert.ok(failovers.length >= 1, "failover triggered directly for tool-call output");

  assert.equal(result?.status, "complete", "run completes via failover");
  assert.ok(!result!.rawOutputs["m/a:free"], "tool-call model not in rawOutputs");
});

test("aggregator same-model retry: truncation triggers retry with raised budget before failover", async () => {
  // A provider where the aggregator truncates at 8192 but succeeds at 16384.
  class AggBudgetProvider implements LLMProvider {
    calls: { model: string; maxTokens: number }[] = [];

    async *chat(messages: ProviderMessage[], options: ProviderChatOptions): AsyncIterable<ProviderEvent> {
      const system = String(messages[0]?.content ?? "");
      const isAggregator = system.includes("ONLY a JSON object");
      const model = (options as { model: string }).model;
      const maxTokens = (options as { maxTokens?: number }).maxTokens ?? 8192;
      this.calls.push({ model, maxTokens });
      if (isAggregator) {
        if (model === "m/agg" && maxTokens < 16384) {
          // Truncate: produce only reasoning, hit token limit.
          yield { type: "reasoning.delta", data: { text: `We need to produce a single deduplicated prioritized task list as JSON. `.repeat(100) } };
          yield { type: "finish", data: { finishReason: "length", model } };
          return;
        }
        // Enough tokens — produce JSON.
        yield { type: "text.delta", data: { text: AGG_JSON } };
        return;
      }
      yield { type: "text.delta", data: { text: `findings from ${model}` } };
    }

    async listModels() {
      return {
        free: [
          { id: "m/a:free", name: "A", pricing: { prompt: "0", completion: "0" } },
          { id: "m/b:free", name: "B", pricing: { prompt: "0", completion: "0" } },
          { id: "m/spare1:free", name: "Spare1", pricing: { prompt: "0", completion: "0" } },
          { id: "m/spare2:free", name: "Spare2", pricing: { prompt: "0", completion: "0" } },
          { id: "m/agg", name: "Agg", pricing: { prompt: "0", completion: "0" } },
        ] as any,
        paid: [],
      };
    }
  }

  const provider = new AggBudgetProvider();
  const cfg = config();

  const { events, result } = await drain(runReview({ config: cfg, workspace, provider, triggeredBy: "manual" }));

  const retries = events.filter((e) => e.phase === "aggregator.retry") as any[];
  const failovers = events.filter((e) => e.phase === "aggregator.failover") as any[];

  assert.ok(retries.length >= 1, "aggregator same-model retry emitted for truncation");
  assert.equal(retries[0].model, "m/agg", "retry is on the same judge model");
  assert.equal(retries[0].maxTokens, 16384, "retry uses raised budget");
  assert.match(retries[0].reason, /token limit/i, "retry reason mentions token limit");

  assert.equal(failovers.length, 0, "no aggregator failover — same-model retry succeeded");

  assert.equal(result?.status, "complete", "run completes via same-model retry");
  assert.equal(result!.aggregatorModel, "m/agg", "aggregatorModel unchanged (no failover)");
  assert.ok(result!.aggregatorRetries && result!.aggregatorRetries.length >= 1, "retry recorded in result metadata");
  assert.ok(!result!.aggregatorFailovers || result!.aggregatorFailovers.length === 0, "no failovers recorded");
});
