import { json } from "@sveltejs/kit";
import { getProvider, discoverProviders } from "@adaan/core/server";

/** GET /api/review/models — returns all models grouped by tier (free/paid/local).
 *  The UI uses this to populate the model picker and aggregator selector. */
export async function GET() {
  try {
    const provider = getProvider();
    const [modelResult, localProviders] = await Promise.allSettled([
      provider.listModels(),
      discoverProviders(),
    ]);

    const { free, paid } =
      modelResult.status === "fulfilled" ? modelResult.value : { free: [], paid: [] };

    const local: { id: string; name: string; contextLength?: number; providerName?: string }[] = [];
    if (localProviders.status === "fulfilled") {
      for (const p of localProviders.value) {
        if (!p.installed) continue;
        for (const m of p.models) {
          local.push({
            id: m.id,
            name: m.name || m.id,
            contextLength: 32768,
            providerName: p.name,
          });
        }
      }
    }

    return json({
      free: free.map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.contextLength, pricing: m.pricing, paramSize: m.paramSize })),
      paid: paid.map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.contextLength, pricing: m.pricing, paramSize: m.paramSize })),
      local,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Failed to fetch models" }, { status: 500 });
  }
}
