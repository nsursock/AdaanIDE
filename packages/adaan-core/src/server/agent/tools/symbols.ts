import type { SymbolEntry } from "../../../types.js";

// Regex patterns for extracting symbols from Python and JS/TS files

const PY_PATTERNS: RegExp[] = [
  // class Foo(Base):
  /^(?<indent>\s*)class\s+(?<name>\w+)\s*(?:\([^)]*\))?\s*:/,
  // async def foo(args):
  /^(?<indent>\s*)(?:async\s+)?def\s+(?<name>\w+)\s*\(/,
];

const JS_TS_PATTERNS: RegExp[] = [
  // function foo(args) {
  /^(?:export\s+)?(?:async\s+)?function\s+(?<name>\w+)\s*\(/,
  // const foo = (args) => {  or  const foo = function(args) {
  /^(?:export\s+)?(?:const|let|var)\s+(?<name>\w+)\s*=\s*(?:async\s*)?(?:function|\()/,
  // class Foo {
  /^(?:export\s+)?(?:abstract\s+)?class\s+(?<name>\w+)/,
  // foo(args) {  (method in class — detected by indentation)
  /^(?<indent>\s+)(?<name>\w+)\s*\(/,
  // Arrow function methods: foo = (args) => {
  /^(?<indent>\s+)(?<name>\w+)\s*=\s*(?:async\s*)?\(/,
];

/**
 * Extract symbols (functions, classes, methods) from source code.
 * Supports Python and JS/TS via regex patterns.
 */
export function listSymbols(content: string, filePath: string): SymbolEntry[] {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "py") {
    return extractPythonSymbols(content);
  }
  if (ext === "js" || ext === "ts" || ext === "jsx" || ext === "tsx" || ext === "mjs" || ext === "cjs") {
    return extractJsTsSymbols(content);
  }
  // For unknown extensions, try both
  return [...extractPythonSymbols(content), ...extractJsTsSymbols(content)];
}

function extractPythonSymbols(content: string): SymbolEntry[] {
  const lines = content.split("\n");
  const symbols: SymbolEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of PY_PATTERNS) {
      const match = line.match(pattern);
      if (match?.groups) {
        const indent = match.groups["indent"]?.length ?? 0;
        const name = match.groups["name"];
        const kind = line.includes("class ") ? "class" : "function";
        const lineEnd = findBlockEnd(lines, i, indent);
        symbols.push({ name, kind, lineStart: i + 1, lineEnd, indent });
        break;
      }
    }
  }

  return symbols;
}

function extractJsTsSymbols(content: string): SymbolEntry[] {
  const lines = content.split("\n");
  const symbols: SymbolEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of JS_TS_PATTERNS) {
      const match = line.match(pattern);
      if (match?.groups) {
        const name = match.groups["name"];
        const indent = match.groups["indent"]?.length ?? 0;
        const kind: SymbolEntry["kind"] = line.includes("class ") ? "class" : indent > 0 ? "method" : "function";
        const lineEnd = findBraceBlockEnd(lines, i);
        symbols.push({ name, kind, lineStart: i + 1, lineEnd, indent });
        break;
      }
    }
  }

  return symbols;
}

/**
 * For Python: find the end of an indented block.
 * The block ends when we encounter a line with indent <= the defining line's indent.
 */
function findBlockEnd(lines: string[], defLine: number, defIndent: number): number {
  for (let i = defLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // skip blank lines
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= defIndent && line.trim().length > 0) {
      return i; // line before this is the last line of the block
    }
  }
  return lines.length;
}

/**
 * For JS/TS: find the end of a brace-delimited block.
 * Count opening and closing braces starting from the definition line.
 */
function findBraceBlockEnd(lines: string[], defLine: number): number {
  let depth = 0;
  let started = false;
  for (let i = defLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
        if (started && depth === 0) return i + 1;
      }
    }
  }
  return lines.length;
}

/**
 * Extract the source lines for a specific symbol by name.
 * Returns the lines of the first matching symbol.
 */
export function extractSymbolContent(content: string, filePath: string, symbolName: string): SymbolEntry & { content: string } | null {
  const symbols = listSymbols(content, filePath);
  const sym = symbols.find((s) => s.name === symbolName);
  if (!sym) return null;

  const lines = content.split("\n");
  const slice = lines.slice(sym.lineStart - 1, sym.lineEnd).join("\n");
  return { ...sym, content: slice };
}
