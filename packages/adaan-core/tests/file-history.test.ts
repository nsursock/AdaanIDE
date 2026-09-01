import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FileHistory } from "../src/server/file-history.js";
import { Workspace } from "../src/server/workspace.js";

let tmpDir: string;

async function setup(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "adaan-history-"));
  return tmpDir;
}

async function cleanup() {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

describe("FileHistory", () => {
  let root: string;
  beforeEach(async () => { root = await setup(); });
  afterEach(cleanup);

  it("snapshots a file version", async () => {
    const h = new FileHistory(root);
    const entry = await h.snapshot("app.js", "console.log('v1')\n", "agent", "apply_patch");
    assert.ok(entry);
    assert.equal(entry!.content, "console.log('v1')\n");
    assert.equal(entry!.source, "agent");
    assert.equal(entry!.label, "apply_patch");
  });

  it("lists versions newest first", async () => {
    const h = new FileHistory(root);
    await h.snapshot("app.js", "v1\n", "agent");
    await new Promise((r) => setTimeout(r, 5));
    await h.snapshot("app.js", "v2\n", "agent");
    await new Promise((r) => setTimeout(r, 5));
    await h.snapshot("app.js", "v3\n", "agent");
    const list = await h.list("app.js");
    assert.equal(list.length, 3);
    // Newest first
    assert.ok(list[0].timestamp > list[1].timestamp);
    assert.ok(list[1].timestamp > list[2].timestamp);
  });

  it("skips duplicate snapshots (same content as last)", async () => {
    const h = new FileHistory(root);
    await h.snapshot("app.js", "same\n", "agent");
    const dup = await h.snapshot("app.js", "same\n", "agent");
    assert.equal(dup, null);
    const list = await h.list("app.js");
    assert.equal(list.length, 1);
  });

  it("gets a specific version by id", async () => {
    const h = new FileHistory(root);
    const entry = await h.snapshot("app.js", "original\n", "agent");
    const fetched = await h.get("app.js", entry!.id);
    assert.ok(fetched);
    assert.equal(fetched!.content, "original\n");
  });

  it("returns null for non-existent version", async () => {
    const h = new FileHistory(root);
    const fetched = await h.get("app.js", "nonexistent-id");
    assert.equal(fetched, null);
  });

  it("computes diff stats vs previous version", async () => {
    const h = new FileHistory(root);
    await h.snapshot("app.js", "line1\nline2\nline3\n", "agent");
    await new Promise((r) => setTimeout(r, 5));
    const second = await h.snapshot("app.js", "line1\nCHANGED\nline3\nline4\n", "agent");
    assert.ok(second);
    assert.ok(second!.stats);
    // Positional diff: line2->CHANGED (modified), line3 same, line4 added
    // But positional diff compares by index: index1 modified, index3 added
    assert.ok(second!.stats!.modified >= 1);
    assert.ok(second!.stats!.added >= 1);
  });

  it("restores a file to a previous version", async () => {
    const h = new FileHistory(root);
    const abs = path.join(root, "app.js");

    // Write v1, snapshot it
    await fs.writeFile(abs, "v1\n", "utf-8");
    await h.snapshot("app.js", "v1\n", "agent");

    // Write v2 (overwrites)
    await fs.writeFile(abs, "v2\n", "utf-8");
    await new Promise((r) => setTimeout(r, 5));
    await h.snapshot("app.js", "v2\n", "agent");

    // Now restore to v1
    const list = await h.list("app.js");
    const v1Entry = list[list.length - 1]; // oldest
    const result = await h.restore("app.js", v1Entry.id, abs);
    assert.equal(result.restored.content, "v1\n");

    // File on disk should now be v1
    const content = await fs.readFile(abs, "utf-8");
    assert.equal(content, "v1\n");
  });

  it("restore snapshots the current content first (undoable)", async () => {
    const h = new FileHistory(root);
    const abs = path.join(root, "app.js");

    await fs.writeFile(abs, "v1\n", "utf-8");
    await h.snapshot("app.js", "v1\n", "agent");
    await fs.writeFile(abs, "v2\n", "utf-8");
    await new Promise((r) => setTimeout(r, 5));
    await h.snapshot("app.js", "v2\n", "agent");

    const list = await h.list("app.js");
    const v1Id = list[list.length - 1].id;
    await h.restore("app.js", v1Id, abs);

    // After restore, there should be a new "restore" snapshot with v2 content
    const afterList = await h.list("app.js");
    const restoreEntry = afterList.find((e) => e.source === "restore");
    assert.ok(restoreEntry, "restore should have created a snapshot of the pre-restore content");
    const restoreFull = await h.get("app.js", restoreEntry.id);
    assert.equal(restoreFull!.content, "v2\n");
  });

  it("lists files that have history", async () => {
    const h = new FileHistory(root);
    await h.snapshot("app.js", "x\n", "agent");
    await h.snapshot("style.css", "y\n", "agent");
    const files = await h.listFiles();
    assert.equal(files.length, 2);
    assert.ok(files.includes("app.js"));
    assert.ok(files.includes("style.css"));
  });

  it("clears history for a file", async () => {
    const h = new FileHistory(root);
    await h.snapshot("app.js", "x\n", "agent");
    await h.clear("app.js");
    const list = await h.list("app.js");
    assert.equal(list.length, 0);
  });
});

describe("Workspace history integration", () => {
  let root: string;
  beforeEach(async () => { root = await setup(); });
  afterEach(cleanup);

  it("applyPatch creates a history snapshot", async () => {
    const ws = new Workspace(root);
    await ws.writeFile("app.js", "console.log('hello')\n");
    const read = await ws.readFile("app.js");
    const patch = "SEARCH\nconsole.log('hello')\nREPLACE\nconsole.log('world')";
    await ws.applyPatch("app.js", patch, read.hash);

    const history = await ws.history.list("app.js");
    assert.equal(history.length, 1);
    assert.equal(history[0].source, "agent");
    assert.equal(history[0].label, "apply_patch");
  });

  it("writeFile creates a history snapshot for existing files", async () => {
    const ws = new Workspace(root);
    await ws.writeFile("app.js", "v1\n");
    const read = await ws.readFile("app.js");
    await ws.writeFile("app.js", "v2\n", read.hash);

    const history = await ws.history.list("app.js");
    assert.equal(history.length, 1);
    assert.equal(history[0].source, "user");
  });

  it("writeFile does not snapshot for new files", async () => {
    const ws = new Workspace(root);
    await ws.writeFile("brand_new.js", "new\n");

    const history = await ws.history.list("brand_new.js");
    assert.equal(history.length, 0, "creating a new file has no previous version to snapshot");
  });
});
