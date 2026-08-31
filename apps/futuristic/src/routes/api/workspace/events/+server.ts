import { getWatcher } from "@adaan/core/server";

export async function GET({ url }) {
  const rootPath = url.searchParams.get("root");
  if (!rootPath) return new Response("root required", { status: 400 });

  const watcher = getWatcher(rootPath);
  await watcher.start().catch(() => {});

  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const push = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const unsubscribe = watcher.subscribe(push);

      // Keep-alive heartbeat
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 30000);

      // Cleanup on cancel
      cleanup = () => {
        unsubscribe();
        clearInterval(heartbeat);
      };
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
