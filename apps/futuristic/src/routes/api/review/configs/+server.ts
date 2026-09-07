import { json } from "@sveltejs/kit";
import {
  reviewStore,
  REVIEW_PRESETS,
  reviewId,
  type ReviewConfig,
} from "@adaan/core/server";

export async function GET({ url }) {
  await reviewStore.load();
  const root = url.searchParams.get("root") ?? undefined;
  const allConfigs = reviewStore.getConfigs();
  const configs = root
    ? allConfigs.filter((c) => c.workspaceRoot === root)
    : allConfigs;
  return json({ configs, presets: REVIEW_PRESETS });
}

export async function POST({ request }) {
  await reviewStore.load();
  const body = (await request.json()) as Partial<ReviewConfig> & { id?: string };
  if (!body?.name) return json({ error: "name required" }, { status: 400 });
  if (!Array.isArray(body.lenses) || body.lenses.length === 0)
    return json({ error: "at least one lens required" }, { status: 400 });

  const config: ReviewConfig = {
    id: body.id || reviewId("cfg-"),
    name: body.name,
    lenses: body.lenses,
    expertise: body.expertise || "top-1%",
    modelTier: body.modelTier === "paid" || body.modelTier === "all" ? body.modelTier : "free",
    reviewerModels: Array.isArray(body.reviewerModels) ? body.reviewerModels : [],
    aggregatorModel: body.aggregatorModel || "auto",
    intervalValue: typeof body.intervalValue === "number" ? body.intervalValue : 0,
    intervalUnit: body.intervalUnit === "days" || body.intervalUnit === "weeks" ? body.intervalUnit : "hours",
    targetPath: body.targetPath || undefined,
    workspaceRoot: body.workspaceRoot || undefined,
    createGitHubIssues: !!body.createGitHubIssues,
    writeTasksFile: !!body.writeTasksFile,
    enabled: !!body.enabled,
    lastRunAt: body.lastRunAt,
  };
  await reviewStore.saveConfig(config);
  return json({ config });
}

export async function DELETE({ url }) {
  await reviewStore.load();
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "id required" }, { status: 400 });
  await reviewStore.deleteConfig(id);
  return json({ ok: true });
}
