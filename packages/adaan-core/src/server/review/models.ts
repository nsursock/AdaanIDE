import type { LLMProvider } from "../agent/provider.js";
import type { ModelInfo } from "../../types.js";
import type { ReviewConfig, ModelTier, GenerationMetadata } from "./types.js";

/**
 * Model resolution + cost estimation for committee reviews.
 *
 * Tiers:
 *  - "free": all free models from the live OpenRouter catalog
 *  - "paid": all paid models from the live catalog
 *  - "all":  all models (free + paid)
 *
 * When reviewerModels is empty, auto-picks N models from the tier pool
 * (cheapest first for free, best-known for paid).
 */

/** Fetch the full model catalog split by tier. */
export async function fetchModelsByTier(
  provider: LLMProvider,
): Promise<{ free: ModelInfo[]; paid: ModelInfo[] }> {
  try {
    return await provider.listModels();
  } catch {
    return { free: [], paid: [] };
  }
}

/** Get the model pool for a tier. */
export function poolForTier(
  tier: ModelTier,
  free: ModelInfo[],
  paid: ModelInfo[],
): ModelInfo[] {
  if (tier === "free") return free;
  if (tier === "paid") return paid;
  return [...free, ...paid];
}

/** Resolve reviewer model ids from a config. When reviewerModels is empty,
 *  auto-picks N from the tier pool. */
export async function resolveReviewerModels(
  config: Pick<ReviewConfig, "modelTier" | "reviewerModels">,
  provider: LLMProvider,
  count: number,
): Promise<{ ids: string[]; models: ModelInfo[] }> {
  // If user picked specific models, use them.
  if (config.reviewerModels.length > 0) {
    const { free, paid } = await fetchModelsByTier(provider);
    const all = [...free, ...paid];
    const models = config.reviewerModels
      .map((id) => {
        // Try exact match first, then prefix match (the catalog often has
        // date-suffixed slugs like "anthropic/claude-sonnet-5-20260630"
        // while the user selected "anthropic/claude-sonnet-5").
        const exact = all.find((m) => m.id === id);
        if (exact) return exact;
        const prefix = all.find((m) => m.id.startsWith(id + "-") || m.id.startsWith(id));
        return prefix;
      })
      .filter((m): m is ModelInfo => !!m);
    return { ids: config.reviewerModels, models };
  }

  // Auto-pick from the tier pool.
  const { free, paid } = await fetchModelsByTier(provider);
  const pool = poolForTier(config.modelTier, free, paid);
  // Take the first N (listModels already sorts by relevance).
  const picked = pool.slice(0, Math.max(1, count));
  return { ids: picked.map((m) => m.id), models: picked };
}

/** Is the aggregator model id the "auto" sentinel? (empty, "auto",
 *  "openrouter/auto", or "openrouter/free" all mean "pick a model from
 *  the same tier as the reviewers".) */
export function isAutoAggregator(model: string | undefined): boolean {
  const m = model?.trim();
  return !m || m === "auto" || m === "openrouter/auto" || m === "openrouter/free";
}

/** Resolve the aggregator model. If the user picked a specific model, use it.
 *  Otherwise return the auto sentinel — the caller should resolve it to a
 *  concrete model from the right tier via {@link pickAutoAggregator} once the
 *  catalog is available. */
export function resolveAggregatorModel(
  config: Pick<ReviewConfig, "aggregatorModel">,
  reviewerIds: string[],
): string {
  const agg = config.aggregatorModel?.trim();
  if (agg && !isAutoAggregator(agg)) {
    return agg;
  }
  // Can't resolve yet without the catalog — return the sentinel. The runner
  // will call pickAutoAggregator after fetching the model list.
  return reviewerIds[0] ?? "openrouter/auto";
}

/** Pick a concrete aggregator model for the "auto" case, matching the tier
 *  of the reviewers so a free-only committee gets a free judge and a
 *  paid-only committee gets a paid judge.
 *
 *  Uses OpenRouter's tiered auto-routers:
 *  - All reviewers free  → "openrouter/free" (OpenRouter picks best free model)
 *  - All reviewers paid  → "openrouter/auto" (OpenRouter picks best paid model)
 *  - Mixed / unknown     → "openrouter/auto" (safe default, may go paid)
 *
 *  This is better than hardcoding a specific free model because OpenRouter
 *  knows which free models are currently available (not rate-limited) and
 *  handles failover automatically.
 */
