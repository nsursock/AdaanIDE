import type { Handle } from "@sveltejs/kit";
import { initProvider } from "@adaan/core/server";
import { env } from "$env/dynamic/private";

let initialized = false;

function ensureInit() {
  if (!initialized) {
    initProvider(env.OPENROUTER_API_KEY || "", env.OPENROUTER_BASE_URL || undefined);
    initialized = true;
  }
}

export const handle: Handle = async ({ event, resolve }) => {
  ensureInit();
  return resolve(event);
};
