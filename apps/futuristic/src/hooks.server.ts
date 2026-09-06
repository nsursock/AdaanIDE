import type { Handle } from "@sveltejs/kit";
import {
  initProvider,
  initReviewScheduler,
  getReviewScheduler,
  getProvider,
  getWorkspace,
  getActiveWorkspaceRoot,
} from "@adaan/core/server";
import { env } from "$env/dynamic/private";

let initialized = false;

function ensureInit() {
  if (!initialized) {
    initProvider(env.OPENROUTER_API_KEY || "", env.OPENROUTER_BASE_URL || undefined);
    // Start the review scheduler. It only actually triggers runs when
    // enabled=true (persisted in the review store, toggled via
    // POST /api/review/scheduler from the UI) and an enabled config with a
    // positive interval is due. Configs without an explicit workspaceRoot
    // fall back to the workspace the user most recently opened.
    initReviewScheduler({
      getProvider: () => getProvider(),
      getWorkspace: (rootPath: string) => getWorkspace(rootPath),
      defaultWorkspaceRoot: () => getActiveWorkspaceRoot(),
    }).start();
    initialized = true;
  }
}

export const handle: Handle = async ({ event, resolve }) => {
  ensureInit();
  return resolve(event);
};

export { getReviewScheduler };
