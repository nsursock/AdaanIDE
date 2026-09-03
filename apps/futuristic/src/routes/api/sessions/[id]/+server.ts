import { json } from "@sveltejs/kit";
import { sessionStore } from "@adaan/core/server";

/** Delete an agent session, freeing its in-memory state. Used when a
 *  project is closed in the multi-project UI so its chat session doesn't
 *  linger forever. */
export async function DELETE({ params }) {
  const existed = sessionStore.has(params.id);
  if (!existed) {
    return json({ error: "Session not found" }, { status: 404 });
  }
  sessionStore.delete(params.id);
  return json({ deleted: true });
}
