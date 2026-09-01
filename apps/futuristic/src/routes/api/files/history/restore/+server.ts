import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

/** POST /api/files/history/restore
 *  Body: { root, path, id }
 *  Restores a file to a specific version. Snapshots the current content first
 *  (so the restore is itself undoable), then writes the old version back. */
export async function POST({ request }) {
  const { root, path: filePath, id } = await request.json();
  if (!root || !filePath || !id) {
    return json({ error: "root, path, and id required" }, { status: 400 });
  }

  const ws = getWorkspace(root);
  try {
    const abs = ws.resolve(filePath);
    const result = await ws.history.restore(filePath, id, abs);
    return json({ hash: result.hash, path: filePath, restored: true });
  } catch (e: any) {
    return json({ error: e.message ?? "Restore failed" }, { status: 400 });
  }
}
