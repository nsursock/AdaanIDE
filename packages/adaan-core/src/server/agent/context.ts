import type { ProviderMessage } from "../../types.js";

const CHARS_PER_TOKEN = 4; // rough heuristic

/**
 * Estimate the token count of a string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// --- A1: Tool result truncation --------------------------------------------

/** Default token cap for a single tool result stored in conversation history.
 *  The full result is still emitted to the UI via the tool.result event; only
 *  the copy pushed into session.messages (and thus re-sent on every subsequent
 *  request) is truncated. */
const TOOL_RESULT_MAX_TOKENS = 2000;

/**
 * Truncate a tool result's content for history. Keeps the head (~70% of the
 * budget) and tail (~30%) so the model sees both the start (usually the most
 * informative part — file headers, command preamble) and the end (errors,
 * exit codes, final output). The middle is replaced with an elision marker
 * that points the model at targeted re-reads.
 *
 * Returns the (possibly truncated) content and the number of tokens saved.
 */
export function truncateToolContent(
  content: string,
  maxTokens: number = TOOL_RESULT_MAX_TOKENS,
): { content: string; tokensSaved: number } {
  const totalTokens = estimateTokens(content);
  if (totalTokens <= maxTokens) {
    return { content, tokensSaved: 0 };
  }

  // Budget split: 70% head, 30% tail. Convert to chars.
  const headChars = Math.floor(maxTokens * 0.7 * CHARS_PER_TOKEN);
  const tailChars = Math.floor(maxTokens * 0.3 * CHARS_PER_TOKEN);

  const head = content.slice(0, headChars);
  const tail = content.slice(content.length - tailChars);
  const elidedTokens = totalTokens - estimateTokens(head) - estimateTokens(tail);
  const marker = `\n[…elided ~${elidedTokens} tokens — use read_file with startLine/endLine or search_files to target specific parts…]\n`;

  return {
    content: head + marker + tail,
    tokensSaved: elidedTokens - estimateTokens(marker),
  };
}

/**
 * Estimate the token count of a message (including role + content + tool calls).
 */
export function estimateMessageTokens(msg: ProviderMessage): number {
  let total = 4; // role + formatting overhead
  if (msg.content) total += estimateTokens(msg.content);
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      total += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments) + 8;
    }
  }
  if (msg.tool_call_id) total += estimateTokens(msg.tool_call_id);
  return total;
}

/**
 * Estimate total tokens for a message array.
 */
export function estimateTotalTokens(messages: ProviderMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

// --- A2: Turn-aware pruning + compaction -----------------------------------

/** A "turn" = one assistant message (with its tool_calls) + all following
 *  tool messages until the next assistant or user message. Pruning happens
 *  atomically per turn so tool_call_id pairing is never broken. */
interface Turn {
  /** Index range [start, end) into the non-system message array. */
  start: number;
  end: number;
  /** The assistant message that anchors this turn (or a user message for
   *  user-anchored turns — only the first user message forms its own turn). */
  anchorRole: "assistant" | "user";
  tokens: number;
}

const COMPACT_THRESHOLD_TOKENS = 200;
const KEEP_RECENT_TURNS = 2;

/**
 * Compact old tool messages: replace content of tool messages older than the
 * last `keepTurns` turns with a short elision stub. Tool-call pairing stays
 * valid because the tool message itself is kept (only its content shrinks).
 */
function compactOldToolMessages(
  messages: ProviderMessage[],
  keepTurns: number,
): { messages: ProviderMessage[]; tokensSaved: number } {
  // Find turn boundaries to know which messages are "old".
  const turnStarts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant" || messages[i].role === "user") {
      turnStarts.push(i);
    }
  }
  // Messages belonging to the last `keepTurns` turns are kept verbatim.
  const recentTurnStartIdx = Math.max(0, turnStarts.length - keepTurns);
  const recentStart = turnStarts[recentTurnStartIdx] ?? messages.length;

  let tokensSaved = 0;
  const result = messages.map((msg, i) => {
    if (i >= recentStart) return msg;
    if (msg.role !== "tool") return msg;
    const tokens = estimateTokens(msg.content ?? "");
    if (tokens <= COMPACT_THRESHOLD_TOKENS) return msg;

    const stub = `[elided: tool result, ~${tokens} tokens — use read_file/search_files if you need details]`;
    tokensSaved += tokens - estimateTokens(stub);
    return { ...msg, content: stub };
  });

  return { messages: result, tokensSaved };
}

/**
 * Split non-system messages into turns. A turn starts at each assistant or
 * user message and includes all following tool messages.
 */
