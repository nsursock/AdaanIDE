import type { RequestHandler } from "./types-route.js";
import { Workspace } from "./workspace.js";
import { OpenRouterProvider, DEFAULT_FREE_POOL } from "./agent/providers/openrouter.js";
import { AgentEngine } from "./agent/engine.js";
import { defaultRegistry } from "./agent/tools/registry.js";
import { sessionStore, AgentSession } from "./agent/session.js";
import { getWatcher } from "./watcher.js";
import { modelRegistry } from "./registry/index.js";
import { ensureServing } from "./local/index.js";
import type { AgentEvent, ModelGroups } from "../types.js";

/**
 * Global provider instance — initialized with the API key.
 * Each app sets this up at startup.
 */
let provider: OpenRouterProvider | null = null;
let engine: AgentEngine | null = null;
/**
 * Currently-configured custom endpoint base URL (null/empty = default
 * OpenRouter). Tracked separately so a key-only update preserves the
 * previously-set endpoint.
 */
let currentBaseUrl: string | undefined;

/**
 * Build a provider, substituting a placeholder API key when none is
 * configured but a custom (non-OpenRouter) endpoint is. Local
 * OpenAI-compatible servers (Rapid-MLX, mlx-lm, Ollama, LM Studio) accept
 * any non-empty key, so "not-needed" keeps the Authorization header well
 * formed without requiring the user to enter one.
 */
function makeProvider(apiKey: string, baseUrl?: string): OpenRouterProvider {
  const key = apiKey || (baseUrl ? "not-needed" : "");
  return new OpenRouterProvider({ apiKey: key, baseUrl });
}

export function initProvider(apiKey: string, baseUrl?: string) {
  // Don't throw here — the hook runs on every request including SSR.
  // Defer the error to when the provider is actually used.
  currentBaseUrl = baseUrl;
  provider = makeProvider(apiKey, baseUrl);
  engine = new AgentEngine({ provider, registry: defaultRegistry });
  modelRegistry.setProvider(provider);
}

/**
 * Swap the API key on the live provider at runtime. Called when a user
 * enters a key via the settings UI — the env var remains the initial
 * default, but a UI-provided key takes precedence. Preserves the
 * currently-configured base URL.
 */
export function updateProviderKey(apiKey: string) {
  if (!provider) {
    initProvider(apiKey, currentBaseUrl);
    return;
  }
  provider = makeProvider(apiKey, currentBaseUrl);
  engine = new AgentEngine({ provider, registry: defaultRegistry });
  modelRegistry.setProvider(provider);
}

/**
 * Swap the endpoint base URL on the live provider at runtime. Called when
 * a user enters a custom OpenAI-compatible endpoint (e.g. a local
 * Rapid-MLX server) via the settings UI. Preserves the current API key.
 *
 * Note: This changes the provider's primary baseUrl, which means ALL
 * requests go to the custom endpoint. For local model integration where
 * you want to seamlessly switch between local and OpenRouter models,
 * use setLocalEndpoint() instead — it routes only local models to the
 * local server while keeping OpenRouter requests going to openrouter.ai.
 */
export function updateProviderBaseUrl(baseUrl: string) {
  currentBaseUrl = baseUrl || undefined;
  if (!provider) {
    initProvider("", currentBaseUrl);
    return;
  }
  // Reuse the existing key (already normalized with a placeholder if empty
  // and a custom endpoint is set).
  const existingKey = provider["apiKey"] as string;
  provider = makeProvider(existingKey, currentBaseUrl);
  engine = new AgentEngine({ provider, registry: defaultRegistry });
  modelRegistry.setProvider(provider);
}

/**
 * Configure a local endpoint on the live provider. When set, requests for
 * models in `models` are routed to `endpoint` instead of OpenRouter.
 * This allows seamless switching between local and OpenRouter models
 * without changing the provider's primary baseUrl.
 *
 * Pass null to clear the local endpoint (all requests go to OpenRouter).
 */
export function setLocalEndpoint(endpoint: string | null, models: string[] = []) {
  if (!provider) {
    initProvider("", undefined);
  }
  if (provider) {
    provider.setLocalEndpoint(endpoint, models);
  }
}

/** Local model metadata the client sends with chat requests so the server
 *  can make sure the model's server is up before any LLM request goes out. */
export interface LocalModelRef {
  providerId: string;
  modelId: string;
  hfRepo?: string;
  singleModel?: boolean;
}

