import type { AgentEvent, ModelInfo, ModelGroups, TaskSummaryData, ProgressData, StatusData, ReasoningDeltaData } from "../types.js";
import { settingsStore } from "./settings.svelte.js";

export interface ChatMessageEntry {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /** Reasoning/thinking text from reasoning-capable models, streamed token
   *  by token and rendered in a separate muted, collapsible block above the
   *  final answer. Accumulated as `reasoning.delta` events arrive. */
  reasoning?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    error?: string;
    pending?: boolean;
    approvalRequired?: boolean;
    cached?: boolean;
  }>;
  /** Chronologically-ordered timeline of reasoning/tool/content segments,
   *  capturing the real interleaved sequence of the agent loop (thinking →
   *  commands → thinking → commands → feedback → …). Consecutive deltas of
   *  the same kind are merged into a single segment. The UI renders from
   *  this array instead of the flat `reasoning`/`toolCalls`/`content` buckets
   *  so the user sees the actual flow of work, not a compartmentalized view.
   *  The flat fields are kept for the transcript and other consumers. */
  timeline?: TimelineSegment[];
  modelUsed?: string;
  timestamp: number;
  error?: string;
  /** Live status line shown under the streaming bubble while the provider is
   *  silent — "iteration 2 → requesting qwen3.8-max…" or "Working… 23s ·
   *  queued at provider". Cleared (set to null) on the first real token. */
  status?: { message: string; elapsedMs?: number; phase?: ProgressData["phase"] } | null;
  /** Set when the provider had to fall back from the user's selected model
   *  to a different one (e.g. free-tier 429 after retry). Shown in the UI so
   *  the swap is visible rather than silently mislabeling the reply. Each
   *  hop in the cascade is appended, so the user sees the full chain:
   *  selected → ... → final. */
  modelFallback?: Array<{ from: string; to: string; reason: string }>;
  /** Set when every free model we tried for this turn is currently
   *  unavailable — the UI should offer to retry with a paid model. */
  freeModelsExhausted?: { message: string; triedModels: string[] };
  /** Per-task cost/token footer, emitted at the end of a turn so the UI can
   *  show `7 reqs · 92k tokens · $0.031 · 84s` under the assistant message. */
  taskSummary?: TaskSummaryData;
  /** Phase 3: set when the adaptive router picked the model for this task. */
  routedTo?: { model: string; category: string; reason: string };
  /** Phase 3: set when the model was escalated mid-task due to repeated failures. */
  modelEscalations?: Array<{ from: string; to: string; reason: string }>;
}

/** A single segment in the chronological timeline of an assistant message.
 *  Consecutive reasoning deltas are merged into one `reasoning` segment;
 *  consecutive content deltas are merged into one `content` segment. Each
 *  tool call is its own segment, referenced by `toolCallId` so the full
 *  tool-call object (with live result/error/pending state) can be looked up
 *  from `ChatMessageEntry.toolCalls` at render time. */
export type TimelineSegment =
  | { type: "reasoning"; text: string }
  | { type: "tool"; toolCallId: string }
  | { type: "content"; text: string };

class ChatStore {
  messages = $state<ChatMessageEntry[]>([]);
  selectedModel = $state<ModelInfo | null>(null);
  streaming = $state(false);
  sessionId = $state<string | null>(null);

  setModel(model: ModelInfo | null) {
    this.selectedModel = model;
    settingsStore.setSelectedModelId(model?.id ?? null);
  }

  /**
   * Restore the previously-selected model from persisted settings, given the
   * freshly-loaded model list. Returns true if a match was found and applied.
   * Called by the chat UI after `/api/models` resolves.
   */
  restoreModel(models: ModelGroups): boolean {
    const id = settingsStore.settings.selectedModelId;
    if (!id) return false;
    const all = [...models.free, ...models.paid, ...(models.local ?? [])];
    const found = all.find((m) => m.id === id);
    if (found) {
      // Set directly to avoid re-persisting the same id.
      this.selectedModel = found;
      return true;
    }
    return false;
  }

