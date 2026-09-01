import { sessionStore, createSSEStream, getWorkspace, getEngine } from "@adaan/core/server";

export async function GET({ params }) {
  const session = sessionStore.get(params.id);
  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

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
          const queue = (session as any)._messageQueue as Array<{ message: string; model?: string; contextLength?: number }> | undefined;
          if (queue && queue.length > 0) {
            (session as any)._messageQueue = [];
            const next = queue.shift();
            if (next && queue.length > 0) (session as any)._messageQueue = queue;
            else (session as any)._messageQueue = [];

            // Start the next queued turn
            const ws = getWorkspace(session.workspaceId);
            const engine = getEngine();
            const nextIterable = engine.run(session, ws, next.message, next.model, next.contextLength || 4096);
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
