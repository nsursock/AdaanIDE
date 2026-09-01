import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

/** GET /api/files/history/list?root=...&path=...
 *  Returns the version timeline for a file (newest first). */
export async function GET({ url }) {
  const rootPath = url.searchParams.get("root");
  const filePath = url.searchParams.get("path");
  if (!rootPath || !filePath) return json({ error: "root and path required" }, { status: 400 });

  const ws = getWorkspace(rootPath);
  try {
    const entries = await ws.history.list(filePath);
    return json({ entries });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "History list failed" }, { status: 400 });
  }
}
