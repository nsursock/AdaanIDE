import type { ToolHandler, ToolResult } from "../../../types.js";
import { assertAgentPathAccess } from "../../security.js";
import { listSymbols, extractSymbolContent } from "./symbols.js";

export const listFilesHandler: ToolHandler = async (args, ctx) => {
  const dir = (args.dir as string) || undefined;
  if (dir) {
    assertAgentPathAccess(dir, "list");
  }
  const tree = await ctx.workspace.listTree(dir, 0, { showHidden: true, filterForAgent: true });
  // Flatten the tree to a compact path list for the LLM — full recursive
  // trees blow up context with nested JSON the model doesn't need.
  const flat: string[] = [];
  const walk = (nodes: any[], prefix: string) => {
    for (const n of nodes) {
      const p = prefix ? `${prefix}/${n.name}` : n.name;
      flat.push(n.type === "dir" ? `${p}/` : p);
      if (n.type === "dir" && n.children) walk(n.children, p);
    }
  };
  walk(tree, "");
  return { success: true, output: { files: flat, count: flat.length } };
};

export const readFileHandler: ToolHandler = async (args, ctx) => {
  const filePath = args.path as string;
  assertAgentPathAccess(filePath, "read");

  const symbol = args.symbol as string | undefined;
  const startLine = args.startLine as number | undefined;
  const endLine = args.endLine as number | undefined;

  try {
    if (symbol) {
      const full = await ctx.workspace.readFile(filePath);
      const sym = extractSymbolContent(full.content, filePath, symbol);
      if (!sym) {
        return { success: false, output: null, error: `Symbol not found: ${symbol}` };
      }
      return {
        success: true,
        output: {
          content: sym.content,
          hash: full.hash,
          path: filePath,
          symbol: sym.name,
          lineStart: sym.lineStart,
          lineEnd: sym.lineEnd,
        },
      };
    }

    if (startLine !== undefined && endLine !== undefined) {
      const result = await ctx.workspace.readFileRange(filePath, startLine, endLine);
      return { success: true, output: result };
    }

    const result = await ctx.workspace.readFile(filePath);
    return { success: true, output: result };
  } catch (e: any) {
    // On file-not-found, include a listing of the parent directory so the
    // agent can self-correct instead of guessing paths blindly.
    const msg = e.message ?? "read_file failed";
    if (/not found|ENOENT/i.test(msg)) {
      const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ".";
      try {
        const tree = await ctx.workspace.listTree(dir, 1, { showHidden: false, filterForAgent: true });
        const flat: string[] = [];
        const walk = (nodes: any[], prefix: string) => {
          for (const n of nodes) {
            const p = prefix ? `${prefix}/${n.name}` : n.name;
            flat.push(n.type === "dir" ? `${p}/` : p);
            if (n.type === "dir" && n.children) walk(n.children, p);
          }
        };
        walk(tree, "");
        return {
          success: false,
          output: null,
          error: `${msg}\n\nFiles in "${dir}":\n${flat.slice(0, 30).join("\n")}${flat.length > 30 ? `\n... and ${flat.length - 30} more` : ""}`,
        };
      } catch {
        // directory listing failed — just return the original error
      }
    }
    throw e;
  }
};

export const listSymbolsHandler: ToolHandler = async (args, ctx) => {
  const filePath = args.path as string;
  assertAgentPathAccess(filePath, "read");
  const file = await ctx.workspace.readFile(filePath);
  const symbols = listSymbols(file.content, filePath);
  return { success: true, output: symbols };
};

export const searchFilesHandler: ToolHandler = async (args, ctx) => {
  const query = args.query as string;
  const glob = args.glob as string | undefined;
  const results = await ctx.workspace.search(query, glob, true);
  return { success: true, output: results };
};

export const applyPatchHandler: ToolHandler = async (args, ctx) => {
  const filePath = args.path as string;
  assertAgentPathAccess(filePath, "patch");
  const patch = args.patch as string;
  const expectedHash = args.expectedHash as string;
  const result = await ctx.workspace.applyPatch(filePath, patch, expectedHash);
  return { success: true, output: result };
};