  setSessionId(id: string | null) {
    this.sessionId = id;
  }

  addUserMessage(content: string) {
    this.messages.push({
      id: crypto.randomUUID(),
      role: "user",
      content,
      timestamp: Date.now(),
    });
  }

  startAssistantMessage(): string {
    const id = crypto.randomUUID();
    this.messages.push({
      id,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    });
    this.streaming = true;
    return id;
  }

  appendToAssistant(id: string, text: string) {
    const msg = this.messages.find((m) => m.id === id);
    if (msg) msg.content += text;
  }

  /** Append a chunk of model reasoning/thinking to the assistant message.
   *  Kept separate from `content` so the UI can render it in a distinct,
   *  muted, collapsible block above the final answer. */
  appendReasoningToAssistant(id: string, text: string) {
    const msg = this.messages.find((m) => m.id === id);
    if (msg) msg.reasoning = (msg.reasoning ?? "") + text;
  }

  /** Append a segment to the assistant message's chronological `timeline`
   *  array. Consecutive `reasoning` or `content` deltas are merged into the
   *  last segment of the same type (so a stream of reasoning tokens becomes
   *  one block, not hundreds of one-token blocks). `tool` segments are never
   *  merged — each tool call is its own entry, referenced by `toolCallId`. */
  appendTimelineSegment(id: string, segment: TimelineSegment) {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return;
    if (!msg.timeline) msg.timeline = [];
    const last = msg.timeline[msg.timeline.length - 1];
    if (
      segment.type !== "tool" &&
      last &&
      last.type === segment.type
    ) {
      // Merge consecutive reasoning/content deltas.
      (last as { text: string }).text += segment.text;
    } else {
      msg.timeline.push(segment);
    }
  }

  setAssistantModel(id: string, modelId: string) {
    const msg = this.messages.find((m) => m.id === id);
    if (msg) msg.modelUsed = modelId;
  }

  setAssistantError(id: string, error: string) {
    const msg = this.messages.find((m) => m.id === id);
    if (msg) msg.error = error;
  }

  /** Update the live status line under the streaming bubble. Pass `null` to
   *  clear it (e.g. on the first real token or when the turn ends). */
  setAssistantStatus(
    id: string,
    status: { message: string; elapsedMs?: number; phase?: ProgressData["phase"] } | null,
  ) {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return;
    // Once the bubble has real content or has terminated, don't show a
    // "waiting" line anymore.
    if (status === null) {
      msg.status = null;
      return;
    }
    msg.status = status;
  }

  setFreeModelsExhausted(id: string, message: string, triedModels: string[]) {
    const msg = this.messages.find((m) => m.id === id);
    if (msg) msg.freeModelsExhausted = { message, triedModels };
  }

