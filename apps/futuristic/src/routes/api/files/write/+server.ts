import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

export async function POST({ request }) {
  const { root, path, content, expectedHash } = await request.json();
  if (!root || !path) return json({ error: "root and path required" }, { status: 400 });

  const ws = getWorkspace(root);
  try {
    const result = await ws.writeFile(path, content, expectedHash);
    return json(result);
  } catch (e: any) {
    const status = e.status ?? 400;
    return json({ error: e.message, code: e.code }, { status });
  }
}
