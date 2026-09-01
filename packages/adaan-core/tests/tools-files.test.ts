import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Workspace } from "../src/server/workspace.js";
import { createFileHandler, writeFileHandler } from "../src/server/agent/tools/files.js";
import type { ToolContext } from "../src/types.js";

async function makeRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "adaan-tools-"));
}

function makeCtx(workspace: Workspace): ToolContext {
  return {
    workspace,
    signal: new AbortController().signal,
    sessionId: "test-session",
    emit: () => {},
    requestApproval: async () => true,
  };
}

describe("createFileHandler / writeFileHandler — corrupted-newline detection", () => {
  let root: string;

  beforeEach(async () => {
    root = await makeRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("flags a literal backslash-n artifact in freshly created code files", async () => {
    const ws = new Workspace(root);
    const ctx = makeCtx(ws);
    // Actual content contains a literal two-char "\n" (backslash + n) right
    // after a statement terminator — the exact corruption pattern weaker
    // models sometimes produce when double-escaping newlines.
    const content = "let scene;\\n  let blobs = [];";
    const result = await createFileHandler({ path: "game.js", content }, ctx);

    assert.equal(result.success, true);
    const output = result.output as { warning?: string };
    assert.ok(output.warning, "expected a warning about corrupted newlines");
    assert.match(output.warning!, /literal.*\\n|backslash/i);
  });

  it("does not flag normal, correctly-formatted code", async () => {
    const ws = new Workspace(root);
    const ctx = makeCtx(ws);
    const content = "let scene;\n  let blobs = [];\n";
    const result = await createFileHandler({ path: "game.js", content }, ctx);

    assert.equal(result.success, true);
    const output = result.output as { warning?: string };
    assert.equal(output.warning, undefined);
  });

  it("does not flag non-code file extensions", async () => {
    const ws = new Workspace(root);
    const ctx = makeCtx(ws);
    const content = "Some notes;\\n more notes";
    const result = await createFileHandler({ path: "notes.txt", content }, ctx);

    assert.equal(result.success, true);
    const output = result.output as { warning?: string };
    assert.equal(output.warning, undefined);
  });

  it("flags the same corruption pattern on write_file (overwrite path)", async () => {
    const ws = new Workspace(root);
    const ctx = makeCtx(ws);
    const created = await createFileHandler({ path: "app.svelte", content: "<script></script>\n" }, ctx);
    const hash = (created.output as { hash: string }).hash;

    const badContent = "targetVector.z);\\n    ai.acceleration.add(x);";
    const result = await writeFileHandler(
      { path: "app.svelte", content: badContent, expectedHash: hash },
      ctx,
    );

    assert.equal(result.success, true);
    const output = result.output as { warning?: string };
    assert.ok(output.warning, "expected a warning about corrupted newlines");
  });
});