export function pickAutoAggregator(
  reviewerIds: string[],
  free: ModelInfo[],
  paid: ModelInfo[],
): string {
  const freeSet = new Set(free.map((m) => m.id));
  const paidSet = new Set(paid.map((m) => m.id));
  let allFree = true;
  let allPaid = true;
  let anyKnown = false;
  for (const id of reviewerIds) {
    const isFree = freeSet.has(id);
    const isPaid = paidSet.has(id);
    if (isFree || isPaid) anyKnown = true;
    if (!isFree) allFree = false;
    if (!isPaid) allPaid = false;
  }
  // If we couldn't classify any reviewer, fall back to openrouter/auto.
  if (!anyKnown) return "openrouter/auto";
  // All free → free judge via OpenRouter's free auto-router.
  if (allFree) return "openrouter/free";
  // All paid (or mixed) → paid judge via auto-routing.
  return "openrouter/auto";
}

/** Estimate the cost of a review run in USD.
 *  - Input tokens: committee prompt (~12k context + ~2k prompt overhead)
 *  - Output tokens: estimated ~4k per reviewer (lenses analysis + table)
 *  - Aggregator: input = sum of reviewer outputs (~N×4k), output ~2k
 *  Returns { cost, tokens }. */
export function estimateReviewCost(
  reviewerModels: ModelInfo[],
  aggregatorModel: ModelInfo | undefined,
  contextTokens: number,
  reviewerCount: number,
): { cost: number; tokens: number } {
  const PROMPT_OVERHEAD = 2000;
  const EST_OUTPUT_PER_REVIEWER = 4000;
  const EST_AGG_OUTPUT = 2000;

  // OpenRouter returns per-token pricing (e.g. "0.000002" = $0.000002/token
  // = $2/1M tokens). Convert to per-1M for the cost formula below.
  // Free models can have negative pricing (subsidy). Clamp to 0 so cost
  // estimates never go negative.
  const pricePer1M = (s: string | undefined): number => {
    const v = parseFloat(s ?? "0");
    return (isNaN(v) || v < 0 ? 0 : v) * 1_000_000;
  };

  let totalCost = 0;
  let totalTokens = 0;

  // Reviewer calls
  for (let i = 0; i < reviewerCount; i++) {
    const model = reviewerModels[i] ?? reviewerModels[0];
    if (!model) continue;
    const inputTokens = contextTokens + PROMPT_OVERHEAD;
    const outputTokens = EST_OUTPUT_PER_REVIEWER;
    const promptPrice = pricePer1M(model.pricing?.prompt);
    const completionPrice = pricePer1M(model.pricing?.completion);
    // promptPrice/completionPrice are per-1M tokens (converted above)
    const cost = (inputTokens / 1_000_000) * promptPrice + (outputTokens / 1_000_000) * completionPrice;
    totalCost += cost;
    totalTokens += inputTokens + outputTokens;
  }

  // Aggregator call
  if (aggregatorModel) {
    const aggInput = reviewerCount * EST_OUTPUT_PER_REVIEWER + PROMPT_OVERHEAD;
    const aggOutput = EST_AGG_OUTPUT;
    const promptPrice = pricePer1M(aggregatorModel.pricing?.prompt);
    const completionPrice = pricePer1M(aggregatorModel.pricing?.completion);
    totalCost += (aggInput / 1_000_000) * promptPrice + (aggOutput / 1_000_000) * completionPrice;
    totalTokens += aggInput + aggOutput;
  }

  return { cost: Math.round(totalCost * 10000) / 10000, tokens: totalTokens };
}

/** Find a model in a list by id. */
export function findModel(models: ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((m) => m.id === id);
}

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

/** Fetch generation metadata from the OpenRouter Generation API.
 *  GET /api/v1/generation?id=<genId> — requires a regular API key (not a
 *  management key). Returns the actual model, provider, cost, tokens, and
 *  routing for a generation, which may differ from what was requested
 *  (failover on 429, auto-router decisions, etc.). */
