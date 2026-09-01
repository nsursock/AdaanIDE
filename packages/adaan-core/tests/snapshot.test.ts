import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Workspace } from "../src/server/workspace.js";
import { buildWorkspaceSnapshot } from "../src/server/agent/snapshot.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "snap-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("buildWorkspaceSnapshot", () => {
  it("lists files and detects stack hints", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), '{"name":"test"}');
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src/index.ts"), "export {}");
    await fs.writeFile(path.join(tmpDir, "README.md"), "# test");

    const ws = await Workspace.open(tmpDir);
    const snapshot = await buildWorkspaceSnapshot(ws);

    assert.ok(snapshot.includes("package.json"));
    assert.ok(snapshot.includes("src/index.ts"));
    assert.ok(snapshot.includes("Node.js / npm"));
  });

  it("caps at 200 files", async () => {
    // Create 250 files.
    for (let i = 0; i < 250; i++) {
      await fs.writeFile(path.join(tmpDir, `file${i}.ts`), "");
    }
    const ws = await Workspace.open(tmpDir);
    const snapshot = await buildWorkspaceSnapshot(ws);

    assert.ok(snapshot.includes("truncated"), "should mark as truncated");
  });

  it("is deterministic — same workspace produces same snapshot", async () => {
    await fs.writeFile(path.join(tmpDir, "a.ts"), "");
    await fs.writeFile(path.join(tmpDir, "b.ts"), "");

    const ws = await Workspace.open(tmpDir);
    const s1 = await buildWorkspaceSnapshot(ws);
    const s2 = await buildWorkspaceSnapshot(ws);
    assert.equal(s1, s2);
  });

  it("does not throw when git is absent", async () => {
    await fs.writeFile(path.join(tmpDir, "file.ts"), "");
    const ws = await Workspace.open(tmpDir);
    // Should not throw even though tmpDir is not a git repo.
    const snapshot = await buildWorkspaceSnapshot(ws);
    assert.ok(snapshot.length > 0);
  });
});
