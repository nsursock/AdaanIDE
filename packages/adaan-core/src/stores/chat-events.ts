import type { AgentEvent, TaskSummaryData, ProgressData, StatusData, ReasoningDeltaData } from "../types.js";
import type { ChatMessageEntry, TimelineSegment } from "./chat.svelte.js";

// --- Message mutation helpers (operate on a plain ChatMessageEntry[]) -----

function findMsg(messages: ChatMessageEntry[], id: string): ChatMessageEntry | undefined {
  return messages.find((m) => m.id === id);
}

function appendToAssistant(messages: ChatMessageEntry[], id: string, text: string) {
  const msg = findMsg(messages, id);
  if (msg) msg.content += text;
}

function appendReasoningToAssistant(messages: ChatMessageEntry[], id: string, text: string) {
  const msg = findMsg(messages, id);
  if (msg) msg.reasoning = (msg.reasoning ?? "") + text;
}

function appendTimelineSegment(messages: ChatMessageEntry[], id: string, segment: TimelineSegment) {
  const msg = findMsg(messages, id);
  if (!msg) return;
  if (!msg.timeline) msg.timeline = [];
  const last = msg.timeline[msg.timeline.length - 1];
  if (segment.type !== "tool" && last && last.type === segment.type) {
    (last as { text: string }).text += segment.text;
  } else {
    msg.timeline.push(segment);
  }
}

function setAssistantModel(messages: ChatMessageEntry[], id: string, modelId: string) {
  const msg = findMsg(messages, id);
  if (msg) msg.modelUsed = modelId;
}

function setAssistantError(messages: ChatMessageEntry[], id: string, error: string) {
  const msg = findMsg(messages, id);
  if (msg) msg.error = error;
}

function setAssistantStatus(
  messages: ChatMessageEntry[],
  id: string,
  status: { message: string; elapsedMs?: number; phase?: ProgressData["phase"] } | null,
) {
  const msg = findMsg(messages, id);
  if (!msg) return;
  msg.status = status;
}

function setFreeModelsExhausted(messages: ChatMessageEntry[], id: string, message: string, triedModels: string[]) {
  const msg = findMsg(messages, id);
  if (msg) msg.freeModelsExhausted = { message, triedModels };
}

function addToolCallToAssistant(
  messages: ChatMessageEntry[],
  id: string,
  toolCall: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    pending?: boolean;
    approvalRequired?: boolean;
    cached?: boolean;
  },
) {
  const msg = findMsg(messages, id);
  if (msg) {
    if (!msg.toolCalls) msg.toolCalls = [];
    msg.toolCalls.push(toolCall);
  }
}

function updateToolCall(
  messages: ChatMessageEntry[],
  assistantId: string,
  toolCallId: string,
  update: {
    result?: unknown;
    error?: string;
    pending?: boolean;
    approvalRequired?: boolean;
    cached?: boolean;
  },
) {
  const msg = findMsg(messages, assistantId);
  if (!msg?.toolCalls) return;
  const tc = msg.toolCalls.find((t) => t.id === toolCallId);
  if (tc) Object.assign(tc, update);
}

// --- Main event applier -----------------------------------------------------

/**
 * Apply an agent event to a `ChatMessageEntry[]`, mutating messages in
 * place. This is the standalone equivalent of `ChatStore.handleEvent` —
 * extracted so that both the singleton `chatStore` (for the active project)
 * and `projectsStore` (for background projects) can route events to the
 * correct message array.
 *
 * Does NOT touch any `streaming` flag — the caller is responsible for
 * updating streaming state based on `isTerminalEvent(event)`.
 */
