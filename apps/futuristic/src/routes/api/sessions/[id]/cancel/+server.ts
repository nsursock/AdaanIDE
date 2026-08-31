import { json } from "@sveltejs/kit";
import { sessionStore } from "@adaan/core/server";

export async function POST({ params }) {
  const session = sessionStore.get(params.id);
  if (!session) {
    return json({ error: "Session not found" }, { status: 404 });
  }
  session.cancel();
  return json({ cancelled: true });
}
