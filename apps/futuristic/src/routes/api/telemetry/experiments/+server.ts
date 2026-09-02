import { json } from "@sveltejs/kit";
import { telemetryStore } from "@adaan/core/server";

/** Outcome weights — mirrors OUTCOME_WEIGHTS from the core package.
 *  Used to compute an outcome-weighted success rate that's more honest
 *  than the binary status-based one. A task that ended "silent" (no tests
 *  run, no feedback) scores 0.7, not 1.0. */
const OUTCOME_WEIGHTS: Record<string, number> = {
  verified: 1.0,
  accepted: 1.0,
  silent: 0.7,
  corrected: 0.2,
  rejected: 0.0,
  rolled_back: 0.1,
};

/** GET /api/telemetry/experiments
 *
 * Groups task records by experiment name + arm, computing side-by-side
 * metrics for A/B comparison. Returns one entry per experiment name,
 * each containing an array of arms with their metrics + N.
 *
 * D12: successRate now uses outcome-weighted scoring — a task with
 * status "success" but outcome "silent" (no tests run) scores 0.7, not
 * 1.0. A task with status "error" scores 0. This prevents the "model
 * wrote a summary explaining why it failed" failure mode from scoring
 * as 100% success. */
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
        weightedSuccessRate: number;
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
        // Binary success (status-based) — kept for backwards compat.
        const successes = ts.filter((t) => t.status === "success").length;
        // D12: outcome-weighted success rate — more honest than binary.
        // A "silent" task (no tests, no feedback) scores 0.7, not 1.0.
        // An "error" task with outcome "rejected" scores 0.0.
        const weightedScore = ts.reduce((s, t) => {
          if (t.status !== "success") return s;
          const w = OUTCOME_WEIGHTS[t.outcome] ?? 0.7;
          return s + w;
        }, 0);
        const totalReqs = ts.reduce((s, t) => s + t.requestCount, 0);
        const totalTokens = ts.reduce((s, t) => s + t.inputTokens + t.outputTokens, 0);
        const totalLatency = ts.reduce((s, t) => s + t.durationMs, 0);
        const totalCost = ts.reduce((s, t) => s + t.cost, 0);
        armList.push({
          arm,
          n,
          successes,
          successRate: n > 0 ? successes / n : 0,
          weightedSuccessRate: n > 0 ? weightedScore / n : 0,
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
