import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withHeartbeat } from "../src/server/agent/engine.js";
import type { ProviderEvent } from "../src/types.js";

/**
 * Tests for the synthetic progress heartbeat (Phase 5 "Harden" companion).
 *
 * `withHeartbeat` wraps a provider async iterable so that while the provider
 * is silent (its `.next()` hasn't resolved), a heartbeat marker is yielded
 * every `intervalMs`. This is what lets the UI show "Working… 23s · waiting
 * for model response" during the pre-headers hang and mid-stream stalls —
 * the two failure modes real reasoning/thought deltas can't cover (zero
 * bytes arrive during a true stall).
 */
describe("withHeartbeat — synthetic progress", () => {
  it("yields heartbeats while the provider is silent, then the real event", async () => {
    const events: Array<ProviderEvent | { __heartbeat: true; elapsedMs: number }> = [];
    const signal = new AbortController().signal;
    async function* slowProvider(): AsyncIterable<ProviderEvent> {
      // Stall longer than the heartbeat interval before emitting.
      await sleep(60);
      yield { type: "text.delta", data: { text: "hi" } };
      yield { type: "finish", data: { finishReason: "stop", model: "m" } };
    }
    for await (const e of withHeartbeat(slowProvider(), 20, signal)) {
      events.push(e);
    }
    const heartbeats = events.filter((e) => (e as any).__heartbeat);
    // 60ms stall with 20ms interval → at least 2 heartbeats before the token.
    assert.ok(heartbeats.length >= 2, `expected >=2 heartbeats, got ${heartbeats.length}`);
    // The real text.delta must arrive after the heartbeats.
    const firstTextIdx = events.findIndex((e) => (e as ProviderEvent).type === "text.delta");
    const lastHbBeforeText = (() => {
      let idx = -1;
      for (let i = 0; i < firstTextIdx; i++) if ((events[i] as any).__heartbeat) idx = i;
      return idx;
    })();
    assert.ok(lastHbBeforeText >= 0, "expected a heartbeat before the first token");
    assert.ok(lastHbBeforeText < firstTextIdx);
    // The finish event is still delivered.
    assert.ok(events.some((e) => (e as ProviderEvent).type === "finish"));
  });

  it("does not call .next() concurrently (no overlapping heartbeats)", async () => {
    // If the wrapper called .next() again while the previous one was pending,
    // most async iterators throw. We verify the stall case works cleanly.
    let nextCalls = 0;
    let nextInFlight = 0;
    let maxInFlight = 0;
    async function* strictProvider(): AsyncIterable<ProviderEvent> {
      nextCalls++;
      nextInFlight++;
      maxInFlight = Math.max(maxInFlight, nextInFlight);
      await sleep(50);
      nextInFlight--;
      yield { type: "text.delta", data: { text: "x" } };
      nextCalls++;
      nextInFlight++;
      maxInFlight = Math.max(maxInFlight, nextInFlight);
      await sleep(10);
      nextInFlight--;
      yield { type: "finish", data: { finishReason: "stop", model: "m" } };
    }
    const signal = new AbortController().signal;
    const out: any[] = [];
    for await (const e of withHeartbeat(strictProvider(), 15, signal)) out.push(e);
    assert.equal(maxInFlight, 1, "iter.next() must never be called concurrently");
    assert.equal(nextCalls, 2);
  });

  it("stops immediately when the signal aborts", async () => {
    const ac = new AbortController();
    let providerReturned = false;
    async function* hangingProvider(): AsyncIterable<ProviderEvent> {
      try {
        // Sleep that respects the abort signal — like the real provider,
        // whose fetch/reader.read reject immediately on abort.
        await new Promise<void>((_, reject) => {
          const t = setTimeout(() => resolve(), 10_000);
          ac.signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
          function resolve() { clearTimeout(t); }
        });
        yield { type: "text.delta", data: { text: "never" } };
      } catch {
        // aborted — fall through to finally
      } finally {
        providerReturned = true;
      }
    }
    const iter = withHeartbeat(hangingProvider(), 10, ac.signal)[Symbol.asyncIterator]();
    // Abort shortly after starting — the next .next() race should exit.
    setTimeout(() => ac.abort(), 5);
    // Drain to completion (the wrapper should return after abort).
    while (!(await iter.next()).done) { /* drain */ }
    assert.ok(providerReturned, "provider generator's finally must run on abort");
  });

  it("passes real events through unchanged when there is no stall", async () => {
    async function* fastProvider(): AsyncIterable<ProviderEvent> {
      yield { type: "text.delta", data: { text: "a" } };
      yield { type: "text.delta", data: { text: "b" } };
      yield { type: "finish", data: { finishReason: "stop", model: "m" } };
    }
    const signal = new AbortController().signal;
    const out: any[] = [];
    for await (const e of withHeartbeat(fastProvider(), 1000, signal)) out.push(e);
    // No heartbeats — events arrive faster than the interval.
    assert.equal(out.filter((e) => e.__heartbeat).length, 0);
    assert.deepEqual(
      out.map((e) => e.type),
      ["text.delta", "text.delta", "finish"],
    );
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
