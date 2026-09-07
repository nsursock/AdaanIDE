import { json } from "@sveltejs/kit";
import { telemetryStore } from "@adaan/core/server";

export async function GET({ url }) {
  try {
    await telemetryStore.load();
    const root = url.searchParams.get("root") ?? undefined;
    const summary = root
      ? telemetryStore.getSummaryForWorkspace(root)
      : telemetryStore.getSummary();
    return json(summary);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Failed to load telemetry" }, { status: 500 });
  }
}
