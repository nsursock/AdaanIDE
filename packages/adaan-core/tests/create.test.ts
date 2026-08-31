import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Workspace } from "../src/server/workspace.js";

const created: string[] = [];

async function tmpParent(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "adaan-create-test-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("Workspace.create", () => {
  it("creates a new project directory with scaffold files", async () => {
    const parent = await tmpParent();
    const root = path.join(parent, "my-project");
    const ws = await Workspace.create(root);

    assert.ok((await fs.stat(path.join(root, "README.md"))).isFile());
    const readme = await fs.readFile(path.join(root, "README.md"), "utf-8");
    assert.match(readme, /^# my-project/);
    const gitignore = await fs.readFile(path.join(root, ".gitignore"), "utf-8");
    assert.match(gitignore, /node_modules/);
    assert.equal(ws.name, "my-project");
  });

  it("creates nested parent directories", async () => {
    const parent = await tmpParent();
    const root = path.join(parent, "a", "b", "nested");
    await Workspace.create(root);
    const stat = await fs.stat(root);
    assert.ok(stat.isDirectory());
  });

  it("allows an existing empty directory", async () => {
    const parent = await tmpParent();
    const root = path.join(parent, "empty");
    await fs.mkdir(root);
    const ws = await Workspace.create(root);
    assert.equal(ws.name, "empty");
  });

  it("rejects a non-empty directory", async () => {
    const parent = await tmpParent();
    const root = path.join(parent, "full");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "file.txt"), "x");
    await assert.rejects(() => Workspace.create(root), /not empty/);
  });

  it("rejects a path that is a file", async () => {
    const parent = await tmpParent();
    const root = path.join(parent, "file.txt");
    await fs.writeFile(root, "x");
    await assert.rejects(() => Workspace.create(root), /not a directory/);
  });

  it("skips scaffold when scaffold: false", async () => {
    const parent = await tmpParent();
    const root = path.join(parent, "bare");
    await Workspace.create(root, { scaffold: false });
    const entries = await fs.readdir(root);
    assert.deepEqual(entries, []);
  });

  it("created workspace is usable (listTree sees scaffold)", async () => {
    const parent = await tmpParent();
    const ws = await Workspace.create(path.join(parent, "usable"));
    const tree = await ws.listTree();
    const names = tree.map((n) => n.name);
    assert.ok(names.includes("README.md"));
  });
});

describe("Workspace.defaultProjectParent", () => {
  it("returns an existing directory", async () => {
    const dir = await Workspace.defaultProjectParent();
    const stat = await fs.stat(dir);
    assert.ok(stat.isDirectory());
  });
});
