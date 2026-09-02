import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "../src/server/agent/session.js";
import { argsHashKey, isApplyPatchFormatError } from "../src/server/agent/engine.js";
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

/**
 * Tests for the B1 repeat-failure guard hash normalization (Fix 3).
 *
 * The guard blocks identical failed tool calls. Without normalization, a
 * model could evade it by adding a trailing newline or spaces to the patch
 * — producing a different JSON.stringify hash for an otherwise identical
 * call. argsHashKey trims trailing whitespace on text-blob args (patch,
 * content) so cosmetic changes don't evade the guard.
 */
describe("Engine fixes — B1 argsHashKey normalization", () => {
  it("produces the same hash for apply_patch patches differing only in trailing whitespace", () => {
    const a = argsHashKey("apply_patch", {
      path: "ppo.py",
      patch: "SEARCH\ndef foo():\n    pass\nREPLACE\ndef bar():\n    pass",
      expectedHash: "abc",
    });
    const b = argsHashKey("apply_patch", {
      path: "ppo.py",
      patch: "SEARCH\ndef foo():\n    pass\nREPLACE\ndef bar():\n    pass\n\n\n",
      expectedHash: "abc",
    });
    assert.equal(a, b, "trailing whitespace on patch must not change the hash");
  });

  it("produces the same hash for write_file content differing only in trailing whitespace", () => {
    const a = argsHashKey("write_file", {
      path: "ppo.py",
      content: "print('hello')\n",
      expectedHash: "abc",
    });
    const b = argsHashKey("write_file", {
      path: "ppo.py",
      content: "print('hello')\n   \n\n",
      expectedHash: "abc",
    });
    assert.equal(a, b, "trailing whitespace on content must not change the hash");
  });

  it("produces different hashes when the patch content genuinely differs", () => {
    const a = argsHashKey("apply_patch", {
      path: "ppo.py",
      patch: "SEARCH\nold\nREPLACE\nnew1",
      expectedHash: "abc",
    });
    const b = argsHashKey("apply_patch", {
      path: "ppo.py",
      patch: "SEARCH\nold\nREPLACE\nnew2",
      expectedHash: "abc",
    });
    assert.notEqual(a, b, "genuinely different patches must hash differently");
  });

  it("preserves leading/internal whitespace (only trailing is trimmed)", () => {
    const a = argsHashKey("apply_patch", {
      path: "f.py",
      patch: "SEARCH\n    indented\nREPLACE\n    still",
      expectedHash: "h",
    });
    const b = argsHashKey("apply_patch", {
      path: "f.py",
      patch: "SEARCH\n    indented\nREPLACE\n    still\n",
      expectedHash: "h",
    });
    assert.equal(a, b, "leading indentation preserved, trailing newline ignored");
  });

  it("uses tool name in the hash so different tools don't collide", () => {
    const a = argsHashKey("apply_patch", { path: "f.py", patch: "x", expectedHash: "h" });
    const b = argsHashKey("write_file", { path: "f.py", content: "x", expectedHash: "h" });
    assert.notEqual(a, b, "different tool names must produce different hashes");
  });
});

/**
 * Tests for the D10 apply_patch format-error detection (Fix 2).
 *
 * When apply_patch fails with a format problem (the model structured the
 * patch wrong), the engine appends a directive hint showing the correct
 * SEARCH/REPLACE format and the write_file fallback. isApplyPatchFormatError
 * distinguishes format errors from content/hash errors so the hint only
 * fires when it's actually useful.
 */
describe("Engine fixes — apply_patch format-error detection", () => {
  it("detects 'no REPLACE section' errors", () => {
    assert.ok(isApplyPatchFormatError(
      'SEARCH block has no REPLACE section — refusing to silently delete lines.',
    ));
  });

  it("detects 'no valid SEARCH/REPLACE blocks' errors", () => {
    assert.ok(isApplyPatchFormatError(
      "No valid SEARCH/REPLACE blocks were found in the patch.",
    ));
  });

  it("detects 'SEARCH block not found' errors", () => {
    assert.ok(isApplyPatchFormatError(
      "SEARCH block not found:\ndef foo()...",
    ));
  });

  it("does NOT flag hash mismatch errors (those need a re-read, not a format hint)", () => {
    assert.equal(
      isApplyPatchFormatError("Hash mismatch: file has been modified since read"),
      false,
    );
  });

  it("does NOT flag generic tool execution errors", () => {
    assert.equal(
      isApplyPatchFormatError("File not found for patching: ppo.py"),
      false,
    );
  });

  it("does NOT flag the 'patch produced no changes' error (that's a content issue)", () => {
    assert.equal(
      isApplyPatchFormatError("Patch produced no changes — the file content is identical."),
      false,
    );
  });
});

/**
 * D19: Tool call argument normalization.
 *
 * Free models (e.g. cohere/north-mini-code) sometimes emit tool calls with
 * empty or malformed arguments. If stored as-is, the next provider request
 * sends the malformed arguments back, causing a 400: "tool arguments must
 * be a stringified JSON object". The engine normalizes empty/malformed
 * arguments to "{}" both at storage time and in buildProviderMessages.
 */
describe("D19: tool call argument normalization", () => {
  // Replica of the normalization logic in tool_call.complete handler.
  function normalizeArgs(raw: string): string {
    if (!raw || !raw.trim()) return "{}";
    try {
      JSON.parse(raw);
      return raw;
    } catch {
      return "{}";
    }
  }

  it("normalizes empty string to {}", () => {
    assert.equal(normalizeArgs(""), "{}");
  });

  it("normalizes whitespace-only string to {}", () => {
    assert.equal(normalizeArgs("   "), "{}");
  });

  it("preserves valid JSON object", () => {
    assert.equal(normalizeArgs('{"path":"foo.py"}'), '{"path":"foo.py"}');
  });

  it("preserves valid JSON with nested structure", () => {
    const args = '{"path":"foo.py","content":"def foo():\\n  pass\\n"}';
    assert.equal(normalizeArgs(args), args);
  });

  it("normalizes malformed JSON to {}", () => {
    assert.equal(normalizeArgs("{path: foo.py}"), "{}");
  });

  it("normalizes truncated JSON to {}", () => {
    assert.equal(normalizeArgs('{"path":"foo'), "{}");
  });

  it("preserves valid empty JSON object", () => {
    assert.equal(normalizeArgs("{}"), "{}");
  });

  it("buildProviderMessages safety net: normalizes tool calls with empty args", () => {
    // Replica of the buildProviderMessages safety net logic.
    function normalizeToolCalls(toolCalls: ToolCall[]): ToolCall[] {
      return toolCalls.map((tc) => {
        const args = tc.function.arguments;
        if (!args || !args.trim()) {
          return { ...tc, function: { ...tc.function, arguments: "{}" } };
        }
        try {
          JSON.parse(args);
          return tc;
        } catch {
          return { ...tc, function: { ...tc.function, arguments: "{}" } };
        }
      });
    }

    const input: ToolCall[] = [
      { id: "1", type: "function", function: { name: "create_file", arguments: "" } },
      { id: "2", type: "function", function: { name: "write_file", arguments: '{"path":"a.py"}' } },
      { id: "3", type: "function", function: { name: "apply_patch", arguments: "{bad json" } },
      { id: "4", type: "function", function: { name: "read_file", arguments: "  " } },
    ];
    const output = normalizeToolCalls(input);
    assert.equal(output[0].function.arguments, "{}");
    assert.equal(output[1].function.arguments, '{"path":"a.py"}');
    assert.equal(output[2].function.arguments, "{}");
    assert.equal(output[3].function.arguments, "{}");
  });
});
