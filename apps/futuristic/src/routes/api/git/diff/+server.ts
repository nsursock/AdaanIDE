import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

/** GET /api/git/diff?root=...[&file=...]
 *  Returns the git diff (unstaged) as plain text. */
export async function GET({ url }) {
  const rootPath = url.searchParams.get("root");
  if (!rootPath) return json({ error: "root required" }, { status: 400 });

  const file = url.searchParams.get("file") ?? undefined;
  const ws = getWorkspace(rootPath);
  try {
    const diff = await ws.gitDiff(file);
    return json({ diff });
  } catch (e) {
    return json({ diff: "" });
  }
}
