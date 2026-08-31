import type {
  ProviderMessage,
  ProviderTool,
  ProviderChatOptions,
  ProviderEvent,
  ModelInfo,
  ModelGroups,
} from "../../../types.js";
import type { LLMProvider } from "../provider.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/**
 * If we don't receive any bytes from the model (including the initial
 * response headers) for this long, treat the request as stalled and abort
 * it. Free-tier models are frequently overloaded and can stop streaming
 * mid-response (e.g. right after emitting a tool call) without ever closing
 * the connection, which would otherwise hang the agent loop forever.
 */
const STREAM_IDLE_TIMEOUT_MS = 45_000;

/**
 * Default free model pool for rotation.
 * These are free, tool-capable models on OpenRouter.
 */
export const DEFAULT_FREE_POOL: string[] = [
  "deepseek/deepseek-r1:free",
  "qwen/qwen-2.5-coder-32b-instruct:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
];

interface OpenRouterProviderOptions {
  apiKey: string;
  baseUrl?: string;
  freePool?: string[];
  siteUrl?: string;
  siteName?: string;
  idleTimeoutMs?: number;
}

export class OpenRouterProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private freePool: string[];
  private siteUrl: string;
  private siteName: string;
  private idleTimeoutMs: number;
  private lastUsed: Map<string, number> = new Map(); // model -> timestamp (for LRU)

  constructor(opts: OpenRouterProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? OPENROUTER_BASE;
    this.freePool = opts.freePool ?? DEFAULT_FREE_POOL;
    this.siteUrl = opts.siteUrl ?? "http://localhost";
    this.siteName = opts.siteName ?? "AdaanIDE";
    this.idleTimeoutMs = opts.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  }

  /**
   * Pick the least-recently-used model from the free pool.
   */
  pickModel(preferred?: string): string {
    if (preferred && !preferred.endsWith(":free")) {
      // User selected a paid model — use it directly
      return preferred;
    }

    // If user has a preferred free model, use it
    if (preferred && this.freePool.includes(preferred)) {
      this.lastUsed.set(preferred, Date.now());
      return preferred;
    }

    // LRU selection from pool
    let oldest = this.freePool[0];
    let oldestTime = this.lastUsed.get(oldest) ?? 0;
    for (const model of this.freePool) {
      const time = this.lastUsed.get(model) ?? 0;
      if (time < oldestTime) {
        oldestTime = time;
        oldest = model;
      }
    }
    this.lastUsed.set(oldest, Date.now());
    return oldest;
  }

  /**
   * Get the next model in the pool for failover (after a 429/503).
   */
  nextModel(currentModel: string): string | null {
    const idx = this.freePool.indexOf(currentModel);
    if (idx === -1) return null;
    // Try all other models in order
    for (let i = 1; i < this.freePool.length; i++) {
      const next = this.freePool[(idx + i) % this.freePool.length];
      if (next !== currentModel) {
        this.lastUsed.set(next, Date.now());
        return next;
      }
    }
    return null;
  }

  async *chat(
    messages: ProviderMessage[],
    options: ProviderChatOptions,
  ): AsyncIterable<ProviderEvent> {
    const model = options.model;
    const maxRetries = Math.max(0, this.freePool.length - 1);
    let currentModel = model;
    let retries = 0;

    while (retries <= maxRetries) {
      try {
        yield* this.doChatRequest(messages, { ...options, model: currentModel });
        return;
      } catch (e: any) {
        const statusCode = e.statusCode ?? e.status;
        const retryable = statusCode === 429 || statusCode === 503;

        if (!retryable || retries >= maxRetries) {
          yield {
            type: "error",
            data: {
              message: e.message ?? "Unknown provider error",
              statusCode,
              retryable: false,
            },
          };
          return;
        }

        // Failover to next model in pool. Models picked from the live
        // /models list are usually not in the static pool, so fall back to
        // rotating into the pool instead of giving up.
        const next = this.nextModel(currentModel) ?? this.pickModel();
        if (!next || next === currentModel) {
          yield {
            type: "error",
            data: {
              message: `Rate limited on ${currentModel} and no fallback available`,
              statusCode,
              retryable: false,
            },
          };
          return;
        }

        currentModel = next;
        retries++;
      }
    }
  }

  private async *doChatRequest(
    messages: ProviderMessage[],
    options: ProviderChatOptions,
  ): AsyncIterable<ProviderEvent> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = "auto";
    }
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    // Combine the caller's abort signal (user cancel) with an internal idle
    // timer: if we go STREAM_IDLE_TIMEOUT_MS without receiving any bytes —
    // including the very first response — we abort and surface a retryable
    // error so the caller can fail over to another model instead of hanging.
    const internalController = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        internalController.abort();
      }, this.idleTimeoutMs);
    };
    const onUserAbort = () => internalController.abort();
    if (options.signal) {
      if (options.signal.aborted) internalController.abort();
      else options.signal.addEventListener("abort", onUserAbort, { once: true });
    }
    const cleanupTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      options.signal?.removeEventListener("abort", onUserAbort);
    };

    armIdleTimer();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": this.siteUrl,
          "X-Title": this.siteName,
        },
        body: JSON.stringify(body),
        signal: internalController.signal,
      });
    } catch (e: any) {
      cleanupTimer();
      if (timedOut) {
        const err = new Error(`Request to ${options.model} timed out waiting for a response (>${this.idleTimeoutMs}ms)`);
        (err as any).statusCode = 503;
        throw err;
      }
      throw e;
    }

    // Headers arrived — reset the idle clock for the body stream.
    armIdleTimer();

    if (!response.ok) {
      cleanupTimer();
      const text = await response.text().catch(() => "Unknown error");
      const err = new Error(`OpenRouter error ${response.status}: ${text}`);
      (err as any).statusCode = response.status;
      throw err;
    }

    if (!response.body) {
      cleanupTimer();
      throw new Error("No response body from OpenRouter");
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Track tool call accumulation across chunks. tool_call.start is emitted
    // only once streaming ends, so the name is guaranteed to be complete
    // (providers may split the name across chunks).
    const toolCallAccumulators: Map<number, { id: string; name: string; args: string }> = new Map();
    let finishReason: string = "stop";
    let streamDone = false;

    try {
      while (!streamDone) {
        let done: boolean, value: Uint8Array | undefined;
        try {
          ({ done, value } = await reader.read());
        } catch (e: any) {
          if (timedOut) {
            const err = new Error(`Model ${options.model} stopped streaming (idle >${this.idleTimeoutMs}ms) — failing over`);
            (err as any).statusCode = 503;
            throw err;
          }
          throw e;
        }
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        // Only real data counts as progress. OpenRouter sends keep-alive
        // comment lines (": OPENROUTER PROCESSING") while a model is queued;
        // those must NOT reset the idle clock or a stalled request hangs
        // forever. A partial "data:" line still in the buffer also counts.
        let madeProgress = buffer.startsWith("data:");

        for (const line of lines) {
          if (!line.trim()) continue;
          if (line.startsWith(":")) continue; // SSE comment / keep-alive
          if (!line.startsWith("data: ")) continue;
          madeProgress = true;

          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            // Stop reading, but fall through so accumulated tool calls are
            // emitted below before the finish event.
            streamDone = true;
            break;
          }

          try {
            const chunk = JSON.parse(data);
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;

            // Handle text content
            if (delta?.content) {
              yield { type: "text.delta", data: { text: delta.content } };
            }

            // Handle tool calls (streaming accumulation)
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                // Some free models omit the index field entirely. If a new
                // tool call arrives with a different id but no index, we must
                // not append its name/args to the previous call at index 0 —
                // that concatenates two JSON objects and produces malformed
                // arguments. Assign a synthetic index based on id instead.
                let idx = tc.index;
                if (idx === undefined || idx === null) {
                  // If this chunk has an id that differs from the current
                  // index-0 accumulator, it's a new tool call — give it the
                  // next available index.
                  const acc0 = toolCallAccumulators.get(0);
                  if (acc0 && tc.id && acc0.id && tc.id !== acc0.id) {
                    idx = toolCallAccumulators.size;
                  } else {
                    idx = 0;
                  }
                }
                let acc = toolCallAccumulators.get(idx);
                if (!acc) {
                  acc = {
                    id: "",
                    name: "",
                    args: "",
                  };
                  toolCallAccumulators.set(idx, acc);
                }

                // Accumulate
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name += tc.function.name;
                if (tc.function?.arguments) {
                  acc.args += tc.function.arguments;
                  yield {
                    type: "tool_call.args.delta",
                    data: { index: idx, delta: tc.function.arguments },
                  };
                }
              }
            }

            // Track finish reason
            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }

        // Real data arrived — the model is making progress, reset the idle
        // clock.
        if (madeProgress) armIdleTimer();
      }
    } finally {
      reader.releaseLock();
      cleanupTimer();
    }

    // Emit start + complete events for any accumulated tool calls. Start is
    // emitted here (not mid-stream) so the tool name is always complete.
    for (const [idx, acc] of toolCallAccumulators) {
      yield {
        type: "tool_call.start",
        data: { toolCallId: acc.id, toolName: acc.name, index: idx },
      };
      yield {
        type: "tool_call.complete",
        data: {
          index: idx,
          toolCallId: acc.id,
          toolName: acc.name,
          arguments: acc.args,
        },
      };
    }

    // Emit finish
    yield {
      type: "finish",
      data: {
        finishReason: mapFinishReason(finishReason),
        model: options.model,
      },
    };
  }

  async listModels(): Promise<ModelGroups> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": this.siteUrl,
        "X-Title": this.siteName,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    const data = await response.json() as { data: any[] };
    const free: ModelInfo[] = [];
    const paid: ModelInfo[] = [];

    for (const model of data.data) {
      const id: string = model.id;
      const isFree = id.endsWith(":free") || (model.pricing?.prompt === "0" && model.pricing?.completion === "0");
      const supportedParams: string[] = model.supported_parameters ?? [];
      const toolsCapable = supportedParams.includes("tools") || supportedParams.includes("tool_choice");

      const info: ModelInfo = {
        id,
        name: model.name ?? id,
        contextLength: model.context_length ?? 4096,
        pricing: {
          prompt: model.pricing?.prompt ?? "0",
          completion: model.pricing?.completion ?? "0",
        },
        toolsCapable,
        free: isFree,
      };

      if (isFree) {
        free.push(info);
      } else {
        paid.push(info);
      }
    }

    // Sort: tools-capable first, then by name
    free.sort((a, b) => (Number(b.toolsCapable) - Number(a.toolsCapable)) || a.name.localeCompare(b.name));
    paid.sort((a, b) => (Number(b.toolsCapable) - Number(a.toolsCapable)) || a.name.localeCompare(b.name));

    return { free, paid };
  }
}

function mapFinishReason(reason: string): "stop" | "tool_calls" | "length" | "content_filter" {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}
