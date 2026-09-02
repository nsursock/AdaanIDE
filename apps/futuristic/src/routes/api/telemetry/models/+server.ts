import { json } from "@sveltejs/kit";
import {
  telemetryStore,
  modelRegistry,
  learnedStats,
  computeModelTable,
} from "@adaan/core/server";

/** GET /api/telemetry/models
 *
 * Global per-model table merging three data sources:
 * 1. Organic telemetry (computeModelTable from recent tasks) — success rate,
 *    reqs/task, tokens/task, latency, cost, escalations, retries, fallbacks.
 * 2. Registry tier + pricing + tools capability.
 * 3. Learned model stats (Bayesian-smoothed success rate, sample count).
 *
 * Every row carries `n` and `lowConfidence` so the UI can dim under-sampled
 * models. */
export async function GET() {
  try {
    await telemetryStore.load();
    await modelRegistry.load();
    await learnedStats.load();

    const data = (telemetryStore as any)._data();
    const tasks = data.recentTasks ?? [];
    const modelRows = computeModelTable(tasks);

    // Index registry entries by model id for tier/pricing lookup.
    const registryEntries = modelRegistry.all();
    const registryById = new Map(registryEntries.map((e: any) => [e.id, e]));

    // Index learned cells by `${category}:${model}` → aggregate per model.
    const learnedData = (learnedStats as any)._data?.();
    const learnedByModel = new Map<string, { samples: number; smoothedRate: number }>();
    if (learnedData?.cells) {
      for (const cell of Object.values(learnedData.cells) as any[]) {
        const existing = learnedByModel.get(cell.model) ?? { samples: 0, smoothedRate: 0 };
        existing.samples += cell.attempts;
        learnedByModel.set(cell.model, existing);
      }
    }

    const rows = modelRows.map((r) => {
      const reg = registryById.get(r.model);
      const learned = learnedByModel.get(r.model);
      return {
        ...r,
        tier: reg?.tier ?? "free",
        free: reg?.free ?? r.model.endsWith(":free"),
        pricing: reg?.pricing ?? null,
        toolsCapable: reg?.toolsCapable ?? true,
        reasoning: reg?.reasoning ?? false,
        contextLength: reg?.contextLength ?? null,
        learnedSamples: learned?.samples ?? 0,
      };
    });

    return json({ models: rows });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to compute model table" },
      { status: 500 },
    );
  }
}
