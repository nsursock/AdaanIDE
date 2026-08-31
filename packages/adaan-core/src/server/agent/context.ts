import type { ProviderMessage } from "../../types.js";

const CHARS_PER_TOKEN = 4; // rough heuristic

/**
 * Estimate the token count of a string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
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

/**
 * Prune messages to fit within a token budget.
 * Always keeps: system messages (first), the last user message, and recent tool results.
 * Prunes: oldest non-system messages, replacing them with a summary.
 *
 * Returns the pruned messages and the number of messages removed.
 */
export function pruneMessages(
  messages: ProviderMessage[],
  maxTokens: number,
  reserveTokens: number = 1000,
): { messages: ProviderMessage[]; prunedCount: number } {
  const target = maxTokens - reserveTokens;
  let total = estimateTotalTokens(messages);

  if (total <= target) {
    return { messages, prunedCount: 0 };
  }

  // Find system messages (keep them)
  const systemMsgs: ProviderMessage[] = [];
  const otherMsgs: ProviderMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      systemMsgs.push(msg);
    } else {
      otherMsgs.push(msg);
    }
  }

  // Keep the last N messages, prune from the front
  const prunedCount: number[] = [];
  while (total > target && otherMsgs.length > 2) {
    const removed = otherMsgs.shift()!;
    total -= estimateMessageTokens(removed);
    prunedCount.push(1);
  }

  // Add a summary of pruned messages
  if (prunedCount.length > 0) {
    const summary: ProviderMessage = {
      role: "system",
      content: `[Context pruned: ${prunedCount.length} earlier messages elided to fit context window. Key tool results may have been removed — re-read files if needed.]`,
    };
    return {
      messages: [...systemMsgs, summary, ...otherMsgs],
      prunedCount: prunedCount.length,
    };
  }

  return { messages: [...systemMsgs, ...otherMsgs], prunedCount: 0 };
}
