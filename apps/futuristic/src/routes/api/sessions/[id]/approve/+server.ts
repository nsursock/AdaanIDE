import { json } from "@sveltejs/kit";
import { sessionStore } from "@adaan/core/server";

export async function POST({ params, request }) {
  const session = sessionStore.get(params.id);
  if (!session) {
    return json({ error: "Session not found" }, { status: 404 });
  }

  const { toolCallId, approved } = await request.json();
  session.resolveApproval(toolCallId, approved);
  return json({ resolved: true });
}
