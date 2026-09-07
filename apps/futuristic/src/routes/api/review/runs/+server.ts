import { json } from "@sveltejs/kit";
import { reviewRunManager } from "@adaan/core/server";

/** GET /api/review/runs?root= — list runs currently in flight (detached from
 *  any client), optionally filtered by workspace root. The UI calls this on
 *  load / project switch to discover and re-attach to running reviews. */
export async function GET({ url }) {
  const root = url.searchParams.get("root") ?? undefined;
  return json({ runs: reviewRunManager.activeRuns(root) });
}
