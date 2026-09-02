import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildClassifyPrompt,
  parseClassifyResponse,
  buildEditPrompt,
  parseEditResponse,
  exceedsEditBudget,
  type FileContent,
} from "../src/server/agent/single-shot.js";

describe("single-shot pipeline (Phase C)", () => {
  describe("parseClassifyResponse", () => {
    it("parses valid JSON with edit action", () => {
      const raw = `{"action": "edit", "targetFiles": ["src/main.py"], "reason": "fix bug"}`;
      const result = parseClassifyResponse(raw);
      assert.equal(result?.action, "edit");
      assert.deepEqual(result?.targetFiles, ["src/main.py"]);
      assert.equal(result?.reason, "fix bug");
    });

    it("parses valid JSON with create action", () => {
      const raw = `{"action": "create", "targetFiles": ["new_file.py"], "reason": "new module"}`;
      const result = parseClassifyResponse(raw);
      assert.equal(result?.action, "create");
      assert.deepEqual(result?.targetFiles, ["new_file.py"]);
    });

    it("parses valid JSON with explain action (no files)", () => {
      const raw = `{"action": "explain", "targetFiles": [], "reason": "user wants explanation"}`;
      const result = parseClassifyResponse(raw);
      assert.equal(result?.action, "explain");
      assert.deepEqual(result?.targetFiles, []);
    });

    it("parses tagged-line format", () => {
      const raw = `ACTION: edit\nFILES: src/main.py, src/utils.py\nREASON: fix import error`;
      const result = parseClassifyResponse(raw);
      assert.equal(result?.action, "edit");
      assert.deepEqual(result?.targetFiles, ["src/main.py", "src/utils.py"]);
      assert.equal(result?.reason, "fix import error");
    });

    it("parses tagged-line format with no files", () => {
      const raw = `ACTION: explain\nREASON: user wants to understand the code`;
      const result = parseClassifyResponse(raw);
      assert.equal(result?.action, "explain");
      assert.deepEqual(result?.targetFiles, []);
    });

    it("returns null for garbage input", () => {
      assert.equal(parseClassifyResponse("hello world"), null);
      assert.equal(parseClassifyResponse(""), null);
      assert.equal(parseClassifyResponse("   "), null);
    });

    it("returns null for missing action field", () => {
      const raw = `{"targetFiles": ["a.py"], "reason": "test"}`;
      assert.equal(parseClassifyResponse(raw), null);
    });

    it("returns null for invalid action value", () => {
      const raw = `{"action": "delete", "targetFiles": ["a.py"]}`;
      assert.equal(parseClassifyResponse(raw), null);
    });

    it("handles JSON embedded in markdown code block", () => {
      const raw = `\`\`\`json\n{"action": "edit", "targetFiles": ["a.py"], "reason": "fix"}\n\`\`\``;
      const result = parseClassifyResponse(raw);
      assert.equal(result?.action, "edit");
      assert.deepEqual(result?.targetFiles, ["a.py"]);
    });
  });

  describe("buildClassifyPrompt", () => {
    it("includes the user request and file tree", () => {
      const prompt = buildClassifyPrompt("Fix the bug in main.py", "main.py\nutils.py\nREADME.md");
      assert.ok(prompt.includes("Fix the bug in main.py"));
      assert.ok(prompt.includes("main.py"));
      assert.ok(prompt.includes("ACTION:"));
    });

    it("truncates large file trees to fit budget", () => {
      const hugeTree = Array.from({ length: 1000 }, (_, i) => `file${i}.py`).join("\n");
      const prompt = buildClassifyPrompt("Fix the bug", hugeTree);
      assert.ok(prompt.includes("(truncated)"));
      // Should still contain the request
      assert.ok(prompt.includes("Fix the bug"));
    });
  });

  describe("buildEditPrompt", () => {
    it("includes request and file contents", () => {
      const files: FileContent[] = [
        { path: "main.py", content: "print('hello')" },
      ];
      const prompt = buildEditPrompt("Change hello to world", files);
      assert.ok(prompt.includes("Change hello to world"));
      assert.ok(prompt.includes("main.py"));
      assert.ok(prompt.includes("print('hello')"));
      assert.ok(prompt.includes("FILE:"));
    });

    it("truncates files that exceed the budget", () => {
      const largeContent = "x".repeat(30000); // ~7500 tokens
      const files: FileContent[] = [
        { path: "big.py", content: largeContent },
      ];
      const prompt = buildEditPrompt("fix it", files);
      assert.ok(prompt.includes("(truncated to fit budget)"));
    });

    it("handles multiple files", () => {
      const files: FileContent[] = [
        { path: "a.py", content: "def a(): pass" },
        { path: "b.py", content: "def b(): pass" },
      ];
      const prompt = buildEditPrompt("update both", files);
      assert.ok(prompt.includes("FILE: a.py"));
      assert.ok(prompt.includes("FILE: b.py"));
    });
  });

  describe("parseEditResponse", () => {
    it("parses fenced FILE blocks", () => {
      const raw = `FILE: main.py
\`\`\`python
print('hello world')
\`\`\``;
      const results = parseEditResponse(raw);
      assert.equal(results.length, 1);
      assert.equal(results[0].path, "main.py");
      assert.equal(results[0].content, "print('hello world')");
    });

    it("parses multiple FILE blocks", () => {
      const raw = `FILE: a.py
\`\`\`
content_a
\`\`\`
FILE: b.py
\`\`\`
content_b
\`\`\``;
      const results = parseEditResponse(raw);
      assert.equal(results.length, 2);
      assert.equal(results[0].path, "a.py");
      assert.equal(results[0].content, "content_a");
      assert.equal(results[1].path, "b.py");
      assert.equal(results[1].content, "content_b");
    });

    it("parses unfenced format as fallback", () => {
      const raw = `FILE: main.py
print('hello')`;
      const results = parseEditResponse(raw);
      assert.equal(results.length, 1);
      assert.equal(results[0].path, "main.py");
      assert.ok(results[0].content.includes("print('hello')"));
    });

    it("returns empty array for no FILE blocks", () => {
      assert.equal(parseEditResponse("just some text").length, 0);
      assert.equal(parseEditResponse("").length, 0);
    });

    it("handles content with nested backticks", () => {
      const raw = `FILE: readme.md
\`\`\`
Here is some code:
\`\`\`python
print('nested')
\`\`\`
End of file
\`\`\``;
      const results = parseEditResponse(raw);
      assert.equal(results.length, 1);
      assert.ok(results[0].content.includes("print('nested')"));
    });
  });

  describe("exceedsEditBudget", () => {
    it("returns false for small files", () => {
      const files: FileContent[] = [
        { path: "a.py", content: "print('hello')" },
      ];
      assert.equal(exceedsEditBudget(files), false);
    });

    it("returns true for files exceeding 6000 tokens", () => {
      const files: FileContent[] = [
        { path: "big.py", content: "x".repeat(30000) }, // ~7500 tokens
      ];
      assert.equal(exceedsEditBudget(files), true);
    });

    it("returns true when combined files exceed budget", () => {
      const files: FileContent[] = [
        { path: "a.py", content: "x".repeat(12000) }, // ~3000 tokens
        { path: "b.py", content: "x".repeat(12000) }, // ~3000 tokens
        { path: "c.py", content: "x".repeat(12000) }, // ~3000 tokens — total ~9000
      ];
      assert.equal(exceedsEditBudget(files), true);
    });
  });
});
