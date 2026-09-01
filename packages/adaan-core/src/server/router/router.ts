import type { ModelRegistry, RegistryEntry } from "../registry/index.js";
import type { ModelTier } from "../registry/types.js";
import { classifyTask, type TaskClassification, type TaskCategory } from "./classifier.js";

export interface RouterSettings {
  mode: "auto" | "manual";
  /** Minimum empirical task success rate to trust a model (default 0.6). */
  successThreshold: number;
  /** Which tiers are allowed for routing. */
  allowedTiers: ModelTier[];
}

export const DEFAULT_ROUTER_SETTINGS: RouterSettings = {
  mode: "manual", // off by default until measured
  successThreshold: 0.6,
  allowedTiers: ["free", "mid", "frontier"],
};

export interface RouteResult {
  model: string;
  reason: string;
  category: TaskCategory;
  classification: TaskClassification;
}

/**
 * Pick the cheapest model likely to succeed for a given task classification.
 * 100% local — zero LLM calls.
 *
 * Routing rule:
 * 1. Within allowed tiers, filter to tools-capable models (if the task needs
 *    tools, i.e. coding/toolUse > 0.2).
 * 2. Among those, prefer models with empirical.taskSuccessRate >= threshold.
 * 3. At equal confidence, prefer free tier (cost is $0, requests are the
 *    constraint).
 * 4. If no model has empirical data, fall back to "any free tools-capable
 *    model with lowest error rate" (or just the LRU free pool).
 *
 * Returns null in manual mode (keep the user's pick).
 */
export function routeModel(
  cls: TaskClassification,
  registry: ModelRegistry,
  settings: RouterSettings,
): RouteResult | null {
  if (settings.mode === "manual") return null;

  const all = registry.all();
  if (all.length === 0) return null;

  const needsTools = cls.coding > 0.2 || cls.toolUse > 0.2;

  // Filter by allowed tiers + tools capability.
  let candidates = all.filter(
    (e) => settings.allowedTiers.includes(e.tier) && (!needsTools || e.toolsCapable),
  );
  if (candidates.length === 0) {
    // Fallback: drop the tools requirement.
    candidates = all.filter((e) => settings.allowedTiers.includes(e.tier));
  }
  if (candidates.length === 0) return null;

  // Sort by tier preference (free first, then mid, then frontier).
  const tierOrder: Record<ModelTier, number> = { free: 0, mid: 1, frontier: 2 };
  candidates.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

  // Among candidates with empirical data meeting the threshold, pick the
  // cheapest tier with the best success rate.
  const confident = candidates.filter(
    (e) => e.empirical && e.empirical.taskSuccessRate >= settings.successThreshold,
  );

  if (confident.length > 0) {
    // Pick the best in the cheapest tier.
    const cheapestTier = confident[0].tier;
    const inCheapestTier = confident.filter((e) => e.tier === cheapestTier);
    inCheapestTier.sort((a, b) => (b.empirical!.taskSuccessRate) - (a.empirical!.taskSuccessRate));
    const best = inCheapestTier[0];
    return {
      model: best.id,
      reason: `empirical success ${(best.empirical!.taskSuccessRate * 100).toFixed(0)}% on ${best.tier} tier`,
      category: cls.category,
      classification: cls,
    };
  }

  // No empirical data — fall back to cheapest free tools-capable model.
  const free = candidates.filter((e) => e.free && (!needsTools || e.toolsCapable));
  if (free.length > 0) {
    // Pick the one with the lowest error rate (or first if no data).
    free.sort((a, b) => {
      const aErr = a.empirical?.errorRate ?? 1;
      const bErr = b.empirical?.errorRate ?? 1;
      return aErr - bErr;
    });
    return {
      model: free[0].id,
      reason: "no empirical data — cheapest free model",
      category: cls.category,
      classification: cls,
    };
  }

  // No free models — pick the cheapest tier available.
  return {
    model: candidates[0].id,
    reason: `fallback to ${candidates[0].tier} tier`,
    category: cls.category,
    classification: cls,
  };
}

export { classifyTask, type TaskClassification, type TaskCategory } from "./classifier.js";
