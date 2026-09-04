import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

/** GET /api/git/status?root=...
 *  Returns the porcelain git status plus the current branch and remote URL.
 *  Empty status when the workspace isn't a git repo. */
export async function GET({ url }) {
  const rootPath = url.searchParams.get("root");
  if (!rootPath) return json({ error: "root required" }, { status: 400 });

  const ws = getWorkspace(rootPath);
  try {
    const status = await ws.gitStatus();
    let branch = "";
    let remote = "";
    let aheadBehind = "";
    try {
      const branchRes = await ws.executeCommand("git rev-parse --abbrev-ref HEAD");
      branch = branchRes.stdout.trim();
    } catch {
      /* not a repo */
    }
    try {
      const remoteRes = await ws.executeCommand("git config --get remote.origin.url");
      remote = remoteRes.stdout.trim();
    } catch {
      /* no remote */
    }
    try {
      const abRes = await ws.executeCommand(
        "git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null || true",
      );
      aheadBehind = abRes.stdout.trim();
    } catch {
      /* no upstream */
    }
    return json({ status, branch, remote, aheadBehind });
  } catch (e) {
    return json({ status: "", branch: "", remote: "", aheadBehind: "" });
  }
}