/** Ensure a local model's server is running and configure the provider to
 *  route requests for it to the local endpoint. Blocks until the server is
 *  ready (fast path when it's already serving the model), so callers can
 *  await this right before running the agent and never hit a dead endpoint.
 *
 *  Returns the model name to use in chat requests — the name the server's
 *  API expects, which may differ from the discovery alias (e.g.
 *  "mlx-community/Qwen3.5-4B-MLX-4bit" vs "qwen3.5-4b-4bit"). */
export async function ensureLocalModel(local: LocalModelRef): Promise<string> {
  const { endpoint, servedModel } = await ensureServing(
    local.providerId,
    local.modelId,
    local.hfRepo,
    local.singleModel !== false,
  );
  const wire = servedModel ?? local.modelId;
  setLocalEndpoint(endpoint, [wire]);
  return wire;
}

export function getProvider(): OpenRouterProvider {
  if (!provider) throw new Error("Provider not initialized. Call initProvider() first.");
  // A custom (local) endpoint needs no API key — only the default
  // OpenRouter endpoint requires one.
  if (!provider["apiKey"] && !currentBaseUrl) {
    throw new Error("OPENROUTER_API_KEY is not set. Add it to your .env file or enter a key in Settings.");
  }
  return provider;
}

export function getEngine(): AgentEngine {
  if (!engine) throw new Error("Provider not initialized. Call initProvider() first.");
  return engine;
}

/**
 * Fetch the OpenRouter model catalog from the default OpenRouter endpoint,
 * independent of the active provider's baseUrl. This ensures the OpenRouter
 * model list is always available in the picker even when the active provider
 * has been repointed at a local endpoint (e.g. after serving a local model).
 *
 * Uses the user's API key if available (for rate limits), but the catalog
 * endpoint is public and works without one. Returns null on failure so the
 * caller can still return local models.
 */
export async function fetchOpenRouterCatalog(): Promise<ModelGroups | null> {
  const key = provider?.["apiKey"] as string | undefined;
  const catalogProvider = new OpenRouterProvider({
    apiKey: key || "catalog-fetch",
  });
  try {
    return await catalogProvider.listModels();
  } catch {
    return null;
  }
}

// --- Workspace registry ------------------------------------------------------

const workspaces: Map<string, Workspace> = new Map();

export function getWorkspace(rootPath: string): Workspace {
  const resolved = rootPath;
  let ws = workspaces.get(resolved);
  if (!ws) {
    ws = new Workspace(resolved);
    workspaces.set(resolved, ws);
  }
  return ws;
}

export function registerWorkspace(ws: Workspace) {
  workspaces.set(ws.rootPath, ws);
}

export function getSession(id: string): AgentSession | undefined {
  return sessionStore.get(id);
}

export { sessionStore, AgentSession, Workspace, getWatcher, DEFAULT_FREE_POOL };

// --- SSE helper --------------------------------------------------------------

/**
 * Create a ReadableStream that emits SSE-formatted events.
 */
export function createSSEStream(eventIterable: AsyncIterable<AgentEvent>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancelled = false;
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of eventIterable) {
          if (cancelled) break;
          const data = `data: ${JSON.stringify(event)}\n\n`;
          // Guard enqueue — if the client disconnected, the controller
          // may be in an errored state. Swallow the TypeError instead of
          // crashing the server-side generator consumption loop.
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            cancelled = true;
            break;
          }
        }
      } catch (e) {
        if (cancelled) {
          // Client disconnected — don't emit an error event into a dead
          // stream; just close.
        } else {
          const errorEvent: AgentEvent = {
            type: "error",
            sessionId: "",
            data: { message: e instanceof Error ? e.message : "Stream error" },
            timestamp: Date.now(),
          };
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
          } catch {
            // controller already errored — nothing we can do
          }
        }
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      // Client disconnected — stop consuming the iterable. Calling
      // return() on the async generator triggers its finally block so
      // the engine can finalize the task as cancelled.
      cancelled = true;
      if (typeof (eventIterable as any).return === "function") {
        (eventIterable as any).return().catch(() => {});
      }
    },
  });
}

/**
 * Create a generic SSE stream from a callback that pushes events.
 */
export function createCallbackSSEStream(onSubscribe: (push: (event: unknown) => void) => () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const push = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const unsubscribe = onSubscribe(push);
      // Store cleanup — when the stream is cancelled, call unsubscribe
      (controller as any)._unsubscribe = unsubscribe;
    },
    cancel() {
      // Handled by the stored unsubscribe
    },
  });
}
