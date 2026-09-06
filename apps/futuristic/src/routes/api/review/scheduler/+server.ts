import { json } from "@sveltejs/kit";
import { getReviewScheduler } from "@adaan/core/server";

/** GET /api/review/scheduler — scheduler status. */
export async function GET() {
  const sched = getReviewScheduler();
  return json({ enabled: sched?.enabled ?? false, running: sched ? true : false });
}

/** POST /api/review/scheduler — enable/disable the periodic review scheduler.
 *  Body: { enabled: boolean } */
export async function POST({ request }) {
  const sched = getReviewScheduler();
  if (!sched) return json({ error: "scheduler not initialized" }, { status: 500 });
  const body = await request.json().catch(() => null);
  const enabled = !!body?.enabled;
  sched.setEnabled(enabled);
  return json({ enabled });
}
