import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ReviewRunManager } from "../src/server/review/run-manager.js";
import { reviewStore } from "../src/server/review/store.js";
import { sleepGuard } from "../src/server/review/sleep-guard.js";
import type { LLMProvider } from "../src/server/agent/provider.js";
import type { Workspace } from "../src/server/workspace.js";
import type { ReviewConfig, ReviewProgress, ReviewResult } from "../src/server/review/types.js";
import type { ProviderMessage, ProviderChatOptions } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const AGG_JSON = JSON.stringify({
  tasks: [
    {
      priority: "P1",
      issue: "Fake finding",
      mainFinding: "This is a synthetic finding for tests only",
      fix: "Apply the synthetic fix to the fake code",
      lenses: ["TEST"],
      reviewers: ["Synthetic"],
      impact: "Keeps the test suite green forever",
      issueBody: "## Summary\nfake",
      labels: ["priority:p1"],
    },
  ],
});

interface ChatCall { model: string; isAggregator: boolean }

/** Deterministic provider: committee models stream two chunks (optionally
 *  gated between them); the aggregator emits the strict JSON task list. */
class FakeProvider implements LLMProvider {
  calls: ChatCall[] = [];
  /** When set, committee chats emit chunk 1, then wait on this promise. */
  gate: Promise<void> | null = null;

  async *chat(messages: ProviderMessage[], options: ProviderChatOptions): AsyncIterable<any> {
    const system = String(messages[0]?.content ?? "");
    const isAggregator = system.includes("ONLY a JSON object");
    const model = (options as { model: string }).model;
    this.calls.push({ model, isAggregator });
    if (isAggregator) {
      yield { type: "text.delta", data: { text: AGG_JSON } };
      return;
    }
    yield { type: "text.delta", data: { text: `output-1-for-${model}` } };
    if (this.gate) await this.gate;
    yield { type: "text.delta", data: { text: ` output-2-for-${model}` } };
  }

  async listModels() {
    return {
      free: [
        { id: "m/a:free", name: "A", pricing: { prompt: "0", completion: "0" } },
        { id: "m/b:free", name: "B", pricing: { prompt: "0", completion: "0" } },
        { id: "m/agg", name: "Agg", pricing: { prompt: "0", completion: "0" } },
      ] as any,
      paid: [],
    };
  }
}

const workspace = {
  rootPath: "/tmp/rev-ws",
  listTree: async () => [],
  readFile: async () => { throw new Error("no files"); },
} as unknown as Workspace;

