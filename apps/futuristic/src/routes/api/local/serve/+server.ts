import { json, type RequestHandler } from "@sveltejs/kit";
import { ensureLocalModel, type LocalModelRef } from "@adaan/core/server";

export const POST: RequestHandler = async ({ request }) => {
  try {
    const { providerId, modelId, hfRepo, singleModel } = await request.json();
    if (typeof providerId !== "string") {
      return json({ error: "providerId must be a string" }, { status: 400 });
    }
    if (typeof modelId !== "string" || !modelId) {
      return json({ error: "modelId must be a non-empty string" }, { status: 400 });
    }

    // Ensure the server is up and serving this model (fast path when it
    // already is), then configure the provider to route requests for it to
    // the local endpoint while OpenRouter requests keep going to
    // openrouter.ai. This allows seamless switching between local and cloud
    // models. Blocks until the server is ready, so no chat request can
    // reach a dead endpoint.
    const local: LocalModelRef = {
      providerId,
      modelId,
      hfRepo: typeof hfRepo === "string" ? hfRepo : undefined,
      // singleModel defaults to true — only one local server runs at a time.
      singleModel: singleModel !== false,
    };
    const servedModel = await ensureLocalModel(local);

    // servedModel is the actual model name the server's API expects (e.g.
    // "mlx-community/Qwen3.5-4B-MLX-4bit"), which may differ from the alias
    // used to start the server (e.g. "qwen3.5-4b-4bit").
    return json({ ok: true, modelId, servedModel });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to start local server" },
      { status: 500 },
    );
  }
};
