import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

/** POST /api/git/commit
 *  Body: { root, message }
 *  Stages all changes and creates a checkpoint commit. */
export async function POST({ request }) {
  const { root, message } = await request.json();
  if (!root || !message) return json({ error: "root and message required" }, { status: 400 });

  const ws = getWorkspace(root);
  try {
    const output = await ws.gitCheckpoint(message);
    return json({ output });
  } catch (e: any) {
    return json({ error: e?.message || "commit failed" }, { status: 500 });
  }
}
