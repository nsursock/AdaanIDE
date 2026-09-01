import { json } from "@sveltejs/kit";
import { sessionStore, getWorkspace, getEngine } from "@adaan/core/server";
import { randomUUID } from "node:crypto";

export async function POST({ request }) {
  const {
    workspaceRoot, message, model, contextLength,
    sessionId: existingId,
    routingMode, routingThreshold, routingTiers,
    explorationPaidEnabled,
    interrupt,
  } = await request.json();

  if (!workspaceRoot || !message) {
    return json({ error: "workspaceRoot and message required" }, { status: 400 });
  }

  const ws = getWorkspace(workspaceRoot);
  const engine = getEngine();

  // Phase 3: apply routing settings from the client.
  if (routingMode === "auto" || routingMode === "manual") {
    engine.routerSettings = {
      mode: routingMode,
      successThreshold: typeof routingThreshold === "number" ? routingThreshold : 0.6,
      allowedTiers: Array.isArray(routingTiers) && routingTiers.length > 0
        ? routingTiers
        : ["free", "mid", "frontier"],
    };
  }
  // Phase 4: exploration budget for paid models.
  engine.explorationPaidEnabled = explorationPaidEnabled === true;

  let sessionId = typeof existingId === "string" && existingId ? existingId : randomUUID();
  let session = existingId ? sessionStore.get(sessionId) : undefined;
  if (!session || session.workspaceId !== workspaceRoot) {
    sessionId = randomUUID();
    session = sessionStore.create(sessionId, workspaceRoot);
  }

  // interrupt: true (default) — abort the current in-flight turn and start
  // a new one immediately. The old generator exits silently via the
  // superseded flag.
  // interrupt: false (queue) — wait for the current turn to finish before
  // starting the new one. The message is stored and processed after the
  // current generator completes.
  if (interrupt === false && session.status === "running") {
    // Queue the message — it will be sent after the current turn finishes.
    // We store it on the session and the events endpoint consumer will
    // trigger it when the current turn's generator completes.
    const queue = (session as any)._messageQueue ?? [];
    queue.push({ message, model, contextLength });
    (session as any)._messageQueue = queue;
    return json({ sessionId, queued: true });
  }

  // Start the agent run as a background task — events are consumed via SSE.
  // session.resume() (called inside engine.run) aborts any in-flight turn.
  const iterable = engine.run(session, ws, message, model || undefined, contextLength || 4096);

  // Store the iterable on the session for the events endpoint to consume
  (session as any)._iterable = iterable;

  return json({ sessionId });
}
