import { json } from "@sveltejs/kit";
import { fetchOpenRouterCatalog, discoverProviders } from "@adaan/core/server";
import type { LocalModelInfo, ModelGroups } from "@adaan/core";

export async function GET() {
  try {
    // Fetch the OpenRouter catalog (always from openrouter.ai, independent
    // of the active provider's endpoint) and local models in parallel.
    // If OpenRouter is unreachable (no network, no key), we still return
    // local models so a local-only setup works.
    const [orResult, localProviders] = await Promise.allSettled([
      fetchOpenRouterCatalog(),
      discoverProviders(),
    ]);

    const groups: ModelGroups =
      orResult.status === "fulfilled" && orResult.value
        ? { ...orResult.value, local: [] }
        : { free: [], paid: [], local: [] };

    // Build LocalModelInfo entries from discovered providers
    if (localProviders.status === "fulfilled") {
      for (const p of localProviders.value) {
        if (!p.installed) continue;
        for (const m of p.models) {
          // A model is "running" only if the server is up AND this is the
          // model it's actually serving. The served model name from the
          // server (e.g. "mlx-community/Qwen3.5-4B-MLX-4bit") may differ
          // from the alias (e.g. "qwen3.5-4b-4bit"). We match using:
          //   1. exact match on id, name, or hfRepo
          //   2. for Ollama (single-server), servedModel may be null —
          //      any model from a running provider is available on demand
          const servedLower = p.servedModel?.toLowerCase();
          const isRunning = Boolean(
            p.serverRunning &&
              (p.servedModel === null || // Ollama: server running, any model available
                servedLower === m.id.toLowerCase() ||
                servedLower === m.name.toLowerCase() ||
                (m.hfRepo && servedLower === m.hfRepo.toLowerCase())),
          );
          groups.local.push({
            id: m.id,
            name: m.name,
            contextLength: 32768, // local models don't report context; use a safe default
            pricing: { prompt: "0", completion: "0" },
            toolsCapable: true,
            free: true,
            providerId: p.id,
            providerName: p.name,
            endpoint: p.endpoint,
            running: isRunning,
            size: m.size,
            hfRepo: m.hfRepo,
          });
        }
      }
    }

    return json(groups);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Failed to fetch models" }, { status: 500 });
  }
}
