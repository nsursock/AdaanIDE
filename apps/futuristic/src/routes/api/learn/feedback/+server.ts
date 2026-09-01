import { json } from "@sveltejs/kit";
import { telemetryStore } from "@adaan/core/server";

/**
 * Phase 4: Receive explicit feedback (accept/reject) from the editor's
 * diff-review buttons. Relabels the task's outcome.
 */
export async function POST({ request }) {
  try {
    const { taskId, verdict } = await request.json();

    if (!taskId || (verdict !== "accepted" && verdict !== "rejected")) {
      return json({ error: "taskId and verdict (accepted|rejected) required" }, { status: 400 });
    }

    await telemetryStore.load();
    const rec = telemetryStore.relabelOutcome(taskId, verdict);
    if (!rec) {
      return json({ error: "Task not found" }, { status: 404 });
    }

    return json({ ok: true, outcome: rec.outcome });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to record feedback" },
      { status: 500 },
    );
  }
}
