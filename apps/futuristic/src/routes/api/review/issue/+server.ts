import { json } from "@sveltejs/kit";
import {
  reviewStore,
  createGitHubIssue,
  type ReviewTask,
} from "@adaan/core/server";

/** POST /api/review/issue — create a real GitHub issue from a task.
 *  Body: { resultId: string, taskIndex: number, workspaceRoot: string }
 *  Returns { url } on success. */
export async function POST({ request }) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid body" }, { status: 400 });
  const { resultId, taskIndex, workspaceRoot } = body as {
    resultId?: string;
    taskIndex?: number;
    workspaceRoot?: string;
  };
  if (!resultId || !workspaceRoot) {
    return json({ error: "resultId and workspaceRoot required" }, { status: 400 });
  }
  await reviewStore.load();
  const result = reviewStore.getResult(resultId);
  if (!result) return json({ error: "result not found" }, { status: 404 });
  const task: ReviewTask | undefined = result.tasks[taskIndex ?? -1];
  if (!task) return json({ error: "task not found" }, { status: 404 });

  try {
    const url = await createGitHubIssue(workspaceRoot, task);
    if (url) {
      task.githubUrl = url;
      await reviewStore.updateResult(result);
    }
    return json({ url });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : "gh issue create failed" },
      { status: 500 },
    );
  }
}
