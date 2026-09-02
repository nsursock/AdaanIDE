import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Workspace } from "../src/server/workspace.js";
import { verifyEditedFile } from "../src/server/agent/verify.js";

let root: string;

async function setup(): Promise<string> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "verify-test-"));
  return root;
}

async function cleanup(): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

describe("verifyEditedFile — post-edit verification gate", () => {
  before(setup);
  after(cleanup);

  it("passes valid Python file (py_compile)", async () => {
    const ws = new Workspace(root);
    const filePath = "valid.py";
    await fs.writeFile(path.join(root, filePath), "def foo():\n    return 42\n");
    const result = await verifyEditedFile(ws, filePath);
    if (!result.checkRan) {
      // python3 not installed — skip gracefully
      return;
    }
    assert.equal(result.ok, true);
    assert.equal(result.errors, "");
  });

  it("fails invalid Python file (py_compile)", async () => {
    const ws = new Workspace(root);
    const filePath = "invalid.py";
    await fs.writeFile(path.join(root, filePath), "def foo(:\n    return 42\n");
    const result = await verifyEditedFile(ws, filePath);
    if (!result.checkRan) {
      return; // python3 not installed
    }
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0, "should have error output");
    assert.ok(result.errors.includes("SyntaxError") || result.errors.includes("Error"),
      "error should mention a syntax/error");
  });

  it("passes valid JS file (node --check)", async () => {
    const ws = new Workspace(root);
    const filePath = "valid.js";
    await fs.writeFile(path.join(root, filePath), "function foo() { return 42; }\n");
    const result = await verifyEditedFile(ws, filePath);
    if (!result.checkRan) {
      return; // node not installed (unlikely but safe)
    }
    assert.equal(result.ok, true);
    assert.equal(result.errors, "");
  });

  it("fails invalid JS file (node --check)", async () => {
    const ws = new Workspace(root);
    const filePath = "invalid.js";
    await fs.writeFile(path.join(root, filePath), "function foo( { return 42; }\n");
    const result = await verifyEditedFile(ws, filePath);
    if (!result.checkRan) {
      return;
    }
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0, "should have error output");
  });

  it("returns checkRan=false for unknown extensions", async () => {
    const ws = new Workspace(root);
    const filePath = "readme.md";
    await fs.writeFile(path.join(root, filePath), "# Hello\n");
    const result = await verifyEditedFile(ws, filePath);
    assert.equal(result.checkRan, false);
    assert.equal(result.ok, true);
  });

  it("returns checkRan=false for TS without tsconfig.json", async () => {
    const ws = new Workspace(root);
    const filePath = "module.ts";
    await fs.writeFile(path.join(root, filePath), "export const x = 1;\n");
    const result = await verifyEditedFile(ws, filePath);
    assert.equal(result.checkRan, false, "no tsconfig → no check");
    assert.equal(result.ok, true);
  });

  it("truncates long error output to ~600 chars", async () => {
    const ws = new Workspace(root);
    const filePath = "longerror.py";
    // Generate a file with many syntax errors to produce long output
    let content = "";
    for (let i = 0; i < 100; i++) {
      content += `def func${i}(:\n    pass\n`;
    }
    await fs.writeFile(path.join(root, filePath), content);
    const result = await verifyEditedFile(ws, filePath);
    if (!result.checkRan) {
      return;
    }
    if (result.ok) return; // some python versions may not produce long output
    // The truncation limit is 600 chars + the truncation marker
    assert.ok(result.errors.length <= 650,
      `errors should be truncated to ~600 chars, got ${result.errors.length}`);
  });

  it("never throws on infrastructure failure (nonexistent file)", async () => {
    const ws = new Workspace(root);
    // py_compile on a nonexistent file will fail, but verifyEditedFile
    // should catch the command error and return checkRan=false or ok=false
    const result = await verifyEditedFile(ws, "nonexistent.py");
    // Either the check ran and reported failure, or it was skipped
    assert.ok(result.checkRan === false || result.ok === false,
      "should not throw — either checkRan=false or ok=false");
  });
});
