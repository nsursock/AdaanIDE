import { json } from "@sveltejs/kit";
import { getProvider, modelRegistry } from "@adaan/core/server";

export async function GET() {
  try {
    modelRegistry.setProvider(getProvider());
    await modelRegistry.refresh();
    return json({
      entries: modelRegistry.all(),
      refreshedAt: modelRegistry.refreshedAt,
      stale: modelRegistry.stale,
    });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to fetch model registry" },
      { status: 500 },
    );
  }
}
