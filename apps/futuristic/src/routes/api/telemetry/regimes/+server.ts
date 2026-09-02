import { json } from "@sveltejs/kit";
import {
  telemetryStore,
  computeRegimeMetrics,
  type Regime,
} from "@adaan/core/server";

/** GET /api/telemetry/regimes?days=7
 *
 * Returns the three regime views (paid / free / local) of the unified
 * telemetry data model, computed over the last `days` days of task records.
 * Quota consumed is sourced from today's uncapped rollup, not from the
 * capped `recentRequests` ring. */
export async function GET({ url }) {
  try {
    await telemetryStore.load();
    const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days") ?? "7") || 7));
    const data = (telemetryStore as any)._data();

    // Filter tasks to the requested window.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const tasks = (data.recentTasks ?? []).filter((t: any) => t.day >= cutoffStr);
    const taskIds = new Set(tasks.map((t: any) => t.taskId));
    const requests = (data.recentRequests ?? []).filter((r: any) => taskIds.has(r.taskId));

    // Today's uncapped request count for the free-regime quota.
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayRollup = data.rollups?.[todayStr];
    const quotaConsumedToday = todayRollup?.requests ?? 0;

    const regimes: Regime[] = ["paid", "free", "local"];
    const result: Record<string, any> = {};
    for (const regime of regimes) {
      result[regime] = computeRegimeMetrics(tasks, requests, regime, {
        quotaDailyLimit: 1000, // TODO: read from settings when wired
        quotaConsumedToday: regime === "free" ? quotaConsumedToday : undefined,
      });
    }

    return json({
      days,
      paid: result.paid,
      free: result.free,
      local: result.local,
    });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to compute regime metrics" },
      { status: 500 },
    );
  }
}
