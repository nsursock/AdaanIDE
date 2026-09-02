import { json } from "@sveltejs/kit";
import { sessionStore, getWorkspace, getEngine, ensureLocalModel, type LocalModelRef } from "@adaan/core/server";
import { randomUUID } from "node:crypto";

/** Queued message waiting for the current turn to finish. Carries the local
 *  model ref (if any) so the drain can re-ensure the server is up. */
export interface QueuedMessage {
  message: string;
  model?: string;
  contextLength?: number;
  localModel?: LocalModelRef;
}

export async function POST({ request }) {
  const {
    workspaceRoot, message, model, contextLength,
    sessionId: existingId,
    routingMode, routingThreshold, routingTiers,
    explorationPaidEnabled,
    interrupt,
    localModel,
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

  // Local model selected: the client sends its provider/model ref so we can
  // make sure the server is up BEFORE running the engine — no LLM request
  // should ever reach a dead endpoint.
  const localRef: LocalModelRef | undefined =
    localModel &&
    typeof localModel.providerId === "string" &&
    typeof localModel.modelId === "string" &&
    localModel.modelId
      ? {
          providerId: localModel.providerId,
          modelId: localModel.modelId,
          hfRepo: typeof localModel.hfRepo === "string" ? localModel.hfRepo : undefined,
          singleModel: localModel.singleModel !== false,
        }
      : undefined;

  // interrupt: true (default) — abort the current in-flight turn and start
  // a new one immediately. The old generator exits silently via the
  // superseded flag.
  // interrupt: false (queue) — wait for the current turn to finish before
  // starting the new one. The message is stored and processed after the
  // current generator completes.
  if (interrupt === false && session.status === "running") {
    // Queue the message — it will be sent after the current turn finishes.
    // We store it on the session and the events endpoint consumer will
    // trigger it when the current turn's generator completes. The local ref
    // travels with it so the drain ensures the server is up at that point —
    // ensuring NOW could stop the server the current turn is using.
    const queue = ((session as any)._messageQueue ?? []) as QueuedMessage[];
    queue.push({
      message,
      model: typeof model === "string" && model ? model : undefined,
      contextLength,
      localModel: localRef,
    });
    (session as any)._messageQueue = queue;
    return json({ sessionId, queued: true });
  }

  // Ensure the local server is ready (blocks until ready; fast path when
  // it's already serving the model). The returned wire name is what the
  // server's API expects — it may differ from the discovery alias.
  let wireModel: string | undefined = typeof model === "string" && model ? model : undefined;
  if (localRef) {
    try {
      wireModel = await ensureLocalModel(localRef);
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Failed to start local model server" },
        { status: 503 },
      );
    }
  }

  // Start the agent run as a background task — events are consumed via SSE.
  // session.resume() (called inside engine.run) aborts any in-flight turn.
  const iterable = engine.run(session, ws, message, wireModel, contextLength || 4096);

  // Store the iterable on the session for the events endpoint to consume
  (session as any)._iterable = iterable;

  return json({ sessionId });
}
