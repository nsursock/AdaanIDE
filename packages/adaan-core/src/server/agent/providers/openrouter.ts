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
 * These are free, tool-capable models on OpenRouter, sourced from the live
 * /models catalog. The free-tier lineup churns often — the live catalog is
 * always preferred for failover (see chat()), so this pool is only a
 * zero-network-latency fallback when the catalog endpoint is unreachable.
 * Stale entries here are harmless: they 404 and get skipped.
 */
export const DEFAULT_FREE_POOL: string[] = [
  "z-ai/glm-5.2:free",
  "cohere/north-mini-code:free",
  "minimax/minimax-m3:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "google/gemma-4-31b-it:free",
];

/** Extra failover attempts sourced from the live /models catalog once the
 *  static pool is exhausted (OpenRouter's free-tier lineup churns often). */
const LIVE_FALLBACK_LIMIT = 4;

/** How long to trust a cached live-catalog fetch before refetching. */
const LIVE_MODELS_CACHE_TTL_MS = 5 * 60_000;

/** Timeout for the /models catalog fetch — must not hang a chat turn. */
const LIST_MODELS_TIMEOUT_MS = 8_000;

/**
 * Before abandoning the user's explicitly-selected model for a different
 * free model, give it one short retry with backoff. Free-tier 429/503s are
 * frequently per-minute and clear within a couple of seconds, so bailing to
 * an unrelated model (e.g. from GLM to Cohere) on the very first hiccup
 * surprises users who deliberately picked a specific model.
 */
const SAME_MODEL_RETRY_DELAY_MS = 1_500;

interface OpenRouterProviderOptions {
  apiKey: string;
  baseUrl?: string;
  freePool?: string[];
  siteUrl?: string;
  siteName?: string;
  idleTimeoutMs?: number;
  /** Backoff before retrying the same model on a transient 429/503. */
  retryDelayMs?: number;
}

