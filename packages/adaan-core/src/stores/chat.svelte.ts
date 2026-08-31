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

  clear() {
    this.messages = [];
    this.sessionId = null;
    this.streaming = false;
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
      case "error":
      case "cancelled":
        this.finishStreaming();
        break;
    }
  }
}

export const chatStore = new ChatStore();
