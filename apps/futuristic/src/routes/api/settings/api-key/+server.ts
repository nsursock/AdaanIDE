import { json, type RequestHandler } from "@sveltejs/kit";
import { updateProviderKey } from "@adaan/core/server";

export const POST: RequestHandler = async ({ request }) => {
  try {
    const { apiKey } = await request.json();
    if (typeof apiKey !== "string") {
      return json({ error: "apiKey must be a string" }, { status: 400 });
    }
    updateProviderKey(apiKey);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Failed to update API key" }, { status: 500 });
  }
};
