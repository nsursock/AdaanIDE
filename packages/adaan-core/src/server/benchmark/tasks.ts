import type { Workspace } from "../workspace.js";

export interface BenchmarkTask {
  id: string;
  scaffold: Record<string, string>;
  prompt: string;
  maxIterations: number;
  verify: (ws: Workspace) => Promise<{ pass: boolean; detail: string }>;
}

/** Shared scaffold for the edit-format experiment — a 50-line calculator
 *  module with a bug in divide(). Big enough that full rewrite is nontrivial
 *  for a 4B model, small enough to fit in context. */
const EDIT_FORMAT_SCAFFOLD = `class Calculator:
    def __init__(self):
        self.history = []

    def add(self, a, b):
        result = a + b
        self.history.append(f"{a} + {b} = {result}")
        return result

    def subtract(self, a, b):
        result = a - b
        self.history.append(f"{a} - {b} = {result}")
        return result

    def multiply(self, a, b):
        result = a * b
        self.history.append(f"{a} * {b} = {result}")
        return result

    def divide(self, a, b):
        if b == 0:
            raise ValueError("Cannot divide by zero")
        result = a * b  # BUG: should be a / b
        self.history.append(f"{a} / {b} = {result}")
        return result

    def power(self, a, b):
        result = a ** b
        self.history.append(f"{a} ** {b} = {result}")
        return result

    def modulo(self, a, b):
        if b == 0:
            raise ValueError("Cannot modulo by zero")
        result = a % b
        self.history.append(f"{a} % {b} = {result}")
        return result

    def clear_history(self):
        self.history = []

    def get_history(self):
        return list(self.history)

    def average(self, numbers):
        if not numbers:
            return 0
        return sum(numbers) / len(numbers)

    def factorial(self, n):
        if n < 0:
            raise ValueError("Cannot compute factorial of negative number")
        if n <= 1:
            return 1
        result = 1
        for i in range(2, n + 1):
            result *= i
        return result
`;

/** Shared verify for all three edit-format variants — the bug must be fixed
 *  AND the rest of the file must be intact (so truncated rewrites fail). */
async function editFormatVerify(ws: Workspace): Promise<{ pass: boolean; detail: string }> {
  const { content } = await ws.readFile("calculator.py");
  // Bug fix: divide must use a / b, not a * b
  const hasFix = content.includes("a / b") && !content.includes("a * b  # BUG");
  if (!hasFix) return { pass: false, detail: "divide() still has the bug (a * b)" };
  // Integrity: all other functions must still be present
  const requiredFunctions = ["add", "subtract", "multiply", "power", "modulo", "clear_history", "get_history", "average", "factorial"];
  const missing = requiredFunctions.filter((fn) => !content.includes(`def ${fn}(`));
  if (missing.length > 0) return { pass: false, detail: `Missing functions: ${missing.join(", ")}` };
  // The class definition must still be there
  if (!content.includes("class Calculator:")) return { pass: false, detail: "Missing Calculator class" };
  return { pass: true, detail: "divide() fixed, all functions intact" };
}

/**
 * 10 benchmark tasks — one per category. Scaffolds are tiny self-contained
 * projects. verify() is deterministic: run tests, grep file contents, check
 * outputs.
 */