export async function fetchGenerationMetadata(
  apiKey: string,
  generationId: string,
  baseUrl?: string,
): Promise<GenerationMetadata | null> {
  try {
    const base = baseUrl ?? OPENROUTER_API_BASE;
    const res = await fetch(`${base}/generation?id=${encodeURIComponent(generationId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: {
        id: string;
        model?: string;
        provider_name?: string;
        router?: string;
        total_cost?: number;
        usage?: number;
        tokens_prompt?: number;
        tokens_completion?: number;
        native_tokens_reasoning?: number;
        native_tokens_cached?: number;
        latency?: number;
        generation_time?: number;
        finish_reason?: string;
        native_finish_reason?: string;
        is_byok?: boolean;
        created_at?: string;
      };
    };
    const d = json.data;
    if (!d) return null;
    return {
      id: d.id,
      model: d.model ?? generationId,
      providerName: d.provider_name,
      router: d.router,
      totalCost: d.total_cost ?? d.usage ?? 0,
      tokensPrompt: d.tokens_prompt ?? 0,
      tokensCompletion: d.tokens_completion ?? 0,
      tokensReasoning: d.native_tokens_reasoning,
      tokensCached: d.native_tokens_cached,
      latency: d.latency ?? d.generation_time,
      finishReason: d.finish_reason ?? d.native_finish_reason,
      isByok: d.is_byok,
      createdAt: d.created_at,
    };
  } catch {
    return null;
  }
}

/** Fetch generation metadata for all generation IDs in a run. Returns a
 *  map keyed by the requested model id (same keys as `generationIds`).
 *  Failures (network, 404, timeout) are silently skipped — partial data
 *  is better than none. */
export async function fetchAllGenerationMetadata(
  apiKey: string,
  generationIds: Record<string, string>,
  baseUrl?: string,
): Promise<Record<string, GenerationMetadata>> {
  const entries = Object.entries(generationIds);
  if (entries.length === 0) return {};
  const results = await Promise.all(
    entries.map(async ([model, genId]) => {
      const meta = await fetchGenerationMetadata(apiKey, genId, baseUrl);
      return [model, meta] as const;
    }),
  );
  const map: Record<string, GenerationMetadata> = {};
  for (const [model, meta] of results) {
    if (meta) map[model] = meta;
  }
  return map;
}

/** Popularity data for a model — total tokens used on OpenRouter over a
 *  recent window, fetched from the public rankings-daily dataset. */
export interface ModelPopularity {
  /** The model's canonical permaslug (e.g. "openai/gpt-4o-2024-05-13"). */
  permaslug: string;
  /** Total tokens (prompt + completion) over the fetched window. */
  totalTokens: number;
}

/** Fetch model popularity from the OpenRouter public rankings-daily dataset.
 *  Returns a map of model permaslug → total tokens over the last N days.
 *  Uses the regular API key (not a management key). Rate-limited to 30
 *  req/min per key.
 *
 *  The dataset covers the top 50 models per day by token usage — models
 *  outside the top 50 are aggregated into an "other" row and not individually
 *  tracked. This makes it a good signal for "which paid models are worth
 *  the dollar" (popular models are in the top 50) but not a complete
 *  ranking of every model on the platform.
 *
 *  @param days Number of recent days to aggregate (default 7). More days =
 *    more stable signal but slower to reflect recent shifts.
 */
export async function fetchModelPopularity(
  apiKey: string,
  baseUrl?: string,
  days = 7,
): Promise<Map<string, number>> {
  try {
    const base = baseUrl ?? OPENROUTER_API_BASE;
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - days);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const url = `${base}/datasets/rankings-daily?start_date=${fmt(startDate)}&end_date=${fmt(endDate)}&period=day`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return new Map();
    const json = (await res.json()) as {
      data?: { model_permaslug: string; total_tokens: string }[];
    };
    const rows = json.data ?? [];
    const map = new Map<string, number>();
    for (const row of rows) {
      if (row.model_permaslug === "other") continue;
      const tokens = parseInt(row.total_tokens, 10) || 0;
      map.set(row.model_permaslug, (map.get(row.model_permaslug) ?? 0) + tokens);
    }
    return map;
  } catch {
    return new Map();
  }
}