function config(overrides: Partial<ReviewConfig> = {}): ReviewConfig {
  return {
    id: `cfg-${Math.random().toString(36).slice(2, 8)}`,
    name: "Test Review",
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

/** Collect events of an attached subscription until a terminal phase. */
async function drain(sub: { replay: ReviewProgress[]; live(fn: (ev: ReviewProgress) => void): () => void }): Promise<ReviewProgress[]> {
  const events: ReviewProgress[] = [...sub.replay];
  if (events.some((e) => ["complete", "error", "cancelled"].includes(e.phase))) return events;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("drain timeout")), 15_000);
    sub.live((ev) => {
      events.push(ev);
      if (["complete", "error", "cancelled"].includes(ev.phase)) {
        clearTimeout(timeout);
        resolve(events);
      }
    });
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

let tmpDir: string;
before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-rm-"));
  reviewStore._configure({ filePath: path.join(tmpDir, "reviews.json") });
  await reviewStore.load();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("run manager: full lifecycle — run.started first, terminal last, persisted", async () => {
  const mgr = new ReviewRunManager();
  const provider = new FakeProvider();
  const cfg = config();

  const { resultId } = mgr.startReviewRun({ config: cfg, workspace, provider, triggeredBy: "manual" });

  // Active while running.
  await waitFor(() => mgr.activeRuns().length === 1);
  assert.equal(mgr.activeRuns()[0].resultId, resultId);

  const sub = mgr.subscribe(resultId)!;
  assert.ok(sub, "subscribe succeeds for a live run");
  const events = await drain(sub);

  assert.equal(events[0].phase, "run.started");
  assert.equal((events[0] as any).runId, resultId);
  assert.equal(events[events.length - 1].phase, "complete");
  assert.ok(events.some((e) => e.phase === "committee.delta"));
  assert.ok(events.some((e) => e.phase === "aggregator.delta" || e.phase === "aggregator"));

  // Both reviewers were called once, and the aggregator once.
  assert.equal(provider.calls.filter((c) => !c.isAggregator).length, 2);
  assert.equal(provider.calls.filter((c) => c.isAggregator).length, 1);

  // Result persisted as complete with tasks.
  const stored = reviewStore.getResult(resultId);
  assert.ok(stored);
  assert.equal(stored.status, "complete");
  assert.equal(stored.tasks.length, 1);
  assert.equal(stored.rawOutputs["m/a:free"], "output-1-for-m/a:free output-2-for-m/a:free");

  // Done runs leave the active list.
  await waitFor(() => mgr.activeRuns().length === 0);
});

test("run manager: mid-run attach replays buffered state, then streams live", async () => {
  const mgr = new ReviewRunManager();
  const provider = new FakeProvider();
  let releaseGate!: () => void;
  provider.gate = new Promise<void>((r) => { releaseGate = r; });
  const cfg = config({ reviewerModels: ["m/a:free"] });

  const { resultId } = mgr.startReviewRun({ config: cfg, workspace, provider, triggeredBy: "manual" });

  // Wait until the first reviewer chunk has been buffered server-side.
  await waitFor(() =>
    !!mgr.subscribe(resultId)?.replay.some((e) => e.phase === "committee.delta"),
  );

  // Attach mid-run: replay must contain the state so far.
  const replay = mgr.subscribe(resultId)!.replay;
  assert.equal(replay[0].phase, "run.started");
  const idxStart = replay.findIndex((e) => e.phase === "committee.start");
  const idxDelta = replay.findIndex((e) => e.phase === "committee.delta");
  assert.ok(idxStart > 0 && idxDelta > idxStart, "start precedes first delta in replay");

  // Now attach a live listener and let the run finish.
  const sub = mgr.subscribe(resultId)!;
  const eventsPromise = drain(sub);
  releaseGate();
  const events = await eventsPromise;
  const replayedDelta = events.filter((e) => e.phase === "committee.delta");
  // Replay had the first chunk; the live tail delivered the second.
  assert.ok(replayedDelta.some((e) => (e as any).text.includes("output-1-for-m/a:free")));
  assert.ok(replayedDelta.some((e) => (e as any).text.includes("output-2-for-m/a:free")));
  assert.equal(events[events.length - 1].phase, "complete");

  const stored = reviewStore.getResult(resultId)!;
  assert.equal(stored.rawOutputs["m/a:free"], "output-1-for-m/a:free output-2-for-m/a:free");
});

test("run manager: resume skips reviewers with surviving outputs", async () => {
  const mgr = new ReviewRunManager();
  const provider = new FakeProvider();
  const cfg = config({ reviewerModels: ["m/a:free", "m/b:free"] });
  await reviewStore.saveConfig(cfg);

  // Seed an interrupted result with one good output and one errored.
  const interrupted: ReviewResult = {
    id: "rev-interrupted-1",
    configId: cfg.id,
    configName: cfg.name,
    startedAt: new Date().toISOString(),
    expertise: cfg.expertise,
    reviewerModels: cfg.reviewerModels,
    aggregatorModel: cfg.aggregatorModel,
    tasks: [],
    rawOutputs: {
      "m/a:free": "preserved output for a",
      "m/b:free": "[REVIEWER ERROR: timeout]",
    },
    status: "interrupted",
    error: "Server stopped before this run finished — it can be resumed.",
    triggeredBy: "manual",
    completedAt: new Date().toISOString(),
  };
  await reviewStore.addResult(interrupted);

  const started = await mgr.resumeRun("rev-interrupted-1", provider, workspace);
  assert.ok(started, "resume accepted");
  assert.equal(started!.resultId, "rev-interrupted-1", "same result id is reused");

  const sub = mgr.subscribe(started!.resultId)!;
  const events = await drain(sub);
  assert.equal((events[0] as any).resumed, true, "run.started flags a resumed run");
  assert.equal(events[events.length - 1].phase, "complete");

  // m/a was NOT re-called (its output survived); m/b WAS re-called (errored).
  const committeeCalls = provider.calls.filter((c) => !c.isAggregator).map((c) => c.model);
  assert.ok(!committeeCalls.includes("m/a:free"), "m/a skipped");
  assert.ok(committeeCalls.includes("m/b:free"), "m/b re-run");
  assert.equal(provider.calls.filter((c) => c.isAggregator).length, 1);

  const stored = reviewStore.getResult("rev-interrupted-1")!;
  assert.equal(stored.status, "complete");
  assert.equal(stored.rawOutputs["m/a:free"], "preserved output for a");
  assert.ok(stored.rawOutputs["m/b:free"].includes("output-1-for-m/b:free"));
});

test("run manager: resume refused when nothing survives", async () => {
  const mgr = new ReviewRunManager();
  const provider = new FakeProvider();
  const cfg = config();
  await reviewStore.saveConfig(cfg);
  await reviewStore.addResult({
    id: "rev-dead",
    configId: cfg.id,
    configName: cfg.name,
    startedAt: new Date().toISOString(),
    expertise: cfg.expertise,
    reviewerModels: [],
    aggregatorModel: "m/agg",
    tasks: [],
    rawOutputs: { "m/a:free": "[REVIEWER ERROR: boom]" },
    status: "interrupted",
    triggeredBy: "manual",
  });
  const started = await mgr.resumeRun("rev-dead", provider, workspace);
  assert.equal(started, null);
});

test("reviewStore.load: zombie running results become interrupted, not dropped", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-zombie-"));
  const file = path.join(dir, "reviews.json");
  const { ReviewStore } = await import("../src/server/review/store.js");
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      configs: [],
      results: [
        { id: "z1", configId: "c", configName: "C", startedAt: "x", expertise: "top-1%", reviewerModels: [], aggregatorModel: "", tasks: [], rawOutputs: { a: "partial" }, status: "running", triggeredBy: "manual" },
        { id: "z2", configId: "c", configName: "C", startedAt: "x", expertise: "top-1%", reviewerModels: [], aggregatorModel: "", tasks: [], rawOutputs: {}, status: "complete", triggeredBy: "manual" },
      ],
      taskLists: {},
    }),
  );
  const store = new ReviewStore();
  store._configure({ filePath: file });
  await store.load();
  const results = store.getResults();
  assert.equal(results.length, 2, "zombie kept for resumability");
  const z1 = results.find((r) => r.id === "z1")!;
  assert.equal(z1.status, "interrupted");
  assert.match(z1.error ?? "", /resumed/i);
  assert.equal(z1.rawOutputs.a, "partial", "partial reviewer output survives");
  assert.equal(results.find((r) => r.id === "z2")!.status, "complete");
  await fs.rm(dir, { recursive: true, force: true });
});

