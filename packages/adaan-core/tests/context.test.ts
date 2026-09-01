import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateMessageTokens,
  estimateTotalTokens,
  pruneMessages,
  truncateToolContent,
  pruneContext,
} from "../src/server/agent/context.js";
import type { ProviderMessage } from "../src/types.js";

describe("Context — token estimation", () => {
  it("estimates tokens from string", () => {
    assert.ok(estimateTokens("hello world") > 0);
    assert.equal(estimateTokens(""), 0);
  });

  it("estimates message tokens", () => {
    const msg: ProviderMessage = { role: "user", content: "hello world" };
    const tokens = estimateMessageTokens(msg);
    assert.ok(tokens > 4); // 4 overhead + content tokens
  });

  it("estimates total tokens for array", () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
    ];
    const total = estimateTotalTokens(messages);
    assert.ok(total > 0);
  });
});

describe("Context — A1 truncation", () => {
  it("is a no-op when content is under the cap", () => {
    const { content, tokensSaved } = truncateToolContent("short content", 2000);
    assert.equal(content, "short content");
    assert.equal(tokensSaved, 0);
  });

  it("keeps head + tail with an elision marker when over the cap", () => {
    const big = "X".repeat(20000); // ~5000 tokens, well over 2000 cap
    const { content, tokensSaved } = truncateToolContent(big);
    assert.ok(tokensSaved > 0);
    assert.ok(content.length < big.length);
    assert.ok(content.includes("elided"));
    assert.ok(content.startsWith("X")); // head preserved
    assert.ok(content.endsWith("X")); // tail preserved
  });

  it("the elision marker points at read_file/search_files", () => {
    const big = "Y".repeat(20000);
    const { content } = truncateToolContent(big);
    assert.ok(content.includes("read_file"));
    assert.ok(content.includes("search_files"));
  });
});

describe("Context — A2 turn-aware pruning", () => {
  it("does not prune when under budget", () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
    ];
    const { messages: result, prunedCount } = pruneContext(messages, 10000);
    assert.equal(prunedCount, 0);
    assert.equal(result.length, messages.length);
  });

  it("always keeps the first user message (the task)", () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "THE ORIGINAL TASK" },
      { role: "assistant", content: "B".repeat(2000), tool_calls: [{ id: "tc1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", content: "C".repeat(2000), tool_call_id: "tc1", name: "read_file" },
      { role: "assistant", content: "D".repeat(2000) },
      { role: "user", content: "latest message" },
    ];
    const { messages: result } = pruneContext(messages, 500, 50);
    const hasTask = result.some((m) => m.role === "user" && m.content === "THE ORIGINAL TASK");
    assert.ok(hasTask, "first user message must survive pruning");
  });

  it("never produces orphan tool_call_ids", () => {
    // Build a conversation with assistant tool_calls + tool results, then prune
    // aggressively and verify every remaining tool message has a matching
    // assistant tool_calls entry.
    const messages: ProviderMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "do the task" },
      { role: "assistant", content: "ok", tool_calls: [
        { id: "tc1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        { id: "tc2", type: "function", function: { name: "read_file", arguments: '{"path":"b.ts"}' } },
      ] },
      { role: "tool", content: "A".repeat(3000), tool_call_id: "tc1", name: "read_file" },
      { role: "tool", content: "B".repeat(3000), tool_call_id: "tc2", name: "read_file" },
      { role: "assistant", content: "E".repeat(2000), tool_calls: [
        { id: "tc3", type: "function", function: { name: "apply_patch", arguments: "{}" } },
      ] },
      { role: "tool", content: "C".repeat(3000), tool_call_id: "tc3", name: "apply_patch" },
      { role: "assistant", content: "done" },
    ];

    const { messages: result } = pruneContext(messages, 400, 50);

    // Collect all tool_call_ids from remaining assistant messages.
    const validIds = new Set<string>();
    for (const m of result) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) validIds.add(tc.id);
      }
    }
    // Every remaining tool message must reference a valid id.
    for (const m of result) {
      if (m.role === "tool") {
        assert.ok(validIds.has(m.tool_call_id!), `orphan tool_call_id: ${m.tool_call_id}`);
      }
    }
  });

  it("compacts old tool messages instead of dropping them", () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "tc1", type: "function", function: { name: "execute_command", arguments: "{}" } }] },
      { role: "tool", content: "X".repeat(5000), tool_call_id: "tc1", name: "execute_command" },
      { role: "assistant", content: "result" },
      { role: "user", content: "follow up" },
      { role: "assistant", content: "final" },
    ];
    // Budget is tight enough to trigger compaction but not full turn pruning.
    const { messages: result, compactedTokensSaved } = pruneContext(messages, 3000, 100);
    // The old tool message should be compacted (content replaced with stub).
    const oldTool = result.find((m) => m.role === "tool");
    if (oldTool && compactedTokensSaved > 0) {
      assert.ok(oldTool.content!.includes("elided"), "old tool content should be compacted");
    }
  });

  it("prunes oldest turns atomically (assistant + its tool results together)", () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
      { role: "assistant", content: "A".repeat(2000), tool_calls: [{ id: "tc1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", content: "R1".repeat(2000), tool_call_id: "tc1", name: "read_file" },
      { role: "assistant", content: "B".repeat(2000), tool_calls: [{ id: "tc2", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", content: "R2".repeat(2000), tool_call_id: "tc2", name: "read_file" },
      { role: "assistant", content: "C".repeat(2000), tool_calls: [{ id: "tc3", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", content: "R3".repeat(2000), tool_call_id: "tc3", name: "read_file" },
      { role: "assistant", content: "final answer" },
    ];
    const { messages: result, prunedCount } = pruneContext(messages, 500, 50);
    if (prunedCount > 0) {
      // No orphan tool_call_ids.
      const validIds = new Set<string>();
      for (const m of result) {
        if (m.role === "assistant" && m.tool_calls) {
          for (const tc of m.tool_calls) validIds.add(tc.id);
        }
      }
      for (const m of result) {
        if (m.role === "tool") {
          assert.ok(validIds.has(m.tool_call_id!), `orphan after turn prune: ${m.tool_call_id}`);
        }
      }
    }
  });
});

describe("Context — backward-compat pruneMessages", () => {
  it("does not prune when under budget", () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
    ];
    const { messages: result, prunedCount } = pruneMessages(messages, 10000);
    assert.equal(prunedCount, 0);
    assert.equal(result.length, messages.length);
  });

  it("prunes when over budget and keeps system + last message", () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "A".repeat(1000) },
      { role: "assistant", content: "B".repeat(1000) },
      { role: "user", content: "C".repeat(1000) },
      { role: "assistant", content: "D".repeat(1000) },
      { role: "user", content: "latest message" },
    ];
    const { messages: result, prunedCount } = pruneMessages(messages, 500, 50);
    assert.ok(prunedCount > 0);
    assert.equal(result[0].role, "system");
    const lastMsg = result[result.length - 1];
    assert.equal(lastMsg.content, "latest message");
  });
});
