import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

export async function POST({ request }) {
  const { root, path, type } = await request.json();
  if (!root || !path) return json({ error: "root and path required" }, { status: 400 });

  const ws = getWorkspace(root);
  try {
    if (type === "dir") {
      const result = await ws.createDir(path);
      return json(result);
    } else {
      const result = await ws.createFile(path);
      return json(result);
    }
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Create failed" }, { status: 400 });
  }
}
