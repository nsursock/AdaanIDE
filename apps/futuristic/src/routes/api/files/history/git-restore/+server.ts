import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

/** POST /api/files/history/git-restore
 *  Body: { root, path, hash }
 *  Restores a file to its state at a git commit. Snapshots the current
 *  content into local history first (so the restore is undoable), then
 *  writes the commit's version back to disk.
 *  Returns 404 when the file didn't exist at that commit. */
export async function POST({ request }) {
  const { root, path: filePath, hash } = await request.json();
  if (!root || !filePath || !hash) {
    return json({ error: "root, path, and hash required" }, { status: 400 });
  }

  const ws = getWorkspace(root);
  try {
    const result = await ws.gitRestoreFile(filePath, hash);
    if (!result) {
      return json({ error: "File did not exist at that commit" }, { status: 404 });
    }
    return json({ hash: result.hash, path: filePath, restored: true });
  } catch (e: any) {
    return json({ error: e.message ?? "Git restore failed" }, { status: 400 });
  }
}
