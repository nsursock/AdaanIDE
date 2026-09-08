import { json } from "@sveltejs/kit";
import {
  getProvider,
  fetchModelPopularity,
} from "@adaan/core/server";
import { OpenRouterProvider } from "@adaan/core/server";

/** GET /api/review/popularity — fetch model popularity from the OpenRouter
 *  public rankings-daily dataset. Returns a map of model permaslug → total
 *  tokens over the last 7 days. Used to sort paid models by popularity in
 *  the model picker so users know which models are worth the dollar.
 *
 *  Only works with the real OpenRouter endpoint (not local/custom servers).
 *  Uses a regular API key — no management key required. */
export async function GET() {
  let provider;
  try {
    provider = getProvider();
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Provider not initialized" }, { status: 500 });
  }

  if (!(provider instanceof OpenRouterProvider) || provider.hasCustomBaseUrl()) {
    return json({ error: "Popularity data is only available on the OpenRouter endpoint" }, { status: 400 });
  }

  const apiKey = provider.getApiKey();
  if (!apiKey || apiKey === "not-needed") {
    return json({ error: "API key required to fetch popularity data" }, { status: 400 });
  }

  const popularity = await fetchModelPopularity(apiKey, provider.getBaseUrl(), 7);

  // Convert Map to a sorted array for the client.
  const entries = [...popularity.entries()]
    .map(([permaslug, tokens]) => ({ permaslug, tokens }))
    .sort((a, b) => b.tokens - a.tokens);

  return json({ models: entries });
}
