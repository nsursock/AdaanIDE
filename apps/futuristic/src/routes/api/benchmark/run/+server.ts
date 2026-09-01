import { json } from "@sveltejs/kit";
import { getEngine, getProvider, benchmarkRunner } from "@adaan/core/server";

export async function POST({ request }) {
  try {
    const { models, tasks } = await request.json();

    const budget = await benchmarkRunner.checkBudget();
    if (!budget.ok) {
      return json({ error: budget.reason }, { status: 429 });
    }

    const engine = getEngine();
    const stream = benchmarkRunner.run({
      models,
      tasks,
      provider: getProvider(),
      engine,
      registry: (engine as any).registry,
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const progress of stream) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(progress)}\n\n`));
          }
        } catch (e) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n\n`));
        }
        controller.close();
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to run benchmark" },
      { status: 500 },
    );
  }
}
