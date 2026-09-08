import { json } from "@sveltejs/kit";
import {
  reviewStore,
  getProvider,
  fetchAllGenerationMetadata,
} from "@adaan/core/server";
import { OpenRouterProvider } from "@adaan/core/server";
import type { ReviewResult } from "@adaan/core/server";

/** Fetch generation metadata for every id in `result.generationIds`,
 *  recompute actualCost/actualTokens from the results, and persist. Shared
 *  by GET (refresh) and POST (manual reconciliation) below. */
async function reconcile(result: ReviewResult): Promise<{ metadata: Record<string, unknown>; error?: string }> {
  if (!result.generationIds || Object.keys(result.generationIds).length === 0) {
    return { metadata: {}, error: "no generation ids captured for this run" };
  }

  let provider;
  try {
    provider = getProvider();
  } catch (e) {
    return { metadata: {}, error: e instanceof Error ? e.message : "Provider not initialized" };
  }

  if (!(provider instanceof OpenRouterProvider) || provider.hasCustomBaseUrl()) {
    return { metadata: {}, error: "Generation API is only available on the OpenRouter endpoint" };
  }

  const apiKey = provider.getApiKey();
  if (!apiKey || apiKey === "not-needed") {
    return { metadata: {}, error: "API key required to query generation metadata" };
  }

  const metadata = await fetchAllGenerationMetadata(apiKey, result.generationIds, provider.getBaseUrl());

  if (Object.keys(metadata).length > 0) {
    result.generationMetadata = metadata;
    // Dedupe by OpenRouter generation id before summing cost/tokens — the
    // same generation can be referenced under more than one key (e.g. a
    // legacy unprefixed key left over from before the reviewer:/aggregator:
    // key prefixes were introduced, pointing at the same id as its
    // replacement). Without this, reconciled runs double-count shared
    // generations and inflate actualCost above what OpenRouter billed.
    const seenGenerationIds = new Set<string>();
    let totalCost = 0;
    let totalTokens = 0;
    for (const m of Object.values(metadata)) {
      if (seenGenerationIds.has(m.id)) continue;
      seenGenerationIds.add(m.id);
      totalCost += m.totalCost || 0;
      totalTokens += (m.tokensPrompt || 0) + (m.tokensCompletion || 0);
    }
    result.actualCost = Math.round(totalCost * 10000) / 10000;
    result.actualTokens = totalTokens;
    await reviewStore.updateResult(result);
  }

  return { metadata };
}

/** GET /api/review/generations?id=<runId> — fetch actual generation metadata
 *  from the OpenRouter Generation API for a completed run. Returns the
 *  generationMetadata map keyed by requested model id.
 *
 *  This is used to backfill older runs that completed before the
 *  auto-enrichment was added, or to refresh metadata for a run. */
export async function GET({ url }) {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "id required" }, { status: 400 });

  await reviewStore.load();
  const result = reviewStore.getResult(id);
  if (!result) return json({ error: "not found" }, { status: 404 });

  const { metadata, error } = await reconcile(result);
  if (error) return json({ error }, { status: 400 });
  return json({ metadata, actualCost: result.actualCost, actualTokens: result.actualTokens });
}

/** POST /api/review/generations — manually reconcile a run with generation
 *  IDs that AdaanIDE failed to capture (e.g. a network hiccup dropped the
 *  SSE stream before the id arrived, or an older client version predates
 *  generation-id capture). Body: { id: runId, generationIds: Record<string,
 *  string>, mode?: "merge" | "replace" }.
 *  - "merge" (default): merges into the run's existing `generationIds`
 *    (new keys win on conflict). Safe, but can leave stale legacy keys
 *    around (deduped by generation id when computing cost, but still
 *    visible as extra rows in the audit table).
 *  - "replace": discards the existing `generationIds` entirely in favor of
 *    the supplied set. Use this to clean up a run whose keys predate a
 *    naming-scheme change (e.g. legacy unprefixed keys).
 *  Either way, all resulting ids are re-fetched from OpenRouter and the
 *  run's actualCost/actualTokens/generationMetadata are recomputed so the
 *  Generation Audit table reconciles with what OpenRouter actually billed. */
export async function POST({ request }) {
  let body: { id?: string; generationIds?: Record<string, string>; mode?: "merge" | "replace" };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.id) return json({ error: "id required" }, { status: 400 });
  if (!body.generationIds || Object.keys(body.generationIds).length === 0) {
    return json({ error: "generationIds required" }, { status: 400 });
  }

  await reviewStore.load();
  const result = reviewStore.getResult(body.id);
  if (!result) return json({ error: "not found" }, { status: 404 });

  result.generationIds = body.mode === "replace"
    ? { ...body.generationIds }
    : { ...(result.generationIds ?? {}), ...body.generationIds };

  const { metadata, error } = await reconcile(result);
  if (error) return json({ error }, { status: 400 });
  return json({ metadata, actualCost: result.actualCost, actualTokens: result.actualTokens, generationIds: result.generationIds });
}
