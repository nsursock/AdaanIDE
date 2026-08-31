import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

export async function POST({ request }) {
  const { root, path } = await request.json();
  if (!root || !path) return json({ error: "root and path required" }, { status: 400 });

  const ws = getWorkspace(root);
  try {
    const result = await ws.deleteFile(path);
    return json(result);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Delete failed" }, { status: 400 });
  }
}
