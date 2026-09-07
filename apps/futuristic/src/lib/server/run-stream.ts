import { reviewRunManager } from "@adaan/core/server";

/**
 * Build an SSE response that streams a managed review run's events:
 * replays the accumulated state (so re-attaching clients catch up), then
 * streams live events until the run terminates.
 *
 * Crucially, the run is owned by the run manager, NOT by this request — when
 * the client disconnects (project switch, tab reload, app backgrounded), we
 * only unsubscribe; the run keeps going and is re-attachable via
 * GET /api/review/run?runId=.
 */
export function runEventStream(resultId: string): Response | null {
  const sub = reviewRunManager.subscribe(resultId);
  if (!sub) return null;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const readable = new ReadableStream({
    start(streamCtrl) {
      const send = (ev: unknown) => {
        try {
          streamCtrl.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          // streamCtrl closed — detached client; the run continues regardless.
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        try { streamCtrl.close(); } catch { /* already closed */ }
      };
      // Subscribe BEFORE replaying so no live event is lost between the two
      // (subscribe() is already synchronous — this is belt & braces).
      unsubscribe = sub.live((ev) => {
        send(ev);
        const phase = (ev as { phase?: string } | null)?.phase;
        if (phase === "complete" || phase === "error" || phase === "cancelled") close();
      });
      for (const ev of sub.replay) send(ev);
      if (sub.done) close();
    },
    cancel() {
      // Client went away — detach only; NEVER abort the run server-side.
      closed = true;
      unsubscribe?.();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
