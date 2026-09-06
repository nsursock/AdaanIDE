import type { LLMProvider } from "../agent/provider.js";
import type { ModelInfo } from "../../types.js";
import type { ReviewConfig, ModelTier } from "./types.js";

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
      .map((id) => all.find((m) => m.id === id))
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

/** Resolve the aggregator model. "auto" = OpenRouter auto-routing, falling
 *  back to the first reviewer if none available. */
export function resolveAggregatorModel(
  config: Pick<ReviewConfig, "aggregatorModel">,
  reviewerIds: string[],
): string {
  if (config.aggregatorModel && config.aggregatorModel !== "auto") {
    return config.aggregatorModel;
  }
  return reviewerIds[0] ?? "openrouter/auto";
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

  let totalCost = 0;
  let totalTokens = 0;

  // Reviewer calls
  for (let i = 0; i < reviewerCount; i++) {
    const model = reviewerModels[i] ?? reviewerModels[0];
    if (!model) continue;
    const inputTokens = contextTokens + PROMPT_OVERHEAD;
    const outputTokens = EST_OUTPUT_PER_REVIEWER;
    const promptPrice = parseFloat(model.pricing?.prompt ?? "0") || 0;
    const completionPrice = parseFloat(model.pricing?.completion ?? "0") || 0;
    // OpenRouter prices are per 1M tokens
    const cost = (inputTokens / 1_000_000) * promptPrice + (outputTokens / 1_000_000) * completionPrice;
    totalCost += cost;
    totalTokens += inputTokens + outputTokens;
  }

  // Aggregator call
  if (aggregatorModel) {
    const aggInput = reviewerCount * EST_OUTPUT_PER_REVIEWER + PROMPT_OVERHEAD;
    const aggOutput = EST_AGG_OUTPUT;
    const promptPrice = parseFloat(aggregatorModel.pricing?.prompt ?? "0") || 0;
    const completionPrice = parseFloat(aggregatorModel.pricing?.completion ?? "0") || 0;
    totalCost += (aggInput / 1_000_000) * promptPrice + (aggOutput / 1_000_000) * completionPrice;
    totalTokens += aggInput + aggOutput;
  }

  return { cost: Math.round(totalCost * 10000) / 10000, tokens: totalTokens };
}

/** Find a model in a list by id. */
export function findModel(models: ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((m) => m.id === id);
}
