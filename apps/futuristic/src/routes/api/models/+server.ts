import { json } from "@sveltejs/kit";
import { getProvider } from "@adaan/core/server";

export async function GET() {
  try {
    const provider = getProvider();
    const groups = await provider.listModels();
    return json(groups);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Failed to fetch models" }, { status: 500 });
  }
}
