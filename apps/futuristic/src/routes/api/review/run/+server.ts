import { json } from "@sveltejs/kit";
import {
  reviewStore,
  reviewRunManager,
  getProvider,
  getWorkspace,
  type ReviewConfig,
} from "@adaan/core/server";
import { runEventStream } from "$lib/server/run-stream";

/** POST /api/review/run — run a review as an SSE stream.
 *  Body: { configId?: string, config?: ReviewConfig, workspaceRoot: string }
 *  Streams ReviewProgress events; the first is `{ phase: "run.started", runId }`
 *  and the final one is `{ phase: "complete", result }` (or error/cancelled).
 *
 *  Runs are detached from the request: if the client disconnects, the run
 *  keeps going server-side and can be re-attached via GET below. */
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

  const { resultId } = reviewRunManager.startReviewRun({
    config,
    workspace,
    provider,
    triggeredBy: "manual",
  });

  const stream = runEventStream(resultId);
  if (!stream) return json({ error: "run failed to start" }, { status: 500 });
  return stream;
}

/** GET /api/review/run?runId= — (re)attach to a running (or recently
 *  finished) run as an SSE stream. Replays buffered state first. */
export async function GET({ url }) {
  const runId = url.searchParams.get("runId");
  if (!runId) return json({ error: "runId required" }, { status: 400 });
  const res = runEventStream(runId);
  if (!res) return json({ error: "run not found or already evicted" }, { status: 404 });
  return res;
}
