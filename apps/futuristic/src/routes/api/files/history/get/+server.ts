import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

/** GET /api/files/history/get?root=...&path=...&id=...
 *  Returns the full content of a specific file version. */
export async function GET({ url }) {
  const rootPath = url.searchParams.get("root");
  const filePath = url.searchParams.get("path");
  const id = url.searchParams.get("id");
  if (!rootPath || !filePath || !id) {
    return json({ error: "root, path, and id required" }, { status: 400 });
  }

  const ws = getWorkspace(rootPath);
  try {
    const entry = await ws.history.get(filePath, id);
    if (!entry) return json({ error: "Version not found" }, { status: 404 });
    return json(entry);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "History get failed" }, { status: 400 });
  }
}
