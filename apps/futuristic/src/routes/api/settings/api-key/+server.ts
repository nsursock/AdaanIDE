import { json, type RequestHandler } from "@sveltejs/kit";
import { updateProviderKey, updateProviderBaseUrl } from "@adaan/core/server";

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { apiKey, baseUrl } = body as { apiKey?: unknown; baseUrl?: unknown };
    if (typeof apiKey !== "string") {
      return json({ error: "apiKey must be a string" }, { status: 400 });
    }
    if (baseUrl !== undefined && typeof baseUrl !== "string") {
      return json({ error: "baseUrl must be a string" }, { status: 400 });
    }
    // Apply the base URL first so the key update (which recreates the
    // provider) picks up the new endpoint in the same request.
    if (typeof baseUrl === "string") {
      updateProviderBaseUrl(baseUrl);
    }
    updateProviderKey(apiKey);
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Failed to update API key" }, { status: 500 });
  }
};
