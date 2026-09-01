import { json } from "@sveltejs/kit";
import { telemetryStore } from "@adaan/core/server";

export async function GET() {
  try {
    await telemetryStore.load();
    const summary = telemetryStore.getSummary();
    return json(summary);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Failed to load telemetry" }, { status: 500 });
  }
}
