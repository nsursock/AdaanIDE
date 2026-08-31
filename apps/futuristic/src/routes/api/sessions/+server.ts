import { json } from "@sveltejs/kit";
import { sessionStore, getWorkspace, getEngine } from "@adaan/core/server";
import { randomUUID } from "node:crypto";

export async function POST({ request }) {
  const { workspaceRoot, message, model, contextLength, sessionId: existingId } = await request.json();

  if (!workspaceRoot || !message) {
    return json({ error: "workspaceRoot and message required" }, { status: 400 });
  }

  const ws = getWorkspace(workspaceRoot);
  const engine = getEngine();

  let sessionId = typeof existingId === "string" && existingId ? existingId : randomUUID();
  let session = existingId ? sessionStore.get(sessionId) : undefined;
  if (!session || session.workspaceId !== workspaceRoot) {
    sessionId = randomUUID();
    session = sessionStore.create(sessionId, workspaceRoot);
  }

  // Start the agent run as a background task — events are consumed via SSE
  const iterable = engine.run(session, ws, message, model || undefined, contextLength || 4096);

  // Store the iterable on the session for the events endpoint to consume
  (session as any)._iterable = iterable;

  return json({ sessionId });
}