export const writeFileHandler: ToolHandler = async (args, ctx) => {
  const filePath = args.path as string;
  assertAgentPathAccess(filePath, "write");
  const content = args.content as string;
  const expectedHash = args.expectedHash as string | undefined;
  const result = await ctx.workspace.writeFile(filePath, content, expectedHash);
  return { success: true, output: result };
};

export const createFileHandler: ToolHandler = async (args, ctx) => {
  const filePath = args.path as string;
  const content = (args.content as string) ?? "";
  assertAgentPathAccess(filePath, "create");
  const result = await ctx.workspace.createFile(filePath, content);
  return { success: true, output: result };
};

export const deleteFileHandler: ToolHandler = async (args, ctx) => {
  const filePath = args.path as string;
  assertAgentPathAccess(filePath, "delete");
  const toolCallId = args._toolCallId as string;

  // Request approval from the user
  const approved = await ctx.requestApproval(toolCallId, "delete_file", { path: filePath });
  if (!approved) {
    return { success: false, output: null, error: "Delete denied by user" };
  }

  const result = await ctx.workspace.deleteFile(filePath);
  return { success: true, output: result };
};

export const executeCommandHandler: ToolHandler = async (args, ctx) => {
  const command = args.command as string;
  const timeoutMs = args.timeoutMs as number | undefined;
  const result = await ctx.workspace.executeCommand(command, timeoutMs);
  return { success: true, output: result };
};

export const runTestsHandler: ToolHandler = async (args, ctx) => {
  const filter = args.filter as string | undefined;

  // Detect test framework
  const hasPytest = await ctx.workspace.exists("pytest.ini");
  const hasPyproject = await ctx.workspace.exists("pyproject.toml");
  const hasPackageJson = await ctx.workspace.exists("package.json");
  const hasCargo = await ctx.workspace.exists("Cargo.toml");

  let command: string;
  if (hasPytest || hasPyproject) {
    command = filter ? `python -m pytest -k "${filter}" -v` : "python -m pytest -v";
  } else if (hasPackageJson) {
    command = filter ? `npm test -- --grep "${filter}"` : "npm test";
  } else if (hasCargo) {
    command = filter ? `cargo test ${filter}` : "cargo test";
  } else {
    // Fallback: look for Python test files (test_*.py / *_test.py) and run
    // pytest directly — it auto-discovers them without a config file.
    const tree = await ctx.workspace.listTree("", 0, { showHidden: true, filterForAgent: true });
    const flat: string[] = [];
    const walk = (nodes: any[], prefix: string) => {
      for (const n of nodes) {
        const p = prefix ? `${prefix}/${n.name}` : n.name;
        if (n.type === "file") flat.push(p);
        if (n.type === "dir" && n.children) walk(n.children, p);
      }
    };
    walk(tree, "");
    const hasPyTests = flat.some(
      (f) => /^test_.*\.py$/.test(f) || /_test\.py$/.test(f),
    );
    if (hasPyTests) {
      command = filter ? `python -m pytest -k "${filter}" -v` : "python -m pytest -v";
    } else {
      return {
        success: false,
        output: null,
        error: "No test framework detected (looked for pytest.ini, pyproject.toml, package.json, Cargo.toml, test_*.py)",
      };
    }
  }

  const result = await ctx.workspace.executeCommand(command, 60_000);
  return { success: true, output: result };
};

export const gitStatusHandler: ToolHandler = async (_args, ctx) => {
  const output = await ctx.workspace.gitStatus();
  return { success: true, output };
};

export const gitDiffHandler: ToolHandler = async (args, ctx) => {
  const file = args.file as string | undefined;
  const output = await ctx.workspace.gitDiff(file);
  return { success: true, output };
};

export const gitCheckpointHandler: ToolHandler = async (args, ctx) => {
  const message = args.message as string;
  const output = await ctx.workspace.gitCheckpoint(message);
  return { success: true, output };
};

export const gitRollbackHandler: ToolHandler = async (args, ctx) => {
  const ref = args.ref as string | undefined;
  const output = await ctx.workspace.gitRollback(ref);
  return { success: true, output };
};
