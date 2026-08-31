import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

export async function GET({ url }) {
  const rootPath = url.searchParams.get("root");
  if (!rootPath) return json({ error: "root required" }, { status: 400 });

  const showHidden = url.searchParams.get("showHidden") === "1";
  const ws = getWorkspace(rootPath);
  const tree = await ws.listTree(undefined, 0, { showHidden });
  return json(tree);
}
