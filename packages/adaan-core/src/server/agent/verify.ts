/**
 * Post-edit verification gate (Phase A).
 *
 * Runs the cheapest file-scoped syntax check available for the edited file's
 * language. Pure and side-effect-free except for the shell command it runs.
 * Never throws — infrastructure failures (missing python, no node) return
 * `{ ok: true, checkRan: false }` so the gate never breaks the agent loop.
 */
import path from "node:path";
import type { Workspace } from "../workspace.js";

export interface VerifyResult {
  ok: boolean;
  errors: string;
  /** false = no check available for this file type / infrastructure missing.
   *  Callers must treat checkRan=false as a pass. */
  checkRan: boolean;
}

/** Truncate error output to ~600 chars, head-first. */
function truncateErrors(s: string): string {
  if (s.length <= 600) return s;
  return s.slice(0, 600) + "\n... (truncated)";
}

/**
 * Verify an edited file by running the cheapest available syntax check.
 * Detection is by file extension. The check runs via workspace.executeCommand
 * with a 15-second timeout.
 */
export async function verifyEditedFile(
  workspace: Workspace,
  filePath: string,
): Promise<VerifyResult> {
  const ext = path.extname(filePath).toLowerCase();

  // Build the command for the file's language.
  let command: string | null = null;
  switch (ext) {
    case ".py":
      command = `python3 -m py_compile ${JSON.stringify(filePath)}`;
      break;
    case ".js":
    case ".mjs":
    case ".cjs":
      command = `node --check ${JSON.stringify(filePath)}`;
      break;
    case ".ts":
    case ".tsx": {
      // TS requires a project-wide check — only run if tsconfig.json exists.
      // Use a relative path check via executeCommand (runs from workspace root).
      try {
        const { readFile } = await import("node:fs/promises");
        await readFile(path.join(workspace.rootPath, "tsconfig.json"), "utf-8");
        command = `npx tsc --noEmit -p .`;
      } catch {
        // No tsconfig — can't check TS meaningfully.
        return { ok: true, errors: "", checkRan: false };
      }
      break;
    }
    default:
      // No gate for this file type.
      return { ok: true, errors: "", checkRan: false };
  }

  if (!command) return { ok: true, errors: "", checkRan: false };

  try {
    const result = await workspace.executeCommand(command, 15_000);
    if (result.exitCode === 0) {
      return { ok: true, errors: "", checkRan: true };
    }
    // Combine stdout + stderr, truncate to first diagnostic.
    const raw = (result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      errors: truncateErrors(raw),
      checkRan: true,
    };
  } catch {
    // Infrastructure failure (missing python/node, command not allowed, etc.)
    // — the gate must never break the agent loop.
    return { ok: true, errors: "", checkRan: false };
  }
}
