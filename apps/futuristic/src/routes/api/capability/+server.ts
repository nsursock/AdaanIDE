import { json } from "@sveltejs/kit";
import {
  benchmarkRunner,
  buildCapabilityMatrix,
  telemetryStore,
  computeModelMatrix,
} from "@adaan/core/server";

/** GET /api/capability
 *
 * Returns two matrices:
 * - `matrix`: the legacy benchmark + organic merge (CapabilityMatrix shape,
 *   used by the existing dashboard).
 * - `organic`: the Phase 6 organic Model×Category matrix with N per cell
 *   and `lowConfidence` flags (from computeModelMatrix).
 *
 * Bug fix: previously read `_data().tasks` which doesn't exist on
 * TelemetryData (only `recentTasks`), so the organic matrix was always
 * empty. Now reads `recentTasks` correctly. */
export async function GET() {
  try {
    await telemetryStore.load();
    const results = await benchmarkRunner.loadResults();
    const data = (telemetryStore as any)._data();
    const rollups = data?.rollups ?? {};

    // FIX: read recentTasks (not the nonexistent `tasks` field).
    const taskRecords = (data?.recentTasks ?? []).map((t: any) => ({
      prompt: t.prompt ?? "",
      model: t.model ?? "",
      status: t.status ?? "",
      category: t.category ?? null,
    }));

    const matrix = buildCapabilityMatrix(results, rollups, taskRecords);

    // Phase 6: organic matrix with N first-class + lowConfidence.
    const organic = computeModelMatrix(data?.recentTasks ?? []);

    return json({ matrix, organic });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to build capability matrix" },
      { status: 500 },
    );
  }
}
