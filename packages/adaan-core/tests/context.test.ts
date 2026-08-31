import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, estimateMessageTokens, estimateTotalTokens, pruneMessages } from "../src/server/agent/context.js";
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

describe("Context — pruning", () => {
  it("does not prune when under budget", () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
    ];
    const { messages: result, prunedCount } = pruneMessages(messages, 10000);
    assert.equal(prunedCount, 0);
    assert.equal(result.length, messages.length);
  });

  it("prunes when over budget", () => {
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
    // System messages should be preserved
    assert.equal(result[0].role, "system");
    // Last user message should be preserved
    const lastMsg = result[result.length - 1];
    assert.equal(lastMsg.content, "latest message");
  });

  it("adds a summary when pruning occurs", () => {
    const messages: ProviderMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "A".repeat(1000) },
      { role: "assistant", content: "B".repeat(1000) },
      { role: "user", content: "latest" },
    ];
    const { messages: result, prunedCount } = pruneMessages(messages, 300, 50);
    if (prunedCount > 0) {
      const hasSummary = result.some((m) => m.role === "system" && m.content.includes("Context pruned"));
      assert.ok(hasSummary);
    }
  });
});
