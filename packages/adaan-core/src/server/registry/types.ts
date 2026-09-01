import type { ModelInfo } from "../../types.js";
import type { DailyRollup, ModelDailyStats } from "../telemetry/types.js";

export type ModelTier = "free" | "mid" | "frontier";

export interface RegistryEntry {
  id: string;
  name: string;
  free: boolean;
  pricing: { prompt: string; completion: string };
  contextLength: number;
  toolsCapable: boolean;
  modalities: string[];
  reasoning: boolean;
  /** Empirical stats merged from telemetry rollups. null when no data. */
  empirical: {
    requests: number;
    errors: number;
    errorRate: number;
    avgLatencyMs: number;
    tasks: number;
    taskSuccessRate: number;
    avgInputTokens: number;
    lastUsed: string;
  } | null;
  tier: ModelTier;
}

export interface RegistryData {
  version: 1;
  entries: RegistryEntry[];
  refreshedAt: number;
}

/**
 * Merge catalog model info with empirical per-model stats from telemetry
 * rollups. Pure function — trivially testable.
 */
export function mergeEmpirical(
  entries: Omit<RegistryEntry, "empirical" | "tier">[],
  rollups: Record<string, DailyRollup>,
): RegistryEntry[] {
  // Aggregate per-model stats across all days.
  const perModel: Record<string, {
    requests: number; errors: number; totalLatencyMs: number;
    tasks: number; taskSuccesses: number; inputTokens: number;
    lastUsed: string;
  }> = {};

  for (const rollup of Object.values(rollups)) {
    for (const [modelId, ms] of Object.entries(rollup.perModel)) {
      const agg = perModel[modelId] ?? {
        requests: 0, errors: 0, totalLatencyMs: 0,
        tasks: 0, taskSuccesses: 0, inputTokens: 0, lastUsed: "",
      };
      agg.requests += ms.requests;
      agg.errors += ms.errors;
      agg.totalLatencyMs += ms.totalLatencyMs;
      agg.tasks += ms.tasks;
      agg.taskSuccesses += ms.taskSuccesses;
      agg.inputTokens += ms.inputTokens;
      if (rollup.day > agg.lastUsed) agg.lastUsed = rollup.day;
      perModel[modelId] = agg;
    }
  }

  return entries.map((e) => {
    const emp = perModel[e.id];
    return {
      ...e,
      tier: e.free ? "free" : "mid", // tier refined later by assignTiers
      empirical: emp
        ? {
            requests: emp.requests,
            errors: emp.errors,
            errorRate: emp.requests > 0 ? emp.errors / emp.requests : 0,
            avgLatencyMs: emp.requests > 0 ? emp.totalLatencyMs / emp.requests : 0,
            tasks: emp.tasks,
            taskSuccessRate: emp.tasks > 0 ? emp.taskSuccesses / emp.tasks : 0,
            avgInputTokens: emp.requests > 0 ? emp.inputTokens / emp.requests : 0,
            lastUsed: emp.lastUsed,
          }
        : null,
    };
  });
}

/**
 * Assign tiers to registry entries. Free models → "free". Paid models are
 * split by blended price: bottom third → "mid", rest → "frontier".
 */
export function assignTiers(
  entries: RegistryEntry[],
  opts?: { midThreshold?: number },
): RegistryEntry[] {
  const midThreshold = opts?.midThreshold ?? 0.33;
  const paid = entries.filter((e) => !e.free);
  // Compute blended price per 1K tokens (prompt + completion).
  const blended = paid.map((e) => ({
    id: e.id,
    price: (parseFloat(e.pricing.prompt) + parseFloat(e.pricing.completion)) / 2,
  }));
  if (blended.length === 0) {
    return entries.map((e) => ({ ...e, tier: "free" as const }));
  }
  const sorted = blended.sort((a, b) => a.price - b.price);
  const midCutoffIdx = Math.floor(sorted.length * midThreshold);
  const midCutoffPrice = sorted[midCutoffIdx]?.price ?? Infinity;

  return entries.map((e) => {
    if (e.free) return { ...e, tier: "free" as const };
    const b = blended.find((x) => x.id === e.id);
    const tier: ModelTier = b && b.price <= midCutoffPrice ? "mid" : "frontier";
    return { ...e, tier };
  });
}
