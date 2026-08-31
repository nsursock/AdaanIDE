import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const recentFile = path.join(os.homedir(), ".adaan", "recent-workspaces.json");

export async function loadRecent(): Promise<string[]> {
  try {
    const data = await fs.readFile(recentFile, "utf-8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export async function saveRecent(paths: string[]) {
  try {
    await fs.mkdir(path.dirname(recentFile), { recursive: true });
    await fs.writeFile(recentFile, JSON.stringify(paths.slice(0, 10)));
  } catch {
    // ignore
  }
}

export async function addRecent(rootPath: string) {
  const recent = await loadRecent();
  const updated = [rootPath, ...recent.filter((p) => p !== rootPath)].slice(0, 10);
  await saveRecent(updated);
}
