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
      seenModels.push(body.model);
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

  it("fails over to pool model when a non-pool model is rate limited", async () => {
    seenModels.length = 0;
    handler = (_req, res, body) => {
      if (body.model === "custom/out-of-pool:free") {
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

    const provider = new OpenRouterProvider({ apiKey: "k", baseUrl });
    const events = await collect(
      provider.chat([{ role: "user", content: "hi" }], { model: "custom/out-of-pool:free", tools: [] }),
    );

    const types = events.map((e) => e.type);
    assert.ok(types.includes("text.delta"), `expected text after failover, got: ${types.join(",")}`);
    assert.ok(types.includes("finish"));
    assert.equal(seenModels[0], "custom/out-of-pool:free");
    assert.ok(DEFAULT_FREE_POOL.includes(seenModels[1]), `failover should use a pool model, got ${seenModels[1]}`);
  });
});
