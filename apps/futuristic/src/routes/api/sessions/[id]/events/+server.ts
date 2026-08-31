import { sessionStore, createSSEStream } from "@adaan/core/server";

export async function GET({ params }) {
  const session = sessionStore.get(params.id);
  if (!session) {
    return new Response("Session not found", { status: 404 });
  }

  const iterable = (session as any)._iterable;
  if (!iterable) {
    return new Response("No active stream", { status: 404 });
  }

  const stream = createSSEStream(iterable);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
