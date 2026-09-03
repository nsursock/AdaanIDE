import { json, type RequestHandler } from "@sveltejs/kit";
import { telemetryStore } from "@adaan/core/server";

/** Read the current telemetry tuning parameters. */
export const GET: RequestHandler = async () => {
  try {
    await telemetryStore.load();
    return json(telemetryStore.getConfig());
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to read telemetry config" },
      { status: 500 },
    );
  }
};

/** Update telemetry tuning parameters at runtime. */
export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { maxRecentTasks, maxRecentRequests, writeDebounceMs, trendDays } = body as Record<string, unknown>;
    const update: Record<string, unknown> = {};
    if (maxRecentTasks !== undefined) update.maxRecentTasks = maxRecentTasks;
    if (maxRecentRequests !== undefined) update.maxRecentRequests = maxRecentRequests;
    if (writeDebounceMs !== undefined) update.writeDebounceMs = writeDebounceMs;
    if (trendDays !== undefined) update.trendDays = trendDays;
    telemetryStore.configure(update);
    return json({ ok: true, config: telemetryStore.getConfig() });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to update telemetry config" },
      { status: 500 },
    );
  }
};
