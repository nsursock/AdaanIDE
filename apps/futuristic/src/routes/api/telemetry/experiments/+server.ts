import { json } from "@sveltejs/kit";
import { telemetryStore } from "@adaan/core/server";

/** GET /api/telemetry/experiments
 *
 * Groups task records by experiment name + arm, computing side-by-side
 * metrics for A/B comparison. Returns one entry per experiment name,
 * each containing an array of arms with their metrics + N. */
export async function GET() {
  try {
    await telemetryStore.load();
    const data = (telemetryStore as any)._data();
    const tasks = (data.recentTasks ?? []).filter((t: any) => t.experiment);

    // Group by experiment name → arm → task list.
    const byName = new Map<string, Map<string, any[]>>();
    for (const t of tasks) {
      const exp = t.experiment;
      const arms = byName.get(exp.name) ?? new Map();
      const list = arms.get(exp.arm) ?? [];
      list.push(t);
      arms.set(exp.arm, list);
      byName.set(exp.name, arms);
    }

    const experiments: Array<{
      name: string;
      arms: Array<{
        arm: string;
        n: number;
        successes: number;
        successRate: number;
        avgReqs: number;
        avgTokens: number;
        avgLatencyMs: number;
        avgCost: number;
      }>;
    }> = [];

    for (const [name, arms] of byName) {
      const armList = [];
      for (const [arm, ts] of arms) {
        const n = ts.length;
        const successes = ts.filter((t) => t.status === "success").length;
        const totalReqs = ts.reduce((s, t) => s + t.requestCount, 0);
        const totalTokens = ts.reduce((s, t) => s + t.inputTokens + t.outputTokens, 0);
        const totalLatency = ts.reduce((s, t) => s + t.durationMs, 0);
        const totalCost = ts.reduce((s, t) => s + t.cost, 0);
        armList.push({
          arm,
          n,
          successes,
          successRate: n > 0 ? successes / n : 0,
          avgReqs: n > 0 ? totalReqs / n : 0,
          avgTokens: n > 0 ? totalTokens / n : 0,
          avgLatencyMs: n > 0 ? totalLatency / n : 0,
          avgCost: n > 0 ? totalCost / n : 0,
        });
      }
      armList.sort((a, b) => a.arm.localeCompare(b.arm));
      experiments.push({ name, arms: armList });
    }

    experiments.sort((a, b) => a.name.localeCompare(b.name));
    return json({ experiments });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to compute experiments" },
      { status: 500 },
    );
  }
}