export class OpenRouterProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private freePool: string[];
  private siteUrl: string;
  private siteName: string;
  private idleTimeoutMs: number;
  private retryDelayMs: number;
  private lastUsed: Map<string, number> = new Map(); // model -> timestamp (for LRU)
  private liveFreeModelsCache: { ids: string[]; fetchedAt: number } | null = null;

  constructor(opts: OpenRouterProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? OPENROUTER_BASE;
    this.freePool = opts.freePool ?? DEFAULT_FREE_POOL;
    this.siteUrl = opts.siteUrl ?? "http://localhost";
    this.siteName = opts.siteName ?? "AdaanIDE";
    this.idleTimeoutMs = opts.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
    this.retryDelayMs = opts.retryDelayMs ?? SAME_MODEL_RETRY_DELAY_MS;
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
    const initialModel = options.model;
    const tried = new Set<string>([initialModel]);
    // Models we've already given a same-model retry to (one per model). A
    // free-tier 429/503 is often a per-minute limit that clears in a second
    // or two, so before abandoning the user's deliberately-chosen model for
    // an unrelated one, give it a single backoff retry.
    const retried = new Set<string>();
    let currentModel = initialModel;
    // Budget: every model in the static pool, plus a handful of extra
    // attempts sourced from the live /models catalog (models come and go on
    // OpenRouter's free tier faster than we can keep a hardcoded list current).
    // An explicitly empty pool means "no failover" — respect that and never
    // hit the network for a live catalog fallback.
    const poolEnabled = this.freePool.length > 0;
    const maxAttempts = poolEnabled ? this.freePool.length + LIVE_FALLBACK_LIMIT : 1;
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        yield* this.doChatRequest(messages, { ...options, model: currentModel });
        return;
      } catch (e: any) {
        const statusCode = e.statusCode ?? e.status;
        // 429/503 are rate-limit/overload signals. OpenRouter also returns a
        // 404 when a model slug that was previously free has been withdrawn
        // or deprecated (e.g. "This model is unavailable for free...") — that
        // is just as recoverable by picking another free model, so treat it
        // the same way instead of dying on what looks like a permanent error.
        // A 402 "Insufficient balance" means the *backing provider* for that
        // particular free model is out of credits — OpenRouter routes free
        // models through different providers, so another free model backed by
        // a different provider may still work.
        const retryable =
          statusCode === 429 ||
          statusCode === 503 ||
          statusCode === 402 ||
          isModelUnavailableError(statusCode, e.message);

        // Transient overload/rate-limit on a model we haven't retried yet:
        // try the SAME model once more after a short backoff instead of
        // immediately jumping to a different model family. 402/404 are not
        // transient (credits/availability won't change in 1.5s), so those go
        // straight to failover.
        const transient = statusCode === 429 || statusCode === 503;
        if (transient && !retried.has(currentModel)) {
          retried.add(currentModel);
          try {
            await sleep(this.retryDelayMs, options.signal);
          } catch {
            // Aborted during backoff — surface as a clean cancel/error.
            yield {
              type: "error",
              data: { message: "Cancelled", statusCode, retryable: false },
            };
            return;
          }
          continue;
        }

        attempts++;
        if (!retryable || attempts >= maxAttempts) {
          // If every model we tried was a free-tier slug, the free tier is
          // effectively unavailable right now — let the caller offer the
          // user a paid fallback instead of just reporting a dead end.
          const allTriedWereFree = [...tried].every((m) => m.endsWith(":free"));
          yield {
            type: "error",
            data: {
              message: e.message ?? "Unknown provider error",
              statusCode,
              retryable: false,
              allFreeModelsExhausted: allTriedWereFree && tried.size > 1,
              triedModels: [...tried],
            },
          };
          return;
        }

        // Failover to a model we haven't tried yet. Prefer the LIVE catalog
        // (always current) over the static pool (may have stale slugs that
        // just waste a 404 hop). The static pool is a zero-network-latency
        // fallback for when the catalog endpoint itself is unreachable.
        let next: string | null = null;
        if (poolEnabled) {
          const live = await this.getLiveFreeModelIds();
          next = live.find((m) => !tried.has(m)) ?? null;
        }
        if (!next) {
          next = this.freePool.find((m) => !tried.has(m)) ?? null;
        }

        if (!next) {
          const allTriedWereFree = [...tried].every((m) => m.endsWith(":free"));
          yield {
            type: "error",
            data: {
              message: `${currentModel} failed and no untried fallback model is available`,
              statusCode,
              retryable: false,
              allFreeModelsExhausted: allTriedWereFree && tried.size > 1,
              triedModels: [...tried],
            },
          };
          return;
        }

        // Surface the switch so the caller/UI can show it instead of
        // silently labeling the reply with a model the user never picked.
        yield {
          type: "model.fallback",
          data: { from: currentModel, to: next, reason: e.message ?? String(statusCode) },
        };
        tried.add(next);
        this.lastUsed.set(next, Date.now());
        currentModel = next;
      }
    }
  }

  /**
   * Fetch the current list of free model ids from OpenRouter, cached briefly
   * so repeated failovers within the same burst of requests don't all hit
   * the catalog endpoint. Falls back to an empty list on error so callers
   * can treat "no live data" the same as "no more fallbacks".
   */
  private async getLiveFreeModelIds(): Promise<string[]> {
    const now = Date.now();
    if (this.liveFreeModelsCache && now - this.liveFreeModelsCache.fetchedAt < LIVE_MODELS_CACHE_TTL_MS) {
      return this.liveFreeModelsCache.ids;
    }
    try {
      const { free } = await this.listModels();
      // Tools-capable models are sorted first by listModels(), which matters
      // here since the agent always needs tool calling.
      const ids = free.map((m) => m.id);
      this.liveFreeModelsCache = { ids, fetchedAt: now };
      return ids;
    } catch {
      return this.liveFreeModelsCache?.ids ?? [];
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
    // OpenRouter reports real token usage in the final SSE chunk (the one
    // with finish_reason, or a trailing empty-choices chunk just before
    // [DONE]). Capture it so the engine can record accurate telemetry
    // instead of estimating tokens from character counts.
    let usage: {
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      reasoningTokens: number;
      cost: number;
    } | undefined;

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

            // Capture usage. OpenRouter sends it on the final chunk (with
            // finish_reason) or on a trailing chunk with empty choices.
            // `cost` is OpenRouter's computed cost for this request; the
            // nested *_details fields carry cached/reasoning breakdowns.
            if (chunk.usage) {
              const u = chunk.usage;
              const cached =
                u.cached_tokens ??
                u.prompt_tokens_details?.cached_tokens ??
                0;
              const reasoning =
                u.completion_tokens_details?.reasoning_tokens ??
                u.reasoning_tokens ??
                0;
              usage = {
                inputTokens: u.prompt_tokens ?? 0,
                outputTokens: u.completion_tokens ?? 0,
                cachedTokens: cached,
                reasoningTokens: reasoning,
                cost: typeof u.cost === "number" ? u.cost : 0,
              };
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
        usage,
      },
    };
  }

  async listModels(): Promise<ModelGroups> {
    // Bounded with a timeout — this is called both for the model picker and
    // as a failover fallback mid-turn, and must never hang the whole request
    // if OpenRouter's catalog endpoint stalls.
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": this.siteUrl,
        "X-Title": this.siteName,
      },
      signal: AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
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

/**
 * OpenRouter returns a 404 (not the more typical 400) when a model slug has
 * been withdrawn from the free tier or deprecated, e.g.:
 * `{"error":{"message":"This model is unavailable for free. The paid
 * version is available now - use this slug instead: ...","code":404}}`.
 * That's functionally the same as a rate limit for our purposes — pick
 * another free model and keep going instead of failing the whole turn.
 */
function isModelUnavailableError(statusCode: number | undefined, message: string | undefined): boolean {
  if (statusCode !== 404) return false;
  if (!message) return true;
  return /unavailable|not a valid model|no endpoints found|model not found/i.test(message);
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

/**
 * Resolve after `ms`, unless `signal` aborts first (in which case reject so
 * the caller can bail out of a backoff when the user cancels the turn).
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
