import { json } from "@sveltejs/kit";
import { Workspace } from "@adaan/core/server";
import fs from "node:fs/promises";
import path from "node:path";
import { loadRecent, addRecent } from "$lib/server/recent";

export async function GET() {
  const candidates = await Workspace.listCandidateRoots();
  const recent = await loadRecent();
  const defaultProjectDir = await Workspace.defaultProjectParent();
  return json({ candidates, recent, defaultProjectDir });
}

export async function POST({ request }) {
  const { rootPath } = await request.json();
  if (!rootPath || typeof rootPath !== "string") {
    return json({ error: "rootPath required" }, { status: 400 });
  }

  try {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) {
      return json({ error: "Not a directory" }, { status: 400 });
    }
  } catch {
    return json({ error: "Path does not exist" }, { status: 400 });
  }

  await addRecent(rootPath);

  return json({ rootPath, name: path.basename(rootPath) });
}
