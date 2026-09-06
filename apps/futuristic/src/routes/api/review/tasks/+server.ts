import { json } from "@sveltejs/kit";
import { reviewStore } from "@adaan/core/server";

/**
 * POST /api/review/tasks — toggle a task's resolved state.
 * Body: { configId: string, fingerprint: string, resolved: boolean }
 *
 * Updates the living task list (source of truth) and mirrors the change into
 * the config's latest result so the currently displayed view stays in sync.
 * User-resolved tasks are sticky: they stay resolved even if later runs
 * re-flag the same finding.
 */
export async function POST({ request }) {
  const body = await request.json().catch(() => null);
  const configId = typeof body?.configId === "string" ? body.configId : "";
  const fingerprint = typeof body?.fingerprint === "string" ? body.fingerprint : "";
  const resolved = !!body?.resolved;
  if (!configId || !fingerprint) {
    return json({ error: "configId and fingerprint required" }, { status: 400 });
  }

  await reviewStore.load();
  const list = reviewStore.getTaskList(configId);
  const task = list?.tasks.find((t) => t.fingerprint === fingerprint);
  if (!list || !task) return json({ error: "task not found" }, { status: 404 });

  task.resolved = resolved;
  task.resolvedBy = resolved ? "user" : undefined;
  list.updatedAt = new Date().toISOString();
  // Re-sort: open first, resolved last (same ordering the runner produces).
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
  list.tasks.sort((a, b) =>
    (a.resolved ? 1 : 0) - (b.resolved ? 1 : 0) || order[a.priority] - order[b.priority],
  );
  await reviewStore.saveTaskList(list);

  const latest = reviewStore.getLatestResultForConfig(configId);
  if (latest) {
    const rt = latest.tasks.find((t) => t.fingerprint === fingerprint);
    if (rt) {
      rt.resolved = resolved;
      rt.resolvedBy = resolved ? "user" : undefined;
      latest.tasks.sort((a, b) =>
        (a.resolved ? 1 : 0) - (b.resolved ? 1 : 0) || order[a.priority] - order[b.priority],
      );
      await reviewStore.updateResult(latest);
    }
  }
  return json({ task });
}