export function applyChatEvent(messages: ChatMessageEntry[], assistantId: string, event: AgentEvent): void {
  switch (event.type) {
    case "text.delta": {
      const data = event.data as { text: string };
      appendToAssistant(messages, assistantId, data.text);
      appendTimelineSegment(messages, assistantId, { type: "content", text: data.text });
      setAssistantStatus(messages, assistantId, null);
      break;
    }
    case "reasoning.delta": {
      const data = event.data as ReasoningDeltaData;
      appendReasoningToAssistant(messages, assistantId, data.text);
      appendTimelineSegment(messages, assistantId, { type: "reasoning", text: data.text });
      setAssistantStatus(messages, assistantId, null);
      break;
    }
    case "status": {
      const data = event.data as StatusData;
      if (!data.message) {
        setAssistantStatus(messages, assistantId, null);
      } else {
        setAssistantStatus(messages, assistantId, { message: data.message });
      }
      break;
    }
    case "progress": {
      const data = event.data as ProgressData;
      const phaseLabel =
        data.phase === "queued"
          ? "queued at provider"
          : data.phase === "streaming"
            ? "waiting for model response"
            : "waiting for model response";
      const secs = Math.max(1, Math.round(data.elapsedMs / 1000));
      setAssistantStatus(messages, assistantId, {
        message: `Working… ${secs}s · ${phaseLabel}`,
        elapsedMs: data.elapsedMs,
        phase: data.phase,
      });
      break;
    }
    case "model.used": {
      const data = event.data as { modelId: string };
      setAssistantModel(messages, assistantId, data.modelId);
      break;
    }
    case "model.fallback": {
      const data = event.data as { from: string; to: string; reason: string };
      const msg = findMsg(messages, assistantId);
      if (msg) {
        if (!msg.modelFallback) msg.modelFallback = [];
        msg.modelFallback.push(data);
      }
      break;
    }
    case "model.routed": {
      const data = event.data as { model: string; category: string; reason: string };
      const msg = findMsg(messages, assistantId);
      if (msg) {
        msg.routedTo = { model: data.model, category: data.category, reason: data.reason };
      }
      break;
    }
    case "model.escalated": {
      const data = event.data as { from: string; to: string; reason: string };
      const msg = findMsg(messages, assistantId);
      if (msg) {
        if (!msg.modelEscalations) msg.modelEscalations = [];
        msg.modelEscalations.push(data);
      }
      break;
    }
    case "tool.start": {
      const data = event.data as { toolCallId: string; toolName: string };
      addToolCallToAssistant(messages, assistantId, {
        id: data.toolCallId,
        name: data.toolName,
        args: {},
        pending: true,
      });
      appendTimelineSegment(messages, assistantId, { type: "tool", toolCallId: data.toolCallId });
      break;
    }
    case "tool.args": {
      const data = event.data as { toolCallId: string; args: Record<string, unknown> };
      const msg = findMsg(messages, assistantId);
      const tc = msg?.toolCalls?.find((t) => t.id === data.toolCallId);
      if (tc) tc.args = data.args;
      break;
    }
    case "tool.result": {
      const data = event.data as { toolCallId: string; result: unknown };
      updateToolCall(messages, assistantId, data.toolCallId, {
        result: data.result,
        pending: false,
      });
      break;
    }
    case "tool.error": {
      const data = event.data as { toolCallId: string; error: string };
      updateToolCall(messages, assistantId, data.toolCallId, {
        error: data.error,
        pending: false,
      });
      break;
    }
    case "tool.approval_required": {
      const data = event.data as { toolCallId: string; toolName: string; args: Record<string, unknown> };
      addToolCallToAssistant(messages, assistantId, {
        id: data.toolCallId,
        name: data.toolName,
        args: data.args,
        pending: true,
        approvalRequired: true,
      });
      appendTimelineSegment(messages, assistantId, { type: "tool", toolCallId: data.toolCallId });
      break;
    }
    case "tool.cache_hit": {
      const data = event.data as { toolCallId: string };
      updateToolCall(messages, assistantId, data.toolCallId, { cached: true });
      break;
    }
    case "done":
    case "cancelled":
      setAssistantStatus(messages, assistantId, null);
      break;
    case "task.summary": {
      const data = event.data as TaskSummaryData | undefined;
      if (data) {
        const msg = findMsg(messages, assistantId);
        if (msg) msg.taskSummary = data;
      }
      break;
    }
    case "error": {
      const data = event.data as { message?: string } | undefined;
      if (data?.message) {
        setAssistantError(messages, assistantId, data.message);
      }
      setAssistantStatus(messages, assistantId, null);
      break;
    }
    case "model.free_exhausted": {
      const data = event.data as { message: string; triedModels: string[] };
      setFreeModelsExhausted(messages, assistantId, data.message, data.triedModels);
      setAssistantStatus(messages, assistantId, null);
      break;
    }
  }
}

/** True for events that mark the end of a streaming turn. The caller should
 *  set its `streaming` flag to false when this returns true. */
export function isTerminalEvent(event: AgentEvent): boolean {
  return (
    event.type === "done" ||
    event.type === "error" ||
    event.type === "cancelled" ||
    event.type === "model.free_exhausted"
  );
}
