import { json } from "@sveltejs/kit";
import { getWorkspace } from "@adaan/core/server";

export async function POST({ request }) {
  const { root, path, patch, expectedHash } = await request.json();
  if (!root || !path || !patch || !expectedHash) {
    return json({ error: "root, path, patch, expectedHash required" }, { status: 400 });
  }

  const ws = getWorkspace(root);
  try {
    const result = await ws.applyPatch(path, patch, expectedHash);
    return json(result);
  } catch (e: any) {
    const status = e.status ?? 400;
    return json({ error: e.message, code: e.code }, { status });
  }
}
