import { json, type RequestHandler } from "@sveltejs/kit";
import { stopServer, setLocalEndpoint } from "@adaan/core/server";

export const POST: RequestHandler = async ({ request }) => {
  try {
    const { providerId } = await request.json();
    if (typeof providerId !== "string") {
      return json({ error: "providerId must be a string" }, { status: 400 });
    }
    await stopServer(providerId);
    // Clear the local endpoint so all requests go back to OpenRouter
    setLocalEndpoint(null);
    return json({ ok: true });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to stop local server" },
      { status: 500 },
    );
  }
};
