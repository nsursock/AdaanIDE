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

function resolveLenses(lenses: string[], configLenses: { id: string; label: string; code?: string }[]): string[] {
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
    if (/^[A-Z]{3,5}$/.test(lens)) return lens;
    if (lCodeMap.has(lens)) return lCodeMap.get(lens)!;
    if (idMap.has(lens)) return idMap.get(lens)!;
    if (labelMap.has(lens)) return labelMap.get(lens)!;
    if (labelMap.has(lens.toLowerCase())) return labelMap.get(lens.toLowerCase())!;
    // Label fragment ("Evaluation")? Fuzzy-match a lens label → its code.
    const up = fuzzyKey(lens);
    if (up.length >= 4) {
      const hit = configLenses.find((l) => fuzzyKey(l.label).includes(up) || wordsWithinLabel(lens, l.label));
      if (hit) return lensCode(hit);
    }
    if (/^L\d+$/i.test(lens)) return lens.toUpperCase();
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

function resolveReviewers(
  reviewers: string[],
  reviewerModels: string[],
  configLenses: { id: string; label: string; code?: string }[] = [],
): string[] {
  const friendlyNames = reviewerModels.map(friendlyModelName);
  const cleaned = reviewers.filter((r) => r && r !== "—" && !isLensLike(r, configLenses));
  const hasGeneric = cleaned.some((r) => /committee/i.test(r));
  const hasReal = cleaned.some((r) => !/committee/i.test(r));
  if ((cleaned.length === 0 || (hasGeneric && !hasReal)) && friendlyNames.length > 0) return friendlyNames;
  if (hasGeneric && hasReal) {
    const used = new Set(cleaned.filter((r) => !/committee/i.test(r)).map((r) => r.toLowerCase()));
    const remaining = friendlyNames.filter((n) => !used.has(n.toLowerCase()));
    let remIdx = 0;
    return cleaned.map((r) => /committee/i.test(r) ? (remaining[remIdx++] ?? r) : r);
  }
  return cleaned.map((r) => (r.includes("/") || /:free$/i.test(r)) ? friendlyModelName(r) : r);
}

/** GET /api/review/results — list all results (summary), or ?id= for full detail.
 *  Optional ?root= filters results to configs whose workspaceRoot matches. */
export async function GET({ url }) {
  await reviewStore.load();
  const id = url.searchParams.get("id");
  const root = url.searchParams.get("root") ?? undefined;
  if (id) {
    const result = reviewStore.getResult(id);
    if (!result) return json({ error: "not found" }, { status: 404 });
    // Resolve L-codes and "Committee Reviewer" in tasks.
    const config = reviewStore.getConfigs().find((c) => c.id === result.configId);
    if (config && result.tasks) {
      result.tasks = result.tasks.map((t) => {
        backfillTaskFields(t);
        return {
          ...t,
          lenses: resolveLenses(t.lenses, config.lenses),
          reviewers: resolveReviewers(t.reviewers, result.reviewerModels, config.lenses),
        };
      });
    }
    return json({ result });
  }
  const configs = reviewStore.getConfigs();
  const configWsRoot = new Map(configs.map((c) => [c.id, c.workspaceRoot]));
  const allResults = reviewStore.getResults();
  const filteredResults = root
    ? allResults.filter((r) => configWsRoot.get(r.configId) === root)
    : allResults;
  const results = filteredResults.map((r) => {
    const legacy = r as unknown as { findings?: { priority?: string }[]; model?: string };
    const tasks = r.tasks ?? legacy.findings ?? [];
    return {
      id: r.id,
      configId: r.configId,
      configName: r.configName,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      expertise: r.expertise,
      reviewerModels: r.reviewerModels ?? (legacy.model ? [legacy.model] : []),
      aggregatorModel: r.aggregatorModel,
      status: r.status,
      error: r.error,
      triggeredBy: r.triggeredBy,
      taskCount: tasks.length,
      openCount: tasks.filter((t: any) => !t.resolved).length,
      p0: tasks.filter((t: any) => t.priority === "P0").length,
      p1: tasks.filter((t: any) => t.priority === "P1").length,
      p2: tasks.filter((t: any) => t.priority === "P2").length,
      p3: tasks.filter((t: any) => t.priority === "P3").length,
      estimatedCost: r.estimatedCost,
      estimatedTokens: r.estimatedTokens,
      actualCost: r.actualCost,
      actualTokens: r.actualTokens,
      /** Interrupted runs with surviving reviewer outputs can be resumed. */
      canResume:
        r.status === "interrupted" &&
        !!configWsRoot.has(r.configId) &&
        Object.values(r.rawOutputs ?? {}).some(
          (v) => v && !String(v).startsWith("[REVIEWER ERROR:"),
        ),
    };
  });
  return json({ results });
}
