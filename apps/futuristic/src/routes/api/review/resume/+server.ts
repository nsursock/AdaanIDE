import { json } from "@sveltejs/kit";
import { reviewStore, reviewRunManager, getProvider, getWorkspace } from "@adaan/core/server";
import { runEventStream } from "$lib/server/run-stream";

/** POST /api/review/resume — resume an interrupted run, reusing the reviewer
 *  outputs that were persisted incrementally. Reviewers whose output already
 *  exists are skipped (not re-billed); only missing/failed ones re-run, then
 *  the aggregator proceeds. Same result id is reused.
 *
 *  Body: { resultId: string, workspaceRoot?: string }
 *  Streams ReviewProgress events (same shape as POST /api/review/run). */
export async function POST({ request }) {
  let body: { resultId?: string; workspaceRoot?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.resultId) return json({ error: "resultId required" }, { status: 400 });

  await reviewStore.load();
  const prev = reviewStore.getResult(body.resultId);
  const config = prev && reviewStore.getConfig(prev.configId);
  // The config's own workspace root wins — that's the project under review;
  // the caller's currently-open project is only a fallback.
  const root = config?.workspaceRoot ?? body.workspaceRoot;
  if (!root) return json({ error: "workspaceRoot required" }, { status: 400 });

  let provider;
  try {
    provider = getProvider();
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Provider not initialized" },
      { status: 500 },
    );
  }

  let workspace;
  try {
    workspace = getWorkspace(root);
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Workspace not available" },
      { status: 500 },
    );
  }

  const started = await reviewRunManager.resumeRun(body.resultId, provider, workspace);
  if (!started) {
    return json(
      { error: "Run is not resumable (no surviving reviewer outputs, or its config was deleted)" },
      { status: 409 },
    );
  }
  const stream = runEventStream(started.resultId);
  if (!stream) return json({ error: "run failed to start" }, { status: 500 });
  return stream;
}
