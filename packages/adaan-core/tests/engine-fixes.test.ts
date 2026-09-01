import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "../src/server/agent/session.js";
import type { ChatMessage, ToolCall } from "../src/types.js";

/**
 * Tests for the engine fixes:
 * 1. Orphaned tool-call cleanup when a turn is abandoned mid-stream.
 * 2. Session resume resets iteration count.
 *
 * The engine's cleanupOrphanedToolCalls is private, so we test a replica
 * of the exact logic here.
 */

function cleanupOrphanedToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const msgs = [...messages];
  if (msgs.length === 0) return msgs;

  let lastAssistantIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) return msgs;

  const expectedIds = new Set(msgs[lastAssistantIdx].toolCalls!.map((tc) => tc.id));
  const resolvedIds = new Set<string>();
  for (let i = lastAssistantIdx + 1; i < msgs.length; i++) {
    if (msgs[i].role === "tool" && msgs[i].toolCallId) {
      resolvedIds.add(msgs[i].toolCallId!);
    }
  }
  const allResolved = [...expectedIds].every((id) => resolvedIds.has(id));
  if (allResolved) return msgs;

  msgs.splice(lastAssistantIdx);
  return msgs;
}

function makeToolCall(id: string, name: string): ToolCall {
  return { id, type: "function", function: { name, arguments: "{}" } };
}

describe("Engine fixes — orphaned tool-call cleanup", () => {
  it("removes trailing assistant message with unresolved tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do something" },
      { role: "assistant", content: "", toolCalls: [makeToolCall("tc-1", "read_file")] },
    ];
    const cleaned = cleanupOrphanedToolCalls(messages);
    assert.equal(cleaned.length, 1);
    assert.equal(cleaned[0].role, "user");
  });

  it("does not remove assistant message when all tool_calls have results", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do something" },
      { role: "assistant", content: "", toolCalls: [makeToolCall("tc-1", "read_file")] },
      { role: "tool", content: "{}", toolCallId: "tc-1", name: "read_file" },
    ];
    const cleaned = cleanupOrphanedToolCalls(messages);
    assert.equal(cleaned.length, 3);
  });

  it("removes assistant message and partial tool results when some tool_calls are unresolved", () => {
    // Simulates: assistant requested 3 tool calls, only 1 executed before
    // the turn was abandoned.
    const messages: ChatMessage[] = [
      { role: "user", content: "do something" },
      { role: "assistant", content: "Let me read files.", toolCalls: [
        makeToolCall("tc-1", "read_file"),
        makeToolCall("tc-2", "read_file"),
        makeToolCall("tc-3", "list_files"),
      ] },
      { role: "tool", content: "{}", toolCallId: "tc-1", name: "read_file" },
      // tc-2 and tc-3 never got results — turn was abandoned
    ];
    const cleaned = cleanupOrphanedToolCalls(messages);
    assert.equal(cleaned.length, 1, "should remove assistant msg and partial tool result");
    assert.equal(cleaned[0].role, "user");
  });

  it("preserves earlier complete turns when the last turn is orphaned", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "first request" },
      { role: "assistant", content: "", toolCalls: [makeToolCall("tc-a", "read_file")] },
      { role: "tool", content: "{}", toolCallId: "tc-a", name: "read_file" },
      { role: "assistant", content: "Done with first." },
      { role: "user", content: "second request" },
      { role: "assistant", content: "", toolCalls: [makeToolCall("tc-b", "read_file")] },
    ];
    const cleaned = cleanupOrphanedToolCalls(messages);
    assert.equal(cleaned.length, 5);
    assert.equal(cleaned[4].role, "user");
    assert.equal(cleaned[4].content, "second request");
  });

  it("does nothing when there are no trailing assistant messages with tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    const cleaned = cleanupOrphanedToolCalls(messages);
    assert.equal(cleaned.length, 2);
  });

  it("does nothing on empty message list", () => {
    const cleaned = cleanupOrphanedToolCalls([]);
    assert.equal(cleaned.length, 0);
  });

  it("does nothing when last assistant with tool_calls is fully resolved mid-sequence", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "do something" },
      { role: "assistant", content: "", toolCalls: [makeToolCall("tc-1", "read_file")] },
      { role: "tool", content: "{}", toolCallId: "tc-1", name: "read_file" },
      { role: "assistant", content: "All done!" },
    ];
    const cleaned = cleanupOrphanedToolCalls(messages);
    assert.equal(cleaned.length, 4);
  });
});

describe("Engine fixes — session resume resets state", () => {
  it("resume() resets iterationCount to 0 for a fresh turn", () => {
    const session = new AgentSession("s1", "/tmp/ws");
    session.resume();
    session.iterationCount = 5;
    session.resume();
    assert.equal(session.iterationCount, 0);
  });
});

describe("Engine fixes — supersession (interrupt) behavior", () => {
  it("resume() sets superseded=true only when a turn is running", () => {
    const session = new AgentSession("s1", "/tmp/ws");
    session.resume();  // first resume — no prior turn running
    assert.equal(session.superseded, false);
    session.status = "running";  // simulate an in-flight turn
    session.resume();  // second resume — interrupts the running turn
    assert.equal(session.superseded, true);
  });

  it("resume() does not set superseded on first call (idle session)", () => {
    const session = new AgentSession("s1", "/tmp/ws");
    session.resume();
    assert.equal(session.superseded, false);
  });

  it("resume() aborts the previous AbortController", () => {
    const session = new AgentSession("s1", "/tmp/ws");
    session.resume();
    const oldController = session.abortController;
    assert.equal(oldController.signal.aborted, false);
    session.resume();
    assert.equal(oldController.signal.aborted, true, "old controller should be aborted");
    assert.notEqual(session.abortController, oldController, "new controller should be created");
  });

  it("resume() creates a fresh, non-aborted AbortController", () => {
    const session = new AgentSession("s1", "/tmp/ws");
    session.resume();
    session.cancel();  // abort the current controller
    assert.equal(session.abortController.signal.aborted, true);
    session.resume();  // new turn
    assert.equal(session.abortController.signal.aborted, false, "new controller should not be aborted");
  });
});
