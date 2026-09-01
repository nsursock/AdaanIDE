import type { RequestHandler } from "./types-route.js";
import { Workspace } from "./workspace.js";
import { OpenRouterProvider, DEFAULT_FREE_POOL } from "./agent/providers/openrouter.js";
import { AgentEngine } from "./agent/engine.js";
import { defaultRegistry } from "./agent/tools/registry.js";
import { sessionStore, AgentSession } from "./agent/session.js";
import { getWatcher } from "./watcher.js";
import { modelRegistry } from "./registry/index.js";
import type { AgentEvent, ModelGroups } from "../types.js";

/**
 * Global provider instance — initialized with the API key.
 * Each app sets this up at startup.
 */
let provider: OpenRouterProvider | null = null;
let engine: AgentEngine | null = null;

export function initProvider(apiKey: string) {
  // Don't throw here — the hook runs on every request including SSR.
  // Defer the error to when the provider is actually used.
  provider = new OpenRouterProvider({ apiKey: apiKey || "" });
  engine = new AgentEngine({ provider, registry: defaultRegistry });
  modelRegistry.setProvider(provider);
}

/**
 * Swap the API key on the live provider at runtime. Called when a user
 * enters a key via the settings UI — the env var remains the initial
 * default, but a UI-provided key takes precedence.
 */
export function updateProviderKey(apiKey: string) {
  if (!provider) {
    initProvider(apiKey);
    return;
  }
  provider = new OpenRouterProvider({ apiKey: apiKey || "" });
  engine = new AgentEngine({ provider, registry: defaultRegistry });
  modelRegistry.setProvider(provider);
}

export function getProvider(): OpenRouterProvider {
  if (!provider) throw new Error("Provider not initialized. Call initProvider() first.");
  if (!provider["apiKey"]) {
    throw new Error("OPENROUTER_API_KEY is not set. Add it to your .env file.");
  }
  return provider;
}

export function getEngine(): AgentEngine {
  if (!engine) throw new Error("Engine not initialized. Call initProvider() first.");
  return engine;
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
