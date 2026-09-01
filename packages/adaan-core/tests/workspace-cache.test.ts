import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceCache, L2_CACHEABLE_TOOLS } from "../src/server/agent/workspace-cache.js";

describe("WorkspaceCache (L2)", () => {
  let cache: WorkspaceCache;

  beforeEach(() => {
    cache = new WorkspaceCache(5, 60_000); // small cap for LRU testing
  });

  it("returns null on miss", () => {
    assert.equal(cache.get("read_file", { path: "a.ts" }), null);
  });

  it("round-trips a result", () => {
    cache.set("read_file", { path: "a.ts" }, { content: "hello" }, "a.ts");
    assert.deepEqual(cache.get("read_file", { path: "a.ts" }), { content: "hello" });
  });

  it("invalidates by file path", () => {
    cache.set("read_file", { path: "a.ts" }, "content", "a.ts");
    assert.ok(cache.get("read_file", { path: "a.ts" }) !== null);
    cache.invalidatePath("a.ts");
    assert.equal(cache.get("read_file", { path: "a.ts" }), null);
  });

  it("invalidates tree (list_files / git_status / git_diff)", () => {
    cache.set("list_files", {}, ["a.ts", "b.ts"]);
    cache.set("git_status", {}, "clean");
    cache.set("read_file", { path: "a.ts" }, "content", "a.ts");
    cache.invalidateTree();
    assert.equal(cache.get("list_files", {}), null);
    assert.equal(cache.get("git_status", {}), null);
    // read_file should survive tree invalidation.
    assert.ok(cache.get("read_file", { path: "a.ts" }) !== null);
  });

  it("evicts LRU entries when at capacity", () => {
    for (let i = 0; i < 6; i++) {
      cache.set("read_file", { path: `file${i}.ts` }, `content${i}`, `file${i}.ts`);
    }
    // The oldest (file0) should have been evicted.
    assert.equal(cache.get("read_file", { path: "file0.ts" }), null);
    // The newest (file5) should still be there.
    assert.ok(cache.get("read_file", { path: "file5.ts" }) !== null);
  });

  it("respects TTL expiry", async () => {
    const shortCache = new WorkspaceCache(10, 50); // 50ms TTL
    shortCache.set("read_file", { path: "a.ts" }, "content", "a.ts");
    assert.ok(shortCache.get("read_file", { path: "a.ts" }) !== null);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(shortCache.get("read_file", { path: "a.ts" }), null);
  });

  it("L2_CACHEABLE_TOOLS includes read-only tools but not writes", () => {
    assert.ok(L2_CACHEABLE_TOOLS.has("read_file"));
    assert.ok(L2_CACHEABLE_TOOLS.has("list_files"));
    assert.ok(L2_CACHEABLE_TOOLS.has("search_files"));
    assert.ok(!L2_CACHEABLE_TOOLS.has("write_file"));
    assert.ok(!L2_CACHEABLE_TOOLS.has("apply_patch"));
    assert.ok(!L2_CACHEABLE_TOOLS.has("execute_command"));
  });
});
