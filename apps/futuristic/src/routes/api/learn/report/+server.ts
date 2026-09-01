import { json } from "@sveltejs/kit";
import { telemetryStore, learnedStats, buildReport } from "@adaan/core/server";

/**
 * Phase 4: Weekly self-report — the audit trail proving the learning works.
 */
export async function GET() {
  try {
    await telemetryStore.load();
    await learnedStats.load();
    const rollups = (telemetryStore as any)._data?.()?.rollups ?? {};
    const tasks = (telemetryStore as any)._data?.()?.recentTasks ?? [];
    const currentDay = new Date().toISOString().slice(0, 10);
    const report = buildReport(rollups, learnedStats, tasks, currentDay);
    return json(report);
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to build report" },
      { status: 500 },
    );
  }
}
