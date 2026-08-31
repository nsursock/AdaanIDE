import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

export async function GET({ url }) {
  const rootPath = url.searchParams.get("root");
  const filePath = url.searchParams.get("path");
  if (!rootPath || !filePath) return json({ error: "root and path required" }, { status: 400 });

  const ws = getWorkspace(rootPath);
  try {
    const result = await ws.readFile(filePath);
    return json(result);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Read failed" }, { status: 400 });
  }
}
