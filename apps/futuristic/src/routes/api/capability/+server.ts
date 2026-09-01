import { json } from "@sveltejs/kit";
import { benchmarkRunner, buildCapabilityMatrix, telemetryStore } from "@adaan/core/server";

export async function GET() {
  try {
    await telemetryStore.load();
    const results = await benchmarkRunner.loadResults();
    const rollups = (telemetryStore as any)._data?.()?.rollups ?? {};
    const tasks = (telemetryStore as any)._data?.()?.tasks ?? [];
    const taskRecords = tasks.map((t: any) => ({
      prompt: t.prompt ?? "",
      model: t.model ?? "",
      status: t.status ?? "",
      category: t.category ?? null,
    }));
    const matrix = buildCapabilityMatrix(results, rollups, taskRecords);
    return json({ matrix });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to build capability matrix" },
      { status: 500 },
    );
  }
}