function splitTurns(messages: ProviderMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" || msg.role === "user") {
      // Start a new turn — close the previous one.
      if (turns.length > 0) {
        turns[turns.length - 1].end = i;
      }
      turns.push({
        start: i,
        end: messages.length,
        anchorRole: msg.role as "assistant" | "user",
        tokens: 0,
      });
    }
  }
  if (turns.length > 0) {
    turns[turns.length - 1].end = messages.length;
  }

  // Compute tokens per turn.
  for (const turn of turns) {
    let tokens = 0;
    for (let i = turn.start; i < turn.end; i++) {
      tokens += estimateMessageTokens(messages[i]);
    }
    turn.tokens = tokens;
  }

  return turns;
}

/**
 * Turn-aware context pruning with compaction. Two stages:
 *
 * 1. **Compact**: tool messages older than the last `KEEP_RECENT_TURNS` turns
 *    whose content exceeds 200 tokens → replace with an elision stub.
 *    Pairing stays valid (the tool message is kept, just shrunk).
 * 2. **Prune by turn**: drop oldest turns atomically (assistant + its tool
 *    results together) until under budget. Always keep: system messages, the
 *    **first user message** (the task), and the last `KEEP_RECENT_TURNS` turns.
 *
 * Invariant: every `tool` message's `tool_call_id` matches a `tool_calls[].id`
 * in a preceding assistant message that is still present.
 */
export function pruneContext(
  messages: ProviderMessage[],
  maxTokens: number,
  reserveTokens: number = 1000,
): { messages: ProviderMessage[]; prunedCount: number; compactedTokensSaved: number } {
  const target = maxTokens - reserveTokens;

  // Stage 1: compact old tool messages.
  const { messages: compacted, tokensSaved: compactSaved } = compactOldToolMessages(
    messages,
    KEEP_RECENT_TURNS,
  );
  let total = estimateTotalTokens(compacted);

  if (total <= target) {
    return { messages: compacted, prunedCount: 0, compactedTokensSaved: compactSaved };
  }

  // Stage 2: prune by turn.
  // Separate system messages (always kept) from the rest.
  const systemMsgs: ProviderMessage[] = [];
  const otherMsgs: ProviderMessage[] = [];
  for (const msg of compacted) {
    if (msg.role === "system") {
      systemMsgs.push(msg);
    } else {
      otherMsgs.push(msg);
    }
  }

  const turns = splitTurns(otherMsgs);
  if (turns.length === 0) {
    return { messages: compacted, prunedCount: 0, compactedTokensSaved: compactSaved };
  }

  // Always keep: first user-anchored turn (the task) + last KEEP_RECENT_TURNS turns.
  const firstUserTurnIdx = turns.findIndex((t) => t.anchorRole === "user");
  const lastKeepIdx = turns.length - KEEP_RECENT_TURNS;

  // Build the set of turn indices we can drop (not the first user turn, not
  // the last KEEP_RECENT_TURNS turns).
  const droppable: number[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (i === firstUserTurnIdx) continue;
    if (i >= lastKeepIdx) continue;
    droppable.push(i);
  }

  let prunedCount = 0;
  const droppedTurns: string[] = [];
  const droppedIndices = new Set<number>();

  for (const idx of droppable) {
    if (total <= target) break;
    const turn = turns[idx];
    total -= turn.tokens;
    droppedIndices.add(idx);
    prunedCount += turn.end - turn.start;
    // Summarize what was dropped (first line of the assistant message).
    const anchor = otherMsgs[turn.start];
    const summary = anchor.content?.slice(0, 60) ?? "(tool calls)";
    droppedTurns.push(summary);
  }

  if (droppedIndices.size === 0) {
    return { messages: compacted, prunedCount: 0, compactedTokensSaved: compactSaved };
  }

  // Rebuild: system + elision note + surviving turns.
  const surviving: ProviderMessage[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (droppedIndices.has(i)) continue;
    for (let j = turns[i].start; j < turns[i].end; j++) {
      surviving.push(otherMsgs[j]);
    }
  }

  const elisionNote: ProviderMessage = {
    role: "system",
    content: `[${droppedIndices.size} earlier turn(s) elided to fit context window: ${droppedTurns
      .map((t) => `"${t}…"`)
      .join(", ")}. Re-read files if you need details.]`,
  };

  return {
    messages: [...systemMsgs, elisionNote, ...surviving],
    prunedCount,
    compactedTokensSaved: compactSaved,
  };
}

// Backward-compat wrapper for the old pruneMessages API used by existing
// tests. Delegates to pruneContext and adapts the return shape.
export function pruneMessages(
  messages: ProviderMessage[],
  maxTokens: number,
  reserveTokens: number = 1000,
): { messages: ProviderMessage[]; prunedCount: number } {
  const result = pruneContext(messages, maxTokens, reserveTokens);
  return { messages: result.messages, prunedCount: result.prunedCount };
}
