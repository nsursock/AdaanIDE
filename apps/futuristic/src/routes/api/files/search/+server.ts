import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

export async function GET({ url }) {
  const rootPath = url.searchParams.get("root");
  const query = url.searchParams.get("q");
  const glob = url.searchParams.get("glob") || undefined;
  if (!rootPath || !query) return json({ error: "root and q required" }, { status: 400 });

  const ws = getWorkspace(rootPath);
  try {
    const results = await ws.search(query, glob);
    return json(results);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Search failed" }, { status: 400 });
  }
}
