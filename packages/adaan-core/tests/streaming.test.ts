import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OpenRouterProvider, DEFAULT_FREE_POOL } from "../src/server/agent/providers/openrouter.js";
import type { ProviderEvent } from "../src/types.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: any) => void;

let server: http.Server;
let baseUrl: string;
let handler: Handler;
const seenModels: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      // Only track chat-completion requests, not /models catalog GETs.
      if (!req.url?.endsWith("/models")) seenModels.push(body.model);
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function sse(res: http.ServerResponse, chunks: string[], delayMs = 0) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  let i = 0;
  const next = () => {
    if (i >= chunks.length) return;
    res.write(chunks[i++]);
    if (i < chunks.length) setTimeout(next, delayMs);
  };
  next();
}

function toolCallChunk(name: string, args: string) {
  return `data: ${JSON.stringify({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] } }],
  })}\n\n`;
}

async function collect(gen: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("OpenRouterProvider — SSE streaming", () => {
  it("emits tool_call.complete before finish when stream ends with [DONE]", async () => {
    handler = (_req, res) => {
      sse(res, [
        toolCallChunk("list_files", '{"path":"."}'),
        "data: [DONE]\n\n",
        // keep the socket open briefly after [DONE] like real servers do
      ]);
      setTimeout(() => res.end(), 50);
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: DEFAULT_FREE_POOL[0], tools: [] }),
    );

    const types = events.map((e) => e.type);
    assert.ok(types.includes("tool_call.complete"), `expected tool_call.complete, got: ${types.join(",")}`);
    const completeIdx = types.indexOf("tool_call.complete");
    const finishIdx = types.indexOf("finish");
    assert.ok(completeIdx < finishIdx, "tool_call.complete must come before finish");

    const complete = events[completeIdx].data as { toolName: string; arguments: string };
    assert.equal(complete.toolName, "list_files");
    assert.equal(complete.arguments, '{"path":"."}');
  });

  it("emits tool_call.start exactly once", async () => {
    handler = (_req, res) => {
      sse(res, [
        // name split across two chunks — start must still fire only once
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: "{}" } }] } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
      setTimeout(() => res.end(), 50);
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: DEFAULT_FREE_POOL[0], tools: [] }),
    );

    const starts = events.filter((e) => e.type === "tool_call.start");
    assert.equal(starts.length, 1);
    assert.equal((starts[0].data as { toolName: string }).toolName, "read_file");
  });

  it("separates parallel tool calls when index is omitted (different ids)", async () => {
    // Some free models emit multiple tool calls without an index field,
    // relying on id to distinguish them. Without proper handling, both
    // calls' arguments get concatenated at index 0, producing malformed JSON.
    handler = (_req, res) => {
      sse(res, [
        // First tool call — no index, id=call_a
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "call_a", function: { name: "write_file", arguments: '{"path":"a.py"' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "call_a", function: { arguments: ',"content":"x"}' } }] } }] })}\n\n`,
        // Second tool call — no index, id=call_b (different!)
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "call_b", function: { name: "write_file", arguments: '{"path":"b.py","content":"y"}' } }] } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
      setTimeout(() => res.end(), 50);
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: DEFAULT_FREE_POOL[0], tools: [] }),
    );

    const completes = events.filter((e) => e.type === "tool_call.complete");
    assert.equal(completes.length, 2, "should emit two separate tool_call.complete events");

    const args0 = (completes[0].data as { arguments: string }).arguments;
    const args1 = (completes[1].data as { arguments: string }).arguments;

    // Both should be valid JSON, not concatenated
    assert.doesNotThrow(() => JSON.parse(args0), `first args should be valid JSON: ${args0}`);
    assert.doesNotThrow(() => JSON.parse(args1), `second args should be valid JSON: ${args1}`);

    const parsed0 = JSON.parse(args0);
    const parsed1 = JSON.parse(args1);
    assert.equal(parsed0.path, "a.py");
    assert.equal(parsed1.path, "b.py");
  });

  it("keep-alive comments do not reset the idle timer (no infinite hang)", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
      // Stall: only keep-alive comments forever, never [DONE], never end.
      const iv = setInterval(() => res.write(": OPENROUTER PROCESSING\n\n"), 30);
      res.on("close", () => clearInterval(iv));
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl, freePool: [], idleTimeoutMs: 300 });
    const start = Date.now();
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "stalled/model:free", tools: [] }),
    );
    const elapsed = Date.now() - start;

    const last = events[events.length - 1];
    assert.equal(last.type, "error", "stalled stream must surface an error, not hang");
    assert.match((last.data as { message: string }).message, /idle|timed out/i);
    assert.ok(elapsed < 5000, `should time out quickly, took ${elapsed}ms`);
  });

  it("surfaces OPENROUTER PROCESSING keep-alives as provider.queued events", async () => {
    handler = (_req, res) => {
      // Model is queued at the provider — keep-alives arrive, then the real
      // stream starts. The keep-alives must be surfaced (not silently
      // discarded) so the engine can show "queued at provider" to the user.
      sse(res, [
        ": OPENROUTER PROCESSING\n\n",
        ": OPENROUTER PROCESSING\n\n",
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
      setTimeout(() => res.end(), 50);
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl, freePool: [] });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "queued/model:free", tools: [] }),
    );

    const queued = events.filter((e) => e.type === "provider.queued");
    assert.ok(queued.length >= 2, `expected >=2 provider.queued events, got ${queued.length}`);
    // They must arrive before the first text.delta.
    const firstText = events.findIndex((e) => e.type === "text.delta");
    assert.ok(firstText > 0, "expected a text.delta event");
    const lastQueuedBeforeText = (() => {
      let idx = -1;
      for (let i = 0; i < firstText; i++) if (events[i].type === "provider.queued") idx = i;
      return idx;
    })();
    assert.ok(lastQueuedBeforeText >= 0 && lastQueuedBeforeText < firstText);
    // The real stream still completes.
    assert.ok(events.some((e) => e.type === "finish"));
  });

  it("does not emit provider.queued for non-PROCESSING SSE comments", async () => {
    handler = (_req, res) => {
      // A generic SSE comment (not an OpenRouter PROCESSING keep-alive).
      sse(res, [
        ": some other comment\n\n",
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
      setTimeout(() => res.end(), 50);
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl, freePool: [] });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "comment/model:free", tools: [] }),
    );
    assert.equal(events.filter((e) => e.type === "provider.queued").length, 0);
  });

  it("streams reasoning.delta from delta.reasoning (OpenRouter native field)", async () => {
    handler = (_req, res) => {
      sse(res, [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "Let me think" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning: " about this" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "The answer is 7" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
      setTimeout(() => res.end(), 50);
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl, freePool: [] });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "reasoning/model:free", tools: [] }),
    );

    const reasoning = events.filter((e) => e.type === "reasoning.delta");
    assert.equal(reasoning.length, 2, "expected 2 reasoning.delta events");
    const combined = reasoning.map((e) => (e.data as { text: string }).text).join("");
    assert.equal(combined, "Let me think about this");
    // Reasoning must arrive before the text content.
    const firstText = events.findIndex((e) => e.type === "text.delta");
    const lastReasoning = (() => {
      let idx = -1;
      for (let i = 0; i < firstText; i++) if (events[i].type === "reasoning.delta") idx = i;
      return idx;
    })();
    assert.ok(lastReasoning >= 0 && lastReasoning < firstText);
    assert.ok(events.some((e) => e.type === "finish"));
  });

  it("streams reasoning.delta from delta.reasoning_content (OpenAI/DeepSeek-compatible)", async () => {
    handler = (_req, res) => {
      sse(res, [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Step 1" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Done" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
      setTimeout(() => res.end(), 50);
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl, freePool: [] });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "deepseek/model:free", tools: [] }),
    );

    const reasoning = events.filter((e) => e.type === "reasoning.delta");
    assert.equal(reasoning.length, 1);
    assert.equal((reasoning[0].data as { text: string }).text, "Step 1");
  });

  it("does not emit reasoning.delta for non-reasoning models", async () => {
    handler = (_req, res) => {
      sse(res, [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "just text" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
      setTimeout(() => res.end(), 50);
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl, freePool: [] });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "plain/model:free", tools: [] }),
    );
    assert.equal(events.filter((e) => e.type === "reasoning.delta").length, 0);
  });

  it("partial data: line in buffer does NOT reset idle timer (no infinite hang)", async () => {
    // Simulates a server that stalls mid-chunk: it writes a partial
    // "data:" line (no newline) and then keeps the connection alive
    // with TCP keep-alives but never sends more data. The old heuristic
    // (buffer.startsWith("data:")) would re-arm the idle timer on every
    // read, hanging forever. The fix: only complete data: lines count.
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // Write a partial data: line — no trailing newline, never completed.
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"hi");
      // Never send the rest. Never send [DONE]. Never end.
      // The connection stays open but no complete lines arrive.
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl, freePool: [], idleTimeoutMs: 300 });
    const start = Date.now();
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "stalled/partial:free", tools: [] }),
    );
    const elapsed = Date.now() - start;

    const last = events[events.length - 1];
    assert.equal(last.type, "error", "partial-line stall must surface an error, not hang");
    assert.ok(elapsed < 5000, `should time out quickly, took ${elapsed}ms`);
  });

  it("retries the same model once on a transient 429 before failing over", async () => {
    seenModels.length = 0;
    let calls = 0;
    handler = (_req, res, body) => {
      if (body.model === "custom/out-of-pool:free") {
        calls++;
        // First hit: 429. Second hit (same-model retry): also 429. After that
        // we fail over to a pool model, which succeeds.
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
      sse(res, [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
      setTimeout(() => res.end(), 50);
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl, retryDelayMs: 0 });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "custom/out-of-pool:free", tools: [] }),
    );

    const types = events.map((e) => e.type);
    assert.ok(types.includes("text.delta"), `expected text after failover, got: ${types.join(",")}`);
    assert.ok(types.includes("finish"));
    // The selected model is tried twice (initial + same-model retry) before
    // bailing to the pool.
    assert.equal(seenModels[0], "custom/out-of-pool:free");
    assert.equal(seenModels[1], "custom/out-of-pool:free");
    assert.ok(DEFAULT_FREE_POOL.includes(seenModels[2]), `failover should use a pool model, got ${seenModels[2]}`);
    assert.equal(calls, 2, "selected model should have been hit twice (initial + retry)");
    // A fallback event must surface the swap so it isn't silent.
    const fallback = events.find((e) => e.type === "model.fallback");
    assert.ok(fallback, "expected a model.fallback event");
    const fb = fallback!.data as { from: string; to: string };
    assert.equal(fb.from, "custom/out-of-pool:free");
    assert.ok(DEFAULT_FREE_POOL.includes(fb.to));
  });

  it("succeeds on the same-model retry without failing over (no fallback event)", async () => {
    seenModels.length = 0;
    let calls = 0;
    handler = (_req, res, body) => {
      if (body.model === "flaky/model:free") {
        calls++;
        if (calls === 1) {
          // Transient 429 on the first hit only — the retry succeeds.
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "rate limited" }));
          return;
        }
      }
      sse(res, [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
      setTimeout(() => res.end(), 50);
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl, retryDelayMs: 0 });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "flaky/model:free", tools: [] }),
    );

    const types = events.map((e) => e.type);
    assert.ok(types.includes("text.delta"));
    assert.ok(types.includes("finish"));
    // Only the selected model was ever hit — no failover.
    assert.deepEqual(seenModels, ["flaky/model:free", "flaky/model:free"]);
    assert.ok(!types.includes("model.fallback"), "no fallback event when the retry succeeds");
  });

  it("fails over immediately on 402 (no same-model retry) and emits fallback", async () => {
    seenModels.length = 0;
    handler = (_req, res, body) => {
      if (body.model === "cohere/north-mini-code:free") {
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Insufficient balance", code: 402 } }));
        return;
      }
      sse(res, [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
      setTimeout(() => res.end(), 50);
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl, retryDelayMs: 0 });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "cohere/north-mini-code:free", tools: [] }),
    );

    const types = events.map((e) => e.type);
    assert.ok(types.includes("text.delta"));
    // 402 is not transient — no same-model retry, straight to the pool.
    assert.equal(seenModels[0], "cohere/north-mini-code:free");
    assert.ok(DEFAULT_FREE_POOL.includes(seenModels[1]), `failover should use a pool model, got ${seenModels[1]}`);
    assert.ok(events.some((e) => e.type === "model.fallback"));
  });

  it("fails over to pool model when OpenRouter reports the model unavailable for free (404)", async () => {
    seenModels.length = 0;
    handler = (_req, res, body) => {
      if (body.model === "minimax/minimax-m3:free") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "This model is unavailable for free. The paid version is available now - use this slug instead: deepseek/deepseek-r1",
              code: 404,
            },
          }),
        );
        return;
      }
      sse(res, [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
      setTimeout(() => res.end(), 50);
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "minimax/minimax-m3:free", tools: [] }),
    );

    const types = events.map((e) => e.type);
    assert.ok(!types.includes("error"), `should fail over silently, got: ${types.join(",")}`);
    assert.ok(types.includes("text.delta"), `expected text after failover, got: ${types.join(",")}`);
    assert.equal(seenModels[0], "minimax/minimax-m3:free");
    assert.ok(DEFAULT_FREE_POOL.includes(seenModels[1]), `failover should use a pool model, got ${seenModels[1]}`);
  });

  it("does not fail over on a plain 404 unrelated to model availability", async () => {
    seenModels.length = 0;
    handler = (_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found", code: 404 } }));
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl, freePool: [] });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "some/model:free", tools: [] }),
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
  });

  it("fails over on 402 'Insufficient balance' (backing provider out of credits)", async () => {
    seenModels.length = 0;
    handler = (_req, res, body) => {
      if (body.model === "cohere/north-mini-code:free") {
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Provider returned error",
              code: 402,
              metadata: {
                raw: '{"error":"Insufficient balance","reason":"model_access_denied"}',
                provider_name: "GMICloud",
                is_byok: false,
              },
            },
          }),
        );
        return;
      }
      sse(res, [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
      setTimeout(() => res.end(), 50);
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "cohere/north-mini-code:free", tools: [] }),
    );

    const types = events.map((e) => e.type);
    assert.ok(!types.includes("error"), `should fail over silently, got: ${types.join(",")}`);
    assert.ok(types.includes("text.delta"), `expected text after failover, got: ${types.join(",")}`);
    assert.equal(seenModels[0], "cohere/north-mini-code:free");
    assert.ok(DEFAULT_FREE_POOL.includes(seenModels[1]), `failover should use a pool model, got ${seenModels[1]}`);
  });

  it("reports allFreeModelsExhausted once the static pool and live catalog are both exhausted", async () => {
    seenModels.length = 0;
    handler = (req, res, body) => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              {
                id: "live/only-free-model:free",
                name: "Live Free",
                context_length: 8192,
                pricing: { prompt: "0", completion: "0" },
                supported_parameters: ["tools"],
              },
            ],
          }),
        );
        return;
      }
      // Every chat completion attempt — regardless of model — is unavailable.
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "This model is unavailable for free. Use paid instead.", code: 404 },
        }),
      );
    };

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl, freePool: ["only/pool-model:free"] });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "start/model:free", tools: [] }),
    );

    const last = events[events.length - 1];
    assert.equal(last.type, "error");
    const data = last.data as { allFreeModelsExhausted?: boolean; triedModels?: string[] };
    assert.equal(data.allFreeModelsExhausted, true);
    assert.ok(data.triedModels?.includes("start/model:free"));
    assert.ok(data.triedModels?.includes("only/pool-model:free"));
    assert.ok(data.triedModels?.includes("live/only-free-model:free"), `should have tried the live-catalog model too, got: ${data.triedModels}`);
  });
});
