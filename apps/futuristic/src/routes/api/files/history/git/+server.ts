import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

/** GET /api/files/history/git?root=...[&path=...&limit=...]
 *  Returns the git commit history (newest first).
 *  - When `path` is omitted: project-wide log (all commits).
 *  - When `path` is given: only commits that touched that file.
 *  Empty array when the workspace isn't a git repo. */
export async function GET({ url }) {
  const rootPath = url.searchParams.get("root");
  if (!rootPath) return json({ error: "root required" }, { status: 400 });

  const filePath = url.searchParams.get("path") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(500, Math.max(1, parseInt(limitParam, 10) || 100)) : 100;

  const ws = getWorkspace(rootPath);
  try {
    const commits = await ws.gitLog(filePath, limit);
    return json({ commits });
  } catch (e) {
    return json({ commits: [] });
  }
}