test("sleepGuard: refcounting; spawns caffeinate only on macOS", async () => {
  sleepGuard._reset();
  const real = sleepGuard.platform;

  // Non-macOS: no sidecar, but refcount semantics still hold.
  sleepGuard.platform = "linux";
  sleepGuard.acquire();
  sleepGuard.acquire();
  assert.equal(sleepGuard.active, true);
  assert.equal(sleepGuard.spawned, false);
  sleepGuard.release();
  assert.equal(sleepGuard.active, true, "one holder left");
  sleepGuard.release();
  assert.equal(sleepGuard.active, false);

  if (os.platform() === "darwin") {
    sleepGuard.platform = "darwin";
    sleepGuard.acquire();
    assert.equal(sleepGuard.spawned, true, "caffeinate sidecar spawned");
    sleepGuard.release();
    await waitFor(() => !sleepGuard.spawned, 2_000);
    assert.equal(sleepGuard.spawned, false, "sidecar killed when last run releases");
  }

  sleepGuard.platform = real;
});

// ---------------------------------------------------------------------------
// Provider-queue visibility: provider.queued events must be forwarded as
// committee.queued / aggregator.queued so the UI can show "queued at provider".
// ---------------------------------------------------------------------------

/** FakeProvider variant that emits provider.queued before AND after streaming
 *  text, simulating OpenRouter's interspersed PROCESSING keep-alives. */
class QueuedFakeProvider implements LLMProvider {
  calls: ChatCall[] = [];