  addToolCallToAssistant(id: string, toolCall: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    pending?: boolean;
    approvalRequired?: boolean;
    cached?: boolean;
  }) {
    const msg = this.messages.find((m) => m.id === id);
    if (msg) {
      if (!msg.toolCalls) msg.toolCalls = [];
      msg.toolCalls.push(toolCall);
    }
  }

  updateToolCall(assistantId: string, toolCallId: string, update: {
    result?: unknown;
    error?: string;
    pending?: boolean;
    approvalRequired?: boolean;
    cached?: boolean;
  }) {
    const msg = this.messages.find((m) => m.id === assistantId);
    if (!msg?.toolCalls) return;
    const tc = msg.toolCalls.find((t) => t.id === toolCallId);
    if (tc) Object.assign(tc, update);
  }

  finishStreaming() {
    this.streaming = false;
  }

  /**
   * Mark any tool calls still awaiting approval as cancelled. Called before
   * starting a new turn, since the backend auto-denies stale approvals from
   * an abandoned turn (see AgentSession.resume()) and the corresponding UI
   * cards would otherwise show "running"/"pending" forever.
   */
  cancelPendingToolCalls() {
    for (const msg of this.messages) {
      if (!msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        if (tc.pending) {
          tc.pending = false;
          tc.approvalRequired = false;
          tc.error = "Cancelled — a new message was sent before this was resolved.";
        }
      }
    }
  }

  clear() {
    this.messages = [];
    this.sessionId = null;
    this.streaming = false;
  }

  /**
   * Serialize the current conversation to a plain-text transcript suitable for
   * sharing / debugging. Includes every user + assistant message, all tool
   * calls with their args and results/errors, and the session id + model used.
   */
  toTranscript(): string {
    const lines: string[] = [];
    if (this.sessionId) lines.push(`Session: ${this.sessionId}`);
    if (this.selectedModel) lines.push(`Model: ${this.selectedModel.id}`);
    lines.push(`Messages: ${this.messages.length}`);
    lines.push("=".repeat(60));

    for (const msg of this.messages) {
      const ts = new Date(msg.timestamp).toISOString();
      lines.push("");
      lines.push(`[${ts}] ${msg.role.toUpperCase()}${msg.modelUsed ? ` (${msg.modelUsed})` : ""}:`);
      if (msg.content.trim()) {
        lines.push(msg.content);
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          lines.push("");
          const status = tc.error
            ? "ERROR"
            : tc.pending
              ? "PENDING"
              : tc.result !== undefined
                ? "OK"
                : "?";
          lines.push(`  --- TOOL: ${tc.name} [${status}]${tc.cached ? " (cached)" : ""} ---`);
          lines.push(`  args: ${JSON.stringify(tc.args)}`);
          if (tc.error) {
            lines.push(`  error: ${tc.error}`);
          } else if (tc.result !== undefined) {
            const resultStr = typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result, null, 2);
            // Indent multi-line results for readability.
            lines.push(`  result: ${resultStr.replace(/\n/g, "\n  ")}`);
          }
        }
      }
      // The error (if any) is a terminal event — it always happens after any
      // content/tool calls the model already produced in this turn, so it
      // must be printed last, not first.
      if (msg.error) {
        lines.push("");
        lines.push(`  [ERROR]: ${msg.error}`);
      }
      if (msg.modelFallback && msg.modelFallback.length > 0) {
        lines.push("");
        const chain = [msg.modelFallback[0].from, ...msg.modelFallback.map((h) => h.to)];
        lines.push(`  [FELL BACK]: ${chain.join(" -> ")}`);
        for (const hop of msg.modelFallback) {
          lines.push(`    ${hop.from} -> ${hop.to}: ${hop.reason}`);
        }
      }
      if (msg.freeModelsExhausted) {
        lines.push("");
        lines.push(`  [FREE MODELS EXHAUSTED]: ${msg.freeModelsExhausted.message}`);
        lines.push(`  tried: ${msg.freeModelsExhausted.triedModels.join(", ")}`);
      }
    }

    lines.push("");
    lines.push("=".repeat(60));
    return lines.join("\n");
  }

  handleEvent(assistantId: string, event: AgentEvent) {
    switch (event.type) {
      case "text.delta": {
        const data = event.data as { text: string };
        this.appendToAssistant(assistantId, data.text);
        this.appendTimelineSegment(assistantId, { type: "content", text: data.text });
        // First real token — clear the "waiting" status line.
        this.setAssistantStatus(assistantId, null);
        break;
      }
      case "reasoning.delta": {
        const data = event.data as ReasoningDeltaData;
        this.appendReasoningToAssistant(assistantId, data.text);
        this.appendTimelineSegment(assistantId, { type: "reasoning", text: data.text });
        // Reasoning is a genuine alive signal — clear the "waiting" status
        // line so the UI shows the thought block instead of "Working… Ns".
        this.setAssistantStatus(assistantId, null);
        break;
      }
      case "status": {
        const data = event.data as StatusData;
        // An empty message clears the line (used on first token / turn end).
        if (!data.message) {
          this.setAssistantStatus(assistantId, null);
        } else {
          this.setAssistantStatus(assistantId, { message: data.message });
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
        this.setAssistantStatus(assistantId, {
          message: `Working… ${secs}s · ${phaseLabel}`,
          elapsedMs: data.elapsedMs,
          phase: data.phase,
        });
        break;
      }
      case "model.used": {
        const data = event.data as { modelId: string };
        this.setAssistantModel(assistantId, data.modelId);
        break;
      }
      case "model.fallback": {
        const data = event.data as { from: string; to: string; reason: string };
        const msg = this.messages.find((m) => m.id === assistantId);
        if (msg) {
          if (!msg.modelFallback) msg.modelFallback = [];
          msg.modelFallback.push(data);
        }
        break;
      }
      case "model.routed": {
        const data = event.data as { model: string; category: string; reason: string };
        const msg = this.messages.find((m) => m.id === assistantId);
        if (msg) {
          msg.routedTo = { model: data.model, category: data.category, reason: data.reason };
        }
        break;
      }
      case "model.escalated": {
        const data = event.data as { from: string; to: string; reason: string };
        const msg = this.messages.find((m) => m.id === assistantId);
        if (msg) {
          if (!msg.modelEscalations) msg.modelEscalations = [];
          msg.modelEscalations.push(data);
        }
        break;
      }
      case "tool.start": {
        const data = event.data as { toolCallId: string; toolName: string };
        this.addToolCallToAssistant(assistantId, {
          id: data.toolCallId,
          name: data.toolName,
          args: {},
          pending: true,
        });
        this.appendTimelineSegment(assistantId, { type: "tool", toolCallId: data.toolCallId });
        break;
      }
      case "tool.args": {
        const data = event.data as { toolCallId: string; args: Record<string, unknown> };
        const msg = this.messages.find((m) => m.id === assistantId);
        const tc = msg?.toolCalls?.find((t) => t.id === data.toolCallId);
        if (tc) tc.args = data.args;
        break;
      }
      case "tool.result": {
        const data = event.data as { toolCallId: string; result: unknown };
        this.updateToolCall(assistantId, data.toolCallId, {
          result: data.result,
          pending: false,
        });
        break;
      }
      case "tool.error": {
        const data = event.data as { toolCallId: string; error: string };
        this.updateToolCall(assistantId, data.toolCallId, {
          error: data.error,
          pending: false,
        });
        break;
      }
      case "tool.approval_required": {
        const data = event.data as { toolCallId: string; toolName: string; args: Record<string, unknown> };
        this.addToolCallToAssistant(assistantId, {
          id: data.toolCallId,
          name: data.toolName,
          args: data.args,
          pending: true,
          approvalRequired: true,
        });
        this.appendTimelineSegment(assistantId, { type: "tool", toolCallId: data.toolCallId });
        break;
      }
      case "tool.cache_hit": {
        const data = event.data as { toolCallId: string };
        this.updateToolCall(assistantId, data.toolCallId, { cached: true });
        break;
      }
      case "done":
      case "cancelled":
        this.setAssistantStatus(assistantId, null);
        this.finishStreaming();
        break;
      case "task.summary": {
        const data = event.data as TaskSummaryData | undefined;
        if (data) {
          const msg = this.messages.find((m) => m.id === assistantId);
          if (msg) msg.taskSummary = data;
        }
        break;
      }
      case "error": {
        const data = event.data as { message?: string } | undefined;
        if (data?.message) {
          this.setAssistantError(assistantId, data.message);
        }
        this.setAssistantStatus(assistantId, null);
        this.finishStreaming();
        break;
      }
      case "model.free_exhausted": {
        const data = event.data as { message: string; triedModels: string[] };
        this.setFreeModelsExhausted(assistantId, data.message, data.triedModels);
        this.setAssistantStatus(assistantId, null);
        this.finishStreaming();
        break;
      }
    }
  }
}

export const chatStore = new ChatStore();