export const BENCHMARK_TASKS: BenchmarkTask[] = [
  {
    id: "simple-edit",
    scaffold: {
      "math_utils.py": "def add(a, b):\n    return a - b  # BUG: should be +\n\ndef multiply(a, b):\n    return a * b\n",
    },
    prompt: "Fix the bug in math_utils.py — the add function is returning the wrong result.",
    maxIterations: 4,
    verify: async (ws) => {
      const { content } = await ws.readFile("math_utils.py");
      const pass = !content.includes("return a - b") && content.includes("return a + b");
      return { pass, detail: pass ? "add() now returns a + b" : "add() still returns a - b" };
    },
  },
  {
    id: "bug-fix",
    scaffold: {
      "counter.py": "class Counter:\n    def __init__(self):\n        self.count = 0\n    def increment(self):\n        self.count += 1\n    def decrement(self):\n        self.count += 1  # BUG: should subtract\n    def get(self):\n        return self.count\n",
    },
    prompt: "The Counter.decrement() method has a bug — it increments instead of decrementing. Fix it.",
    maxIterations: 4,
    verify: async (ws) => {
      const { content } = await ws.readFile("counter.py");
      const pass = content.includes("self.count -= 1") && !content.includes("self.count += 1  # BUG");
      return { pass, detail: pass ? "decrement() now subtracts" : "decrement() still wrong" };
    },
  },
  {
    id: "test-gen",
    scaffold: {
      "string_utils.py": "def reverse(s):\n    return s[::-1]\n\ndef is_palindrome(s):\n    return s == s[::-1]\n",
    },
    prompt: "Write unit tests for string_utils.py using pytest. Test both reverse() and is_palindrome().",
    maxIterations: 5,
    verify: async (ws) => {
      try {
        const nodes = await ws.listTree(".", 0, { showHidden: false });
        const testFile = nodes.find((f) => f.name.startsWith("test_") && f.name.endsWith(".py"));
        if (!testFile) return { pass: false, detail: "No test file created" };
        const { content } = await ws.readFile(testFile.path);
        const hasReverse = content.includes("reverse");
        const hasPalindrome = content.includes("palindrome");
        const pass = hasReverse && hasPalindrome;
        return { pass, detail: pass ? "Tests cover both functions" : "Missing test coverage" };
      } catch (e) {
        return { pass: false, detail: `Error: ${e}` };
      }
    },
  },
  {
    id: "refactor",
    scaffold: {
      "shapes.py": "class Circle:\n    def __init__(self, r):\n        self.r = r\n    def area(self):\n        return 3.14159 * self.r * self.r\n\nclass Square:\n    def __init__(self, s):\n        self.s = s\n    def area(self):\n        return self.s * self.s\n\nclass Triangle:\n    def __init__(self, b, h):\n        self.b = b\n        self.h = h\n    def area(self):\n        return 0.5 * self.b * self.h\n",
    },
    prompt: "Refactor shapes.py to use a common Shape base class with an abstract area() method.",
    maxIterations: 5,
    verify: async (ws) => {
      const { content } = await ws.readFile("shapes.py");
      const hasBase = /class\s+Shape/.test(content);
      const hasInherit = /class\s+(Circle|Square|Triangle)\s*\(\s*Shape\s*\)/.test(content);
      const pass = hasBase && hasInherit;
      return { pass, detail: pass ? "Base class + inheritance" : "Missing base class or inheritance" };
    },
  },
  {
    id: "multi-file",
    scaffold: {
      "main.js": "import { greet } from './greet.js';\nimport { farewell } from './farewell.js';\nconsole.log(greet('World'));\nconsole.log(farewell('World'));\n",
      "greet.js": "export function greet(name) {\n  return 'Hello, ' + name;\n}\n",
      "farewell.js": "export function farewell(name) {\n  return 'Goodbye, ' + name;\n}\n",
    },
    prompt: "Add a new function `shout()` to greet.js that returns the greeting in uppercase, and update main.js to use it.",
    maxIterations: 5,
    verify: async (ws) => {
      const { content: greetContent } = await ws.readFile("greet.js");
      const { content: mainContent } = await ws.readFile("main.js");
      const hasShout = greetContent.includes("shout") && greetContent.includes("toUpperCase");
      const usesShout = mainContent.includes("shout");
      const pass = hasShout && usesShout;
      return { pass, detail: pass ? "shout() added and used" : "Missing shout() or not used" };
    },
  },
  {
    id: "debugging",
    scaffold: {
      "fib.py": "def fib(n):\n    if n <= 1:\n        return n\n    return fib(n-1) + fib(n-2)  # correct but slow\n\n# BUG: this should handle n=0\nprint(fib(10))\n",
    },
    prompt: "The fib() function in fib.py works but is very slow for large n. Add memoization to speed it up.",
    maxIterations: 5,
    verify: async (ws) => {
      const { content } = await ws.readFile("fib.py");
      const hasMemo = /memo|cache|dict|lru_cache/.test(content);
      const pass = hasMemo;
      return { pass, detail: pass ? "Memoization added" : "No memoization found" };
    },
  },
  {
    id: "exploration",
    scaffold: {
      "README.md": "# My Project\n\nA simple Python project.\n\n## Files\n- main.py: entry point\n- utils.py: helpers\n",
      "main.py": "from utils import helper\n\nif __name__ == '__main__':\n    helper()\n",
      "utils.py": "def helper():\n    print('Hello from utils')\n",
    },
    prompt: "Explain what this project does and list all the files and their purposes.",
    maxIterations: 3,
    verify: async (ws) => {
      // Exploration tasks are hard to verify deterministically — we just
      // check that the agent produced some text response (no file changes
      // needed). The runner will check that at least one text.delta event
      // was emitted.
      return { pass: true, detail: "Exploration task — verified by runner" };
    },
  },
  {
    id: "architecture",
    scaffold: {
      "app.py": "def handle_get():\n    return 'GET response'\n\ndef handle_post():\n    return 'POST response'\n\ndef handle_put():\n    return 'PUT response'\n\ndef handle_delete():\n    return 'DELETE response'\n",
    },
    prompt: "Refactor app.py to use a class-based RequestHandler with methods for each HTTP verb (GET, POST, PUT, DELETE).",
    maxIterations: 5,
    verify: async (ws) => {
      const { content } = await ws.readFile("app.py");
      const hasClass = /class\s+RequestHandler/.test(content);
      const hasMethods = /def\s+(get|post|put|delete)/.test(content);
      const pass = hasClass && hasMethods;
      return { pass, detail: pass ? "RequestHandler class with verb methods" : "Missing class or methods" };
    },
  },
  {
    id: "dependency",
    scaffold: {
      "package.json": '{\n  "name": "test-pkg",\n  "version": "1.0.0",\n  "scripts": {\n    "test": "echo no tests"\n  }\n}\n',
    },
    prompt: "Add a dev dependency on 'vitest' to package.json and update the test script to run vitest.",
    maxIterations: 4,
    verify: async (ws) => {
      const { content } = await ws.readFile("package.json");
      const hasVitest = content.includes("vitest");
      const hasDevDeps = /devDependencies/.test(content);
      const hasTestScript = content.includes("vitest") && /"test"\s*:/.test(content);
      const pass = hasVitest && hasDevDeps && hasTestScript;
      return { pass, detail: pass ? "vitest added as devDependency" : "Missing vitest dependency" };
    },
  },
  {
    id: "terminal",
    scaffold: {
      "script.py": "import sys\n\n# This script prints the first N fibonacci numbers\n# Usage: python script.py N\n\nn = int(sys.argv[1]) if len(sys.argv) > 1 else 10\na, b = 0, 1\nfor _ in range(n):\n    print(a)\n    a, b = b, a + b\n",
    },
    prompt: "Run script.py with argument 5 and tell me the output.",
    maxIterations: 3,
    verify: async (ws) => {
      // The runner will check that the agent executed a command.
      return { pass: true, detail: "Terminal task — verified by runner" };
    },
  },
  // --- Phase B: Edit-format experiment tasks (same bug, 3 variants) --------
  // The scaffold is a 50-line Python file with a bug in one function.
  // All three variants share the same verify() — the bug must be fixed AND
  // the rest of the file must be unchanged (so truncated rewrites fail).
  {
    id: "edit-format-patch",
    scaffold: {
      "calculator.py": EDIT_FORMAT_SCAFFOLD,
    },
    prompt: "Fix the bug in the divide() function in calculator.py — it returns a * b instead of a / b. Use apply_patch to make the fix.",
    maxIterations: 4,
    verify: editFormatVerify,
  },
  {
    id: "edit-format-rewrite",
    scaffold: {
      "calculator.py": EDIT_FORMAT_SCAFFOLD,
    },
    prompt: "Fix the bug in the divide() function in calculator.py — it returns a * b instead of a / b. Use write_file to rewrite the entire file with the fix.",
    maxIterations: 4,
    verify: editFormatVerify,
  },
  {
    id: "edit-format-directed-patch",
    scaffold: {
      "calculator.py": EDIT_FORMAT_SCAFFOLD,
    },
    prompt: "Fix the bug in the divide() function in calculator.py — it returns a * b instead of a / b.\n\nUse apply_patch with this exact format:\nSEARCH\n<exact original lines from the file>\nREPLACE\n<new lines to put in their place>\n---\n\nCopy the SEARCH lines exactly from read_file output. The SEARCH text must match the file exactly.",
    maxIterations: 4,
    verify: editFormatVerify,
  },
];
