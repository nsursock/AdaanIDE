import type { AgentEvent, ModelInfo, ModelGroups } from "../types.js";
import { settingsStore } from "./settings.svelte.js";

export interface ChatMessageEntry {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
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
  modelUsed?: string;
  timestamp: number;
  error?: string;
  /** Set when every free model we tried for this turn is currently
   *  unavailable — the UI should offer to retry with a paid model. */
  freeModelsExhausted?: { message: string; triedModels: string[] };
}

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
    const all = [...models.free, ...models.paid];
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

  setAssistantModel(id: string, modelId: string) {
    const msg = this.messages.find((m) => m.id === id);
    if (msg) msg.modelUsed = modelId;
  }

  setAssistantError(id: string, error: string) {
    const msg = this.messages.find((m) => m.id === id);
    if (msg) msg.error = error;
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
        break;
      }
      case "model.used": {
        const data = event.data as { modelId: string };
        this.setAssistantModel(assistantId, data.modelId);
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
        break;
      }
      case "tool.cache_hit": {
        const data = event.data as { toolCallId: string };
        this.updateToolCall(assistantId, data.toolCallId, { cached: true });
        break;
      }
      case "done":
      case "cancelled":
        this.finishStreaming();
        break;
      case "error": {
        const data = event.data as { message?: string } | undefined;
        if (data?.message) {
          this.setAssistantError(assistantId, data.message);
        }
        this.finishStreaming();
        break;
      }
      case "model.free_exhausted": {
        const data = event.data as { message: string; triedModels: string[] };
        this.setFreeModelsExhausted(assistantId, data.message, data.triedModels);
        this.finishStreaming();
        break;
      }
    }
  }
}

export const chatStore = new ChatStore();
