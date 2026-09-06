import { json } from "@sveltejs/kit";
import { reviewStore, backfillTaskFields, lensCode, lensShortCode } from "@adaan/core/server";

/** Map a model id to a friendly display name. */
function friendlyModelName(id: string): string {
  const base = id.includes("/") ? id.split("/").pop()! : id;
  const clean = base.replace(/:free$/i, "");
  if (/gpt|openai/i.test(clean)) return "ChatGPT";
  if (/claude|anthropic/i.test(clean)) return "Claude";
  if (/gemini|google/i.test(clean)) return "Gemini";
  if (/llama|meta/i.test(clean)) return "Llama";
  if (/deepseek/i.test(clean)) return "DeepSeek";
  if (/qwen/i.test(clean)) return "Qwen";
  if (/mistral/i.test(clean)) return "Mistral";
  if (/gemma/i.test(clean)) return "Gemma";
  if (/glm/i.test(clean)) return "GLM";
  if (/auto/i.test(clean)) return "Auto";
  return clean.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Resolve lens entries that are L-codes (L1, L2, ...) or raw ids to
 *  human-readable labels using the config's lens ordering. Also normalizes
 *  short codes and full labels to short codes. */
function resolveLenses(lenses: string[], configLenses: { id: string; label: string; code?: string }[]): string[] {
  // Build L-code → short code map (L1 = first lens, L2 = second, etc.)
  const lCodeMap = new Map<string, string>();
  const idMap = new Map<string, string>();
  const labelMap = new Map<string, string>();
  for (let i = 0; i < configLenses.length; i++) {
    const l = configLenses[i];
    const code = lensCode(l);
    lCodeMap.set(`L${i + 1}`, code);
    lCodeMap.set(`l${i + 1}`, code);
    idMap.set(l.id, code);
    labelMap.set(l.label.toLowerCase(), code);
    labelMap.set(l.label, code);
  }

  return lenses.map((lens) => {
    // Already a short code? Keep it.
    if (/^[A-Z]{3,5}$/.test(lens)) return lens;
    // L-code? Map to short code.
    if (lCodeMap.has(lens)) return lCodeMap.get(lens)!;
    // Lens id? Map to short code.
    if (idMap.has(lens)) return idMap.get(lens)!;
    // Full label? Map to short code.
    if (labelMap.has(lens)) return labelMap.get(lens)!;
    if (labelMap.has(lens.toLowerCase())) return labelMap.get(lens.toLowerCase())!;
    // Label fragment ("Evaluation")? Fuzzy-match a lens label → its code.
    const up = fuzzyKey(lens);
    if (up.length >= 4) {
      const hit = configLenses.find((l) => fuzzyKey(l.label).includes(up) || wordsWithinLabel(lens, l.label));
      if (hit) return lensCode(hit);
    }
    // Unknown — derive a short code from it.
    if (/^L\d+$/i.test(lens)) return lens.toUpperCase(); // can't resolve, keep L-code
    return lensShortCode(lens);
  });
}

/** Letters-only uppercase key for fuzzy lens matching (drops emoji/spaces). */
function fuzzyKey(s: string): string {
  return s.replace(/[^a-zA-Z]/g, "").toUpperCase();
}

/** All significant words of `entry` appear in `label`
 *  ("Evaluation Specialist" ⊂ "Evaluation & Metrics Specialist"). */
function wordsWithinLabel(entry: string, label: string): boolean {
  const words = entry.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
  if (words.length === 0) return false;
  const low = label.toLowerCase();
  return words.every((w) => low.includes(w));
}

/** True when a "reviewer" entry is actually a lens — judges sometimes
 *  confuse the two dimensions and put lens names in the reviewers array. */
function isLensLike(entry: string, configLenses: { id: string; label: string; code?: string }[]): boolean {
  const t = entry.trim();
  if (!t) return true;
  const low = t.toLowerCase();
  const up = fuzzyKey(t);
  for (const l of configLenses) {
    if (low === l.id.toLowerCase() || low === l.label.toLowerCase() || low === lensCode(l).toLowerCase()) return true;
    if (up.length >= 4 && fuzzyKey(l.label).includes(up)) return true;
    if (wordsWithinLabel(t, l.label)) return true;
  }
  return false;
}

/** Resolve reviewer entries that are "Committee Reviewer" or raw model ids
 *  to friendly names using the result's reviewerModels. Lens names that the
 *  judge mistakenly put here are dropped (falling back to the run's models). */
function resolveReviewers(
  reviewers: string[],
  reviewerModels: string[],
  configLenses: { id: string; label: string; code?: string }[] = [],
): string[] {
  const friendlyNames = reviewerModels.map(friendlyModelName);
  const cleaned = reviewers.filter((r) => r && r !== "—" && !isLensLike(r, configLenses));
  const hasGeneric = cleaned.some((r) => /committee/i.test(r));
  const hasReal = cleaned.some((r) => !/committee/i.test(r));

  if ((cleaned.length === 0 || (hasGeneric && !hasReal)) && friendlyNames.length > 0) {
    // Nothing usable (all generic or all lens-confused) — use the run's models.
    return friendlyNames;
  }
  if (hasGeneric && hasReal) {
    // Mix of generic and real — replace only generic ones with remaining models.
    const used = new Set(cleaned.filter((r) => !/committee/i.test(r)).map((r) => r.toLowerCase()));
    const remaining = friendlyNames.filter((n) => !used.has(n.toLowerCase()));
    let remIdx = 0;
    return cleaned.map((r) => {
      if (/committee/i.test(r)) {
        return remaining[remIdx++] ?? r;
      }
      return r;
    });
  }
  // No generic — just resolve any raw model ids to friendly names.
  return cleaned.map((r) => {
    if (r.includes("/") || /:free$/i.test(r)) return friendlyModelName(r);
    return r;
  });
}

/** GET /api/review/tasks/all — returns all tasks across all configs,
 *  consolidated into a single list. L-codes and "Committee Reviewer" are
 *  resolved to short codes and friendly names respectively. */
export async function GET() {
  await reviewStore.load();
  const configs = reviewStore.getConfigs();
  const allResults = reviewStore.getResults();

  const allTasks: Array<{
    configId: string;
    configName: string;
    reviewId: string;
    reviewDate: string;
    /** Raw reviewer model ids of the run — lets the UI map friendly names
     *  back to full model names for popovers. */
    reviewerModels: string[];
    priority: string;
    issue: string;
    mainFinding: string;
    fix: string;
    lenses: string[];
    reviewers: string[];
    impact: string;
    issueBody: string;
    labels: string[];
    githubUrl?: string;
    resolved?: boolean;
    resolvedBy?: string;
    fingerprint?: string;
    firstSeenAt?: string;
    lastSeenAt?: string;
  }> = [];

  for (const config of configs) {
    const list = reviewStore.getTaskList(config.id);
    if (!list) continue;
    // Find the latest complete result for this config to get review id/date.
    const latestResult = allResults.find(
      (r) => r.configId === config.id && r.status === "complete",
    );
    const reviewId = latestResult?.id ?? "";
    const reviewDate = latestResult?.completedAt ?? latestResult?.startedAt ?? "";
    const reviewerModels = latestResult?.reviewerModels ?? [];

    for (const task of list.tasks) {
      backfillTaskFields(task);
      allTasks.push({
        configId: config.id,
        configName: config.name,
        reviewId,
        reviewDate,
        reviewerModels,
        ...task,
        lenses: resolveLenses(task.lenses, config.lenses),
        reviewers: resolveReviewers(task.reviewers, reviewerModels, config.lenses),
      });
    }
  }

  // Sort: open first, then by priority.
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
  allTasks.sort((a, b) =>
    (a.resolved ? 1 : 0) - (b.resolved ? 1 : 0) ||
    order[a.priority as keyof typeof order] - order[b.priority as keyof typeof order],
  );

  return json({ tasks: allTasks });
}
