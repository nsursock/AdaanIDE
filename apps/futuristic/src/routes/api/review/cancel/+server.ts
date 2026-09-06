import { json } from "@sveltejs/kit";
import { cancelAllRuns, getActiveRunIds } from "@adaan/core/server";

/** POST /api/review/cancel — cancel all active review runs (manual + scheduled).
 *  Returns the number of runs that were cancelled. */
export async function POST() {
  const activeIds = getActiveRunIds();
  const cancelled = cancelAllRuns();
  return json({ cancelled, activeRuns: activeIds });
}
