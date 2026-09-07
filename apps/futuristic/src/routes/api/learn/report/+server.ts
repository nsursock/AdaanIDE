import { json } from "@sveltejs/kit";
import { telemetryStore, learnedStats, buildReport } from "@adaan/core/server";

/**
 * Phase 4: Weekly self-report — the audit trail proving the learning works.
 */
export async function GET({ url }) {
  try {
    await telemetryStore.load();
    await learnedStats.load();
    const root = url.searchParams.get("root") ?? undefined;
    const rollups = (telemetryStore as any)._data?.()?.rollups ?? {};
    const allTasks = (telemetryStore as any)._data?.()?.recentTasks ?? [];
    const tasks = root
      ? allTasks.filter((t: any) => t.workspaceRoot === root)
      : allTasks;
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
