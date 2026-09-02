import { json, type RequestHandler } from "@sveltejs/kit";
import { discoverProviders, getServerStatus } from "@adaan/core/server";

export const GET: RequestHandler = async () => {
  try {
    const providers = await discoverProviders();
    // Merge in managed-server status (which model is being served)
    const status = getServerStatus();
    for (const p of providers) {
      const s = status[p.id];
      if (s) {
        p.servedModel = s.modelId;
      }
    }
    return json({ providers });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to discover local providers" },
      { status: 500 },
    );
  }
};
