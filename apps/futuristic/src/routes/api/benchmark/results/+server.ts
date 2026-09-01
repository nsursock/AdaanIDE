import { json } from "@sveltejs/kit";
import { benchmarkRunner } from "@adaan/core/server";

export async function GET() {
  try {
    const results = await benchmarkRunner.loadResults();
    return json({ results });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "Failed to load benchmark results" },
      { status: 500 },
    );
  }
}
