import { json } from "@sveltejs/kit";
import { telemetryStore } from "@adaan/core/server";

/** Wipe all collected telemetry so the dashboard starts fresh. */
export async function POST() {
  try {
    await telemetryStore.load();
    await telemetryStore.reset();
    return json({ ok: true });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to reset telemetry" },
      { status: 500 },
    );
  }
}