  async *chat(messages: ProviderMessage[], options: ProviderChatOptions): AsyncIterable<any> {
    const system = String(messages[0]?.content ?? "");
    const isAggregator = system.includes("ONLY a JSON object");
    const model = (options as { model: string }).model;
    this.calls.push({ model, isAggregator });
    // Simulate the model being queued at the provider before the stream starts.
    yield { type: "provider.queued", data: {} };
    if (isAggregator) {
      // Aggregator: reasoning, then a stray keep-alive, then JSON text, then
      // another stray keep-alive. The keep-alives after reasoning/text must
      // NOT produce aggregator.queued events.
      yield { type: "reasoning.delta", data: { text: "Thinking…" } };
      yield { type: "provider.queued", data: {} }; // must be suppressed
      yield { type: "text.delta", data: { text: AGG_JSON } };
      yield { type: "provider.queued", data: {} }; // must be suppressed
      return;
    }
    // Reviewer: text, then a stray keep-alive. The keep-alive after text must
    // NOT produce a committee.queued event.
    yield { type: "text.delta", data: { text: `output-for-${model}` } };
    yield { type: "provider.queued", data: {} }; // must be suppressed
  }

  async listModels() {
    return {
      free: [
        { id: "m/a:free", name: "A", pricing: { prompt: "0", completion: "0" } },
        { id: "m/b:free", name: "B", pricing: { prompt: "0", completion: "0" } },
        { id: "m/agg", name: "Agg", pricing: { prompt: "0", completion: "0" } },
      ] as any,
      paid: [],
    };
  }
}

test("run manager: provider.queued forwarded as committee.queued and aggregator.queued", async () => {
  const mgr = new ReviewRunManager();
  const provider = new QueuedFakeProvider();
  const cfg = config({ reviewerModels: ["m/a:free", "m/b:free"] });

  const { resultId } = mgr.startReviewRun({ config: cfg, workspace, provider, triggeredBy: "manual" });
  const sub = mgr.subscribe(resultId)!;
  const events = await drain(sub);

  // Each reviewer should have exactly ONE committee.queued event (the
  // post-text keep-alive must be suppressed), carrying model + index.
  const committeeQueued = events.filter((e) => e.phase === "committee.queued") as any[];
  assert.equal(committeeQueued.length, 2, `expected exactly 2 committee.queued (one per reviewer), got ${committeeQueued.length}`);
  const queuedModels = new Set(committeeQueued.map((e) => e.model));
  assert.ok(queuedModels.has("m/a:free"), "m/a:free queued event present");
  assert.ok(queuedModels.has("m/b:free"), "m/b:free queued event present");
  // Each carries a reviewerCount.
  for (const e of committeeQueued) {
    assert.equal(e.reviewerCount, 2, "reviewerCount matches");
    assert.ok(typeof e.reviewerIndex === "number", "reviewerIndex is set");
  }

  // The aggregator should have exactly ONE aggregator.queued event — the
  // keep-alives after reasoning and after text must be suppressed.
  const aggQueued = events.filter((e) => e.phase === "aggregator.queued") as any[];
  assert.equal(aggQueued.length, 1, `expected exactly 1 aggregator.queued, got ${aggQueued.length}`);
  assert.equal(aggQueued[0].model, "m/agg", "aggregator.queued carries the judge model");

  // Queued events must arrive before their corresponding deltas.
  const firstCommitteeDelta = events.findIndex((e) => e.phase === "committee.delta");
  const firstCommitteeQueued = events.findIndex((e) => e.phase === "committee.queued");
  assert.ok(firstCommitteeQueued >= 0 && firstCommitteeQueued < firstCommitteeDelta, "committee.queued precedes committee.delta");

  const firstAggDelta = events.findIndex((e) => e.phase === "aggregator.delta");
  const firstAggQueued = events.findIndex((e) => e.phase === "aggregator.queued");
  assert.ok(firstAggQueued >= 0 && firstAggQueued < firstAggDelta, "aggregator.queued precedes aggregator.delta");

  // The run still completes successfully.
  assert.equal(events[events.length - 1].phase, "complete");
  const stored = reviewStore.getResult(resultId)!;
  assert.equal(stored.status, "complete");
  assert.equal(stored.tasks.length, 1);
});
