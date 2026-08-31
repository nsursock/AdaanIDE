import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listSymbols, extractSymbolContent } from "../src/server/agent/tools/symbols.js";

describe("Symbols — Python", () => {
  const pyCode = `import os

def hello():
    print("hello")

class Foo:
    def method_one(self):
        return 42

    def method_two(self, x):
        return x * 2

def top_level(x, y):
    return x + y
`;

  it("extracts functions and classes", () => {
    const symbols = listSymbols(pyCode, "test.py");
    const names = symbols.map((s) => s.name);
    assert.ok(names.includes("hello"));
    assert.ok(names.includes("Foo"));
    assert.ok(names.includes("method_one"));
    assert.ok(names.includes("method_two"));
    assert.ok(names.includes("top_level"));
  });

  it("assigns correct kinds", () => {
    const symbols = listSymbols(pyCode, "test.py");
    const foo = symbols.find((s) => s.name === "Foo");
    assert.equal(foo?.kind, "class");
    const hello = symbols.find((s) => s.name === "hello");
    assert.equal(hello?.kind, "function");
  });

  it("provides line ranges", () => {
    const symbols = listSymbols(pyCode, "test.py");
    const hello = symbols.find((s) => s.name === "hello");
    assert.ok(hello!.lineStart >= 1);
    assert.ok(hello!.lineEnd > hello!.lineStart);
  });

  it("extracts symbol content by name", () => {
    const result = extractSymbolContent(pyCode, "test.py", "hello");
    assert.ok(result);
    assert.ok(result!.content.includes("print"));
  });
});

describe("Symbols — JavaScript/TypeScript", () => {
  const tsCode = `export function greet(name: string): string {
  return "hello " + name;
}

const arrow = (x: number) => x * 2;

class Bar {
  methodA() {
    return 1;
  }

  methodB = (y: number) => y + 1;
}
`;

  it("extracts functions, classes, and methods", () => {
    const symbols = listSymbols(tsCode, "test.ts");
    const names = symbols.map((s) => s.name);
    assert.ok(names.includes("greet"));
    assert.ok(names.includes("arrow"));
    assert.ok(names.includes("Bar"));
    assert.ok(names.includes("methodA"));
    assert.ok(names.includes("methodB"));
  });

  it("assigns correct kinds", () => {
    const symbols = listSymbols(tsCode, "test.ts");
    const bar = symbols.find((s) => s.name === "Bar");
    assert.equal(bar?.kind, "class");
    const methodA = symbols.find((s) => s.name === "methodA");
    assert.equal(methodA?.kind, "method");
    const greet = symbols.find((s) => s.name === "greet");
    assert.equal(greet?.kind, "function");
  });
});

describe("Symbols — unknown extension", () => {
  it("returns empty or tries both parsers", () => {
    const symbols = listSymbols("no code here", "file.xyz");
    assert.ok(Array.isArray(symbols));
  });
});
