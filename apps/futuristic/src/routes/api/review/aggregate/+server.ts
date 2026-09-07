import { json } from "@sveltejs/kit";
import {
  reviewStore,
  reviewRunManager,
  getProvider,
  getWorkspace,
  type ReviewConfig,
} from "@adaan/core/server";
import { runEventStream } from "$lib/server/run-stream";

/** POST /api/review/aggregate — run ONLY the aggregator/judge on pre-existing
 *  reviewer outputs. Skips the committee phase entirely.
 *
 *  Body: {
 *    configId?: string,          // existing config id (mutually exclusive with config)
 *    config?: ReviewConfig,      // inline config (e.g. from a preset) — auto-saved
 *    workspaceRoot: string,
 *    reviewerOutputs: Record<string, string>,  // model-id → raw output text
 *    aggregatorModel?: string,   // override aggregator model
 *  }
 *
 *  Streams ReviewProgress events (aggregator/reasoning/parse/complete). Runs
 *  are detached from the request lifecycle (see run manager). */
export async function POST({ request }) {
  let body: {
    configId?: string;
    config?: ReviewConfig;
    workspaceRoot?: string;
    reviewerOutputs?: Record<string, string>;
    aggregatorModel?: string;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.configId && !body.config) {
    return json({ error: "configId or config required" }, { status: 400 });
  }
  if (!body.workspaceRoot) return json({ error: "workspaceRoot required" }, { status: 400 });
  if (!body.reviewerOutputs || Object.keys(body.reviewerOutputs).length === 0) {
    return json({ error: "reviewerOutputs required (at least one)" }, { status: 400 });
  }

  await reviewStore.load();
  let config: ReviewConfig | undefined;
  if (body.configId) {
    config = reviewStore.getConfig(body.configId);
    if (!config) return json({ error: "config not found" }, { status: 404 });
  } else if (body.config) {
    config = body.config as ReviewConfig;
    // Auto-save the inline config so the living task list has a home.
    if (!config.id) {
      config.id = `cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    if (!reviewStore.getConfig(config.id)) {
      await reviewStore.saveConfig(config);
    }
  }
  if (!config) return json({ error: "config not resolved" }, { status: 400 });

  let provider;
  let workspace;
  try {
    provider = getProvider();
    workspace = getWorkspace(body.workspaceRoot);
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Provider not initialized" },
      { status: 500 },
    );
  }

  const { resultId } = reviewRunManager.startAggregateRun({
    config,
    workspace,
    provider,
    reviewerOutputs: body.reviewerOutputs!,
    aggregatorModel: body.aggregatorModel,
  });

  const stream = runEventStream(resultId);
  if (!stream) return json({ error: "run failed to start" }, { status: 500 });
  return stream;
}
