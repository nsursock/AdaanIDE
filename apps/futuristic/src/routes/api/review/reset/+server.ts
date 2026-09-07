import { json } from "@sveltejs/kit";
import { reviewStore, cancelAllRuns } from "@adaan/core/server";

/** POST /api/review/reset — selectively wipe monitoring data.
 *  Body: { configs?: boolean; results?: boolean; taskLists?: boolean }
 *  At least one flag must be true. Also cancels any in-flight runs. */
export async function POST({ request }) {
  await reviewStore.load();
  const body = (await request.json().catch(() => ({}))) as {
    configs?: boolean;
    results?: boolean;
    taskLists?: boolean;
  };

  if (!body.configs && !body.results && !body.taskLists) {
    return json({ error: "at least one of configs, results, or taskLists must be true" }, { status: 400 });
  }

  // Cancel any active runs before wiping — otherwise a running review would
  // write results back into a freshly cleared store.
  cancelAllRuns();

  await reviewStore.resetAll({
    configs: !!body.configs,
    results: !!body.results,
    taskLists: !!body.taskLists,
  });

  return json({ ok: true });
}
