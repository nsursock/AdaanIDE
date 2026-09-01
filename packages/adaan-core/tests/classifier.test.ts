import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTask } from "../src/server/router/classifier.js";

describe("classifier", () => {
  it("classifies a bug fix prompt", () => {
    const cls = classifyTask("Fix the bug in the add function — it returns a - b instead of a + b");
    assert.equal(cls.category, "fix");
    assert.ok(cls.coding > 0.2, "coding should be elevated for a fix task");
  });

  it("classifies a test generation prompt", () => {
    const cls = classifyTask("Write unit tests for the string_utils module using pytest");
    assert.equal(cls.category, "test");
  });

  it("classifies a refactor prompt", () => {
    const cls = classifyTask("Refactor shapes.py to use a common Shape base class with an abstract area method");
    assert.equal(cls.category, "refactor");
    assert.ok(cls.multiFile > 0 || cls.coding > 0.2);
  });

  it("classifies a greenfield/build prompt", () => {
    const cls = classifyTask("Build a new REST API server from scratch");
    assert.equal(cls.category, "greenfield");
    assert.ok(cls.complexity > 0.2);
  });

  it("classifies an exploration prompt", () => {
    const cls = classifyTask("What does this project do? Explain the architecture.");
    assert.equal(cls.category, "exploration");
  });

  it("classifies a chat prompt", () => {
    const cls = classifyTask("Hello, how are you?");
    assert.equal(cls.category, "chat");
  });

  it("classifies a workflow/CI prompt", () => {
    const cls = classifyTask("Set up a GitHub Actions CI pipeline with Docker");
    assert.equal(cls.category, "workflow");
  });

  it("detects stack traces as fix category", () => {
    const cls = classifyTask("I'm getting this error: Traceback (most recent call last): File 'app.py' line 10");
    assert.equal(cls.category, "fix");
    assert.ok(cls.reasoning > 0.1);
  });

  it("detects code blocks and elevates coding score", () => {
    const cls = classifyTask("Here's my code:\n```python\ndef foo():\n  pass\n```\nCan you help?");
    assert.ok(cls.coding > 0.1, "code block should elevate coding score");
  });

  it("long prompts increase complexity", () => {
    const short = classifyTask("Fix the bug");
    const long = classifyTask("Fix the bug. ".repeat(50) + "Also make sure to handle edge cases like empty input, null values, and very large numbers. The function should be thread-safe and work with both Python 3.9 and 3.12. Add comprehensive error handling and logging. Make sure the performance is acceptable for inputs up to 10 million items.");
    assert.ok(long.complexity >= short.complexity, "longer prompt should have >= complexity");
  });

  it("uses fileCount hint for contextNeeded", () => {
    const withoutHint = classifyTask("Refactor the module", {});
    const withHint = classifyTask("Refactor the module", { fileCount: 20 });
    assert.ok(withHint.contextNeeded >= withoutHint.contextNeeded);
  });

  it("uses fileCount hint for multiFile", () => {
    const withoutHint = classifyTask("Update the code", {});
    const withHint = classifyTask("Update the code", { fileCount: 10 });
    assert.ok(withHint.multiFile >= withoutHint.multiFile);
  });

  it("all dimensions are clamped to 0..1", () => {
    const cls = classifyTask("Fix build create refactor test debug error crash deploy docker kubernetes fix error");
    for (const v of [cls.complexity, cls.reasoning, cls.coding, cls.toolUse, cls.contextNeeded, cls.multiFile]) {
      assert.ok(v >= 0 && v <= 1, `dimension ${v} should be in [0,1]`);
    }
  });

  it("empty prompt defaults to chat", () => {
    const cls = classifyTask("");
    assert.equal(cls.category, "chat");
  });

  it("multi-file keywords elevate multiFile score", () => {
    const cls = classifyTask("Refactor across multiple files in the entire project");
    assert.ok(cls.multiFile > 0.3, "multi-file keywords should elevate multiFile score");
  });
});
