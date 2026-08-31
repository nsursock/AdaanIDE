import { json } from "@sveltejs/kit";
import { getWorkspace, CommandDeniedError } from "@adaan/core/server";

/**
 * Run a shell command in the workspace root and return its output.
 * Reuses Workspace.executeCommand, which enforces the command deny-list
 * (rm -rf /, fork bombs, mkfs, etc.) and a 30s default timeout.
 *
 * This is a command-execution terminal, not an interactive PTY: each request
 * runs one command to completion and returns stdout/stderr/exitCode. There is
 * no stdin mid-run and no persistent shell state between commands.
 */
export async function POST({ request }) {
  const { root, command, timeoutMs } = await request.json();
  if (!root) return json({ error: "root required" }, { status: 400 });
  if (!command || typeof command !== "string" || !command.trim()) {
    return json({ error: "command required" }, { status: 400 });
  }

  const ws = getWorkspace(root);
  try {
    const result = await ws.executeCommand(command, typeof timeoutMs === "number" ? timeoutMs : undefined);
    return json(result);
  } catch (e: any) {
    if (e instanceof CommandDeniedError) {
      return json({ error: e.message, exitCode: -1, denied: true }, { status: 403 });
    }
    const status = e.status ?? 500;
    return json({ error: e.message ?? "Command failed", exitCode: -1 }, { status });
  }
}
