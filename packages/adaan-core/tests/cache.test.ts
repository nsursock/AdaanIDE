import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolResultCache } from "../src/server/agent/cache.js";

describe("ToolResultCache", () => {
  it("stores and retrieves results", () => {
    const cache = new ToolResultCache();
    cache.set("read_file", { path: "foo.py" }, { content: "hello", hash: "abc" }, "foo.py");
    const result = cache.get("read_file", { path: "foo.py" });
    assert.deepEqual(result, { content: "hello", hash: "abc" });
  });

  it("returns null for uncached entries", () => {
    const cache = new ToolResultCache();
    const result = cache.get("read_file", { path: "bar.py" });
    assert.equal(result, null);
  });

  it("invalidates by file path", () => {
    const cache = new ToolResultCache();
    cache.set("read_file", { path: "foo.py" }, "result1", "foo.py");
    cache.invalidatePath("foo.py");
    assert.equal(cache.get("read_file", { path: "foo.py" }), null);
  });

  it("invalidates tree entries", () => {
    const cache = new ToolResultCache();
    cache.set("list_files", {}, "tree-result");
    cache.set("read_file", { path: "foo.py" }, "file-result", "foo.py");
    cache.invalidateTree();
    assert.equal(cache.get("list_files", {}), null);
    // read_file should still be cached (not a tree entry)
    assert.equal(cache.get("read_file", { path: "foo.py" }), "file-result");
  });

  it("clears all entries", () => {
    const cache = new ToolResultCache();
    cache.set("read_file", { path: "foo.py" }, "result", "foo.py");
    cache.set("list_files", {}, "tree");
    cache.clear();
    assert.equal(cache.size, 0);
  });

  it("invalidates execute_command and run_tests entries", () => {
    const cache = new ToolResultCache();
    cache.set("execute_command", { command: "python foo.py" }, { stdout: "old", stderr: "", exitCode: 0 });
    cache.set("run_tests", {}, { stdout: "tests", stderr: "", exitCode: 0 });
    cache.set("read_file", { path: "foo.py" }, "file-result", "foo.py");

    cache.invalidateCommands();

    // Commands and tests are invalidated — they may depend on changed file contents.
    assert.equal(cache.get("execute_command", { command: "python foo.py" }), null);
    assert.equal(cache.get("run_tests", {}), null);
    // Other entries are untouched.
    assert.equal(cache.get("read_file", { path: "foo.py" }), "file-result");
  });
});
