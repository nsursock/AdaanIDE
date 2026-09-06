import { json } from "@sveltejs/kit";
import {
  reviewStore,
  runReview,
  getProvider,
  getWorkspace,
  registerRun,
  unregisterRun,
  type ReviewConfig,
} from "@adaan/core/server";

/** POST /api/review/run — run a review as an SSE stream.
 *  Body: { configId?: string, config?: ReviewConfig, workspaceRoot: string }
 *  Streams ReviewProgress events; the final event is `{ phase: "complete", result }`. */
export async function POST({ request }) {
  let body: { configId?: string; config?: ReviewConfig; workspaceRoot?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  await reviewStore.load();
  let config: ReviewConfig | undefined;
  if (body.configId) {
    config = reviewStore.getConfig(body.configId);
    if (!config) return json({ error: "config not found" }, { status: 404 });
  } else if (body.config) {
    config = body.config as ReviewConfig;
  }
  if (!config) return json({ error: "configId or config required" }, { status: 400 });

  const rootPath = body.workspaceRoot ?? config.workspaceRoot;
  if (!rootPath) return json({ error: "workspaceRoot required" }, { status: 400 });

  let provider;
  let workspace;
  try {
    provider = getProvider();
    workspace = getWorkspace(rootPath);
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Provider not initialized" },
      { status: 500 },
    );
  }

  const abortCtrl = new AbortController();
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  registerRun(runId, abortCtrl);

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(streamCtrl) {
      const send = (ev: unknown) => {
        try {
          streamCtrl.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          // streamCtrl closed
        }
      };
      try {
        const gen = runReview({
          config,
          workspace,
          provider,
          triggeredBy: "manual",
          signal: abortCtrl.signal,
          onResultUpdate: async (result) => {
            await reviewStore.updateResult(result);
          },
        });
        for await (const ev of gen) {
          send(ev);
        }
      } catch (e) {
        send({ phase: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        unregisterRun(runId);
      }
      try {
        streamCtrl.close();
      } catch {
        // already closed
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
