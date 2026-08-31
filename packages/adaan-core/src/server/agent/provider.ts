import type {
  ProviderMessage,
  ProviderTool,
  ProviderChatOptions,
  ProviderEvent,
} from "../../types.js";

/**
 * Abstract interface for LLM providers.
 * The AgentEngine talks to this, not to any specific provider.
 */
export interface LLMProvider {
  /**
   * Send a chat completion request with streaming.
   * Returns an async iterable of ProviderEvent.
   */
  chat(
    messages: ProviderMessage[],
    options: ProviderChatOptions,
  ): AsyncIterable<ProviderEvent>;

  /**
   * List available models, grouped by free/paid.
   */
  listModels(): Promise<{ free: import("../../types.js").ModelInfo[]; paid: import("../../types.js").ModelInfo[] }>;
}
