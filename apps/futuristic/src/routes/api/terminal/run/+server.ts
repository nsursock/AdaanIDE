import { json } from "@sveltejs/kit";
import { spawn, type ChildProcess } from "node:child_process";
import {
  getWorkspace,
  isCommandAllowed,
  CommandDeniedError,
} from "@adaan/core/server";

/**
 * Run a shell command in the workspace root and stream output via SSE.
 *
 * Unlike the agent's execute_command (which uses exec() with a 30s timeout),
 * this endpoint uses spawn() with NO timeout so long-running processes like
 * dev servers (npm run dev, vite, etc.) stay alive and stream output in
 * real-time. The process is killed when the client disconnects.
 *
 * SSE event format:
 *   data: {"type":"stdout","data":"..."}\n\n
 *   data: {"type":"stderr","data":"..."}\n\n
 *   data: {"type":"exit","data":"0"}\n\n     (stream ends after this)
 */
export async function POST({ request }) {
  const { root, command } = await request.json();
  if (!root) return json({ error: "root required" }, { status: 400 });
  if (!command || typeof command !== "string" || !command.trim()) {
    return json({ error: "command required" }, { status: 400 });
  }

  const ws = getWorkspace(root);

  // Security check — same deny-list as execute_command
  if (!isCommandAllowed(command, ws.security.commandDenyList)) {
    return json(
      { error: new CommandDeniedError(command).message, exitCode: -1, denied: true },
      { status: 403 },
    );
  }

  const child = spawn(command, [], {
    cwd: ws.rootPath,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Shared state between start() and cancel() — both need to agree on
  // whether the stream is closed to avoid enqueuing into a closed controller.
  const state = { closed: false, controller: null as ReadableStreamDefaultController<Uint8Array> | null };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      state.controller = controller;
      const encoder = new TextEncoder();

      const send = (type: string, data: string) => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data })}\n\n`));
        } catch {
          // controller was closed by cancel() — mark and bail
          state.closed = true;
        }
      };

      const close = () => {
        if (state.closed) return;
        state.closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => send("stdout", chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => send("stderr", chunk.toString()));

      child.on("close", (code: number | null) => {
        send("exit", String(code ?? -1));
        close();
      });

      child.on("error", (err: Error) => {
        send("error", err.message);
        close();
      });
    },
    cancel() {
      // Client disconnected (page refresh, abort, stop button, etc.)
      // Mark closed FIRST so any in-flight event handlers don't try to enqueue
      // into an already-closed controller (which throws ERR_INVALID_STATE).
      state.closed = true;
      try {
        state.controller?.close();
      } catch {
        // already closed
      }
      killChild(child);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function killChild(child: ChildProcess) {
  try {
    child.kill("SIGTERM");
    // Give it 2s to exit gracefully, then force-kill
    setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      } catch {
        // already dead
      }
    }, 2000);
  } catch {
    // already dead
  }
}
