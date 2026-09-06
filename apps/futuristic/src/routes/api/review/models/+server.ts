import { json } from "@sveltejs/kit";
import { getProvider } from "@adaan/core/server";

/** GET /api/review/models — returns all models grouped by tier (free/paid).
 *  The UI uses this to populate the model picker. */
export async function GET() {
  try {
    const provider = getProvider();
    const { free, paid } = await provider.listModels();
    return json({
      free: free.map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.contextLength, pricing: m.pricing, paramSize: m.paramSize })),
      paid: paid.map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.contextLength, pricing: m.pricing, paramSize: m.paramSize })),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Failed to fetch models" }, { status: 500 });
  }
}
