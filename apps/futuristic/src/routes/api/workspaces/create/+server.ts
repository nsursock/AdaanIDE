import { json } from "@sveltejs/kit";
import { Workspace } from "@adaan/core/server";
import fs from "node:fs/promises";
import path from "node:path";
import { addRecent } from "$lib/server/recent";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export async function POST({ request }) {
  const { name, parentPath } = await request.json();

  if (!name || typeof name !== "string" || !NAME_RE.test(name) || name.length > 100) {
    return json(
      { error: "Invalid project name. Use letters, numbers, dots, dashes and underscores." },
      { status: 400 },
    );
  }

  const parent = typeof parentPath === "string" && parentPath.trim()
    ? parentPath.trim()
    : await Workspace.defaultProjectParent();

  try {
    const stat = await fs.stat(parent);
    if (!stat.isDirectory()) {
      return json({ error: "Parent path is not a directory" }, { status: 400 });
    }
  } catch {
    return json({ error: "Parent path does not exist" }, { status: 400 });
  }

  const rootPath = path.join(parent, name);
  try {
    const ws = await Workspace.create(rootPath);
    await addRecent(ws.rootPath);
    return json({ rootPath: ws.rootPath, name: ws.name });
  } catch (e: any) {
    return json({ error: e?.message ?? "Failed to create project" }, { status: 400 });
  }
}
