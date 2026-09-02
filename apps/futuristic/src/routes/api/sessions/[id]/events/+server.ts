import { sessionStore, createSSEStream, getWorkspace, getEngine, ensureLocalModel, type LocalModelRef } from "@adaan/core/server";
import type { AgentEvent } from "@adaan/core";

interface QueuedMessage {
  message: string;
  model?: string;
  contextLength?: number;
  localModel?: LocalModelRef;
}

export async function GET({ params }) {
  const found = sessionStore.get(params.id);
  if (!found) {
    return new Response("Session not found", { status: 404 });
  }
  // Bind to a narrowed const so the closure below sees a non-nullable type.
  const session = found;

  const iterable = (session as any)._iterable;
  if (!iterable) {
    return new Response("No active stream", { status: 404 });
  }

  // Wrap the iterable to intercept completion events and drain the message
  // queue if any messages were queued while the agent was running.
  async function* withQueueDrain() {
    try {
      for await (const event of iterable) {
        yield event;
        // When the current turn finishes, check if there are queued messages.
        if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
          const queue = (session as any)._messageQueue as QueuedMessage[] | undefined;
          if (queue && queue.length > 0) {
            (session as any)._messageQueue = [];
            const next = queue.shift();
            if (next && queue.length > 0) (session as any)._messageQueue = queue;
            else (session as any)._messageQueue = [];

            if (!next) continue;

            // Start the next queued turn
            const ws = getWorkspace(session.workspaceId);
            const engine = getEngine();

            // If the queued turn targets a local model, make sure its server
            // is up before running the engine (it may have been stopped to
            // serve the previous turn's model). Blocks until ready.
            let model = next.model;
            if (next.localModel) {
              try {
                model = await ensureLocalModel(next.localModel);
              } catch (e) {
                const message = e instanceof Error ? e.message : "Failed to start local model server";
                yield {
                  type: "error",
                  sessionId: session.id,
                  data: { message },
                  timestamp: Date.now(),
                } satisfies AgentEvent;
                continue;
              }
            }

            const nextIterable = engine.run(session, ws, next.message, model, next.contextLength || 4096);
            (session as any)._iterable = nextIterable;

            // Yield events from the next turn
            for await (const nextEvent of nextIterable) {
              yield nextEvent;
            }
          }
        }
      }
    } catch {
      // generator was abandoned — ignore
    }
  }

  const stream = createSSEStream(withQueueDrain());
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
