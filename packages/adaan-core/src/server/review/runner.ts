import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProviderMessage, ModelInfo } from "../../types.js";
import type { LLMProvider } from "../agent/provider.js";
import type { Workspace } from "../workspace.js";
import type {
  ReviewConfig,
  ReviewResult,
  ReviewProgress,
  ReviewTask,
  ExpertiseLevel,
} from "./types.js";
import { reviewId, reviewStore } from "./store.js";
import { parsePriorityTable, parseAggregatorJSON, buildIssueBody, buildLabels, backfillTaskFields, lensCode } from "./parse.js";
import { mergeTaskList, buildTasksMarkdown } from "./tasklist.js";
import { resolveReviewerModels, resolveAggregatorModel, estimateReviewCost, findModel, fetchModelsByTier } from "./models.js";

const execAsync = promisify(exec);

function estTokens(s: string): number { return Math.ceil(s.length / 4); }

const KEY_FILE_NAMES = [
  "package.json", "tsconfig.json", "pyproject.toml", "setup.py", "requirements.txt",
  "Cargo.toml", "go.mod", "README.md", "README", "AGENTS.md", "CLAUDE.md",
  ".env.example", "Dockerfile", "docker-compose.yml",
];

const REVIEWABLE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java",
  ".kt", ".swift", ".rb", ".php", ".cs", ".cpp", ".cc", ".c", ".h", ".hpp",
  ".svelte", ".vue", ".astro", ".json", ".toml", ".yaml", ".yml", ".cfg",
  ".ini", ".md", ".txt", ".sh", ".bash", ".zsh", ".sql",
]);

async function gatherContext(workspace: Workspace, targetPath: string | undefined, tokenBudget = 12_000): Promise<{ text: string; tokens: number }> {
  const tree = await workspace.listTree(targetPath ?? undefined, 0, { showHidden: false, filterForAgent: true });
  const paths: string[] = [];
  const walk = (nodes: typeof tree, prefix: string): void => {
    for (const n of nodes) {
      const p = prefix ? `${prefix}/${n.name}` : n.name;
      if (n.type === "file") paths.push(p);
      else if (n.children?.length) walk(n.children, p);
    }
  };
  walk(tree, "");

  const listing = paths.slice(0, 400).join("\n");
  let budget = tokenBudget - estTokens(listing);

  const keyFiles = paths.filter((p) => KEY_FILE_NAMES.includes(p.split("/").pop() ?? ""));
  const sourceFiles = paths.filter((p) => {
    const dot = p.lastIndexOf(".");
    const ext = dot >= 0 ? p.slice(dot).toLowerCase() : "";
    return REVIEWABLE_EXT.has(ext) && !keyFiles.includes(p);
  });
  const blocked = /(^|\/)(node_modules|dist|build|target|\.next|\.svelte-kit|vendor|coverage)\//;
  const candidates = [...keyFiles, ...sourceFiles.filter((p) => !blocked.test(p))];

  const chunks: string[] = [];
  for (const p of candidates) {
    if (budget <= 0) break;
    try {
      const fc = await workspace.readFile(p);
      const maxChars = 8000;
      const content = fc.content.length > maxChars ? fc.content.slice(0, maxChars) + "\n…[truncated]" : fc.content;
      const chunk = `\n--- FILE: ${p} ---\n${content}`;
      const t = estTokens(chunk);
      if (t > budget) { chunks.push(chunk.slice(0, budget * 4) + "\n…[truncated]"); budget = 0; break; }
      chunks.push(chunk); budget -= t;
    } catch { /* skip */ }
  }

  const text = `# Project file tree\n${listing}\n\n# Key file contents\n${chunks.join("\n")}`;
  return { text, tokens: estTokens(text) };
}

/** Build the committee prompt. The expertise level is prepended to each lens. */
export function buildCommitteePrompt(config: ReviewConfig, context: string): string {
  const lenses = config.lenses
    .map((l, i) => `${i + 1}. ${l.emoji} **${l.label}**: You're a ${config.expertise} ${l.role || l.label.toLowerCase()}. Criticise this project.`)
    .join("\n");

  const scope = config.targetPath ? ` Limit the review to the path \`${config.targetPath}\`.` : "";

  return `Perform a rigorous, multi-perspective committee code review of the project.${scope}

First, map the project: identify the entry points and understand the architecture, data flow, and core logic. Then analyze the code sequentially through these specialized lenses, each taking their role seriously, and provide explicit, actionable fixes for each:

${lenses}

End with a prioritized action list using ONLY P0, P1, P2, P3 (do NOT invent P4 or higher) across all lenses, ordered by risk-to-reward impact. Use exactly this table format as the final section, under a \`## Priority list\` heading:

## Priority list

| Priority | Issue | Main finding | Fix | Lens(es) | Reviewer(s) | Impact |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | {3–5 words} | {1–2 sentences, concrete} | {1 sentence, actionable} | {comma-separated lens ids} | {comma-separated reviewer models} | {8–12 words} |

Here is the project to review:

${context}`;
}

/** Build the aggregator prompt. */
export function buildAggregatorPrompt(
  config: ReviewConfig,
  reviewerOutputs: Record<string, string>,
  fallbackTasks: ReviewTask[],
  aggregatorModel: string,
): string {
  const reviewerIds = Object.keys(reviewerOutputs);
  const combinedOutput = reviewerIds.length === 1
    ? reviewerOutputs[reviewerIds[0]]
    : reviewerIds.map((id) => `\n=== Reviewer: ${id} ===\n${reviewerOutputs[id]}`).join("\n");

  // Build explicit L-code → label and short-code mapping. Short codes are
  // the user-defined lens codes (or derived from the label when unset).
  const lensCodeMap = config.lenses.map((l, i) => `L${i + 1} = ${l.label}`).join(", ");
  const lensShortCodes = config.lenses
    .map((l, i) => `L${i + 1} = ${lensCode(l)} (${l.label})`)
    .join(", ");
  const lensList = config.lenses.map((l) => `${l.id} (${l.label})`).join(", ");
  const reviewerList = reviewerIds.join(", ");

  // Build reviewer name hints — try to produce friendly names from the keys.
  const reviewerHints = reviewerIds.map((id) => {
    const base = id.includes("/") ? id.split("/").pop()! : id;
    const clean = base.replace(/:free$/i, "");
    // Map common patterns to friendly names
    if (/gpt|openai/i.test(clean)) return `${id} → ChatGPT`;
    if (/claude|anthropic/i.test(clean)) return `${id} → Claude`;
    if (/gemini|google/i.test(clean)) return `${id} → Gemini`;
    if (/llama|meta/i.test(clean)) return `${id} → Llama`;
    if (/deepseek/i.test(clean)) return `${id} → DeepSeek`;
    if (/qwen/i.test(clean)) return `${id} → Qwen`;
    if (/mistral/i.test(clean)) return `${id} → Mistral`;
    if (/gemma/i.test(clean)) return `${id} → Gemma`;
    if (/glm/i.test(clean)) return `${id} → GLM`;
    return `${id} → ${clean.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`;
  }).join(", ");

  return `You are the aggregation chair for a committee code review. Below ${reviewerIds.length > 1 ? `are the raw outputs from ${reviewerIds.length} reviewer models` : "is the raw committee output"}. Produce a single, deduplicated, prioritized task list as STRICT JSON — no prose, no markdown fences.

Return exactly this shape:
{
  "tasks": [
    {
      "priority": "P0",
      "issue": "3-5 words",
      "mainFinding": "8-12 words — the core problem",
      "fix": "8-12 words — the proposed solution",
      "lenses": ["MLAI","DATA","STAT"],
      "reviewers": ["ChatGPT","Claude"],
      "impact": "8-12 words",
      "issueBody": "full markdown issue body — see format below",
      "labels": ["priority:p0","lens:mlai"]
    }
  ]
}

issueBody format (MANDATORY — every task must follow this exact structure):
## Summary
<1-2 sentences describing the issue concisely>

## Current behavior
<What the code currently does that is wrong, broken, or suboptimal>

## Expected behavior
<What the code should do after the fix — the correct behavior>

## Affected code
<List the specific files, functions, classes, or modules affected. Include line references if available from the raw output.>

## Acceptance criteria
- [ ] <verifiable criterion 1>
- [ ] <verifiable criterion 2>
- [ ] <verifiable criterion 3>

## References
- **Lenses:** <comma-separated lens short codes>
- **Reviewers:** <comma-separated reviewer names>
- **Priority:** <P0|P1|P2|P3>

Rules:
- priority must be one of EXACTLY: P0, P1, P2, P3. Do NOT invent P4, P5, or higher. If a finding doesn't fit P0-P3, use P3.
- CRITICAL: Merge duplicate findings flagged by multiple lenses or reviewers into ONE task. List ALL lenses and ALL reviewers that flagged it. Never produce two tasks for the same underlying issue.
- Order tasks by priority (P0 first).
- One task entry per finding, with a GitHub-issue-ready body following the format above.
- mainFinding, fix, and impact MUST each be 8-12 words long. Not shorter, not longer.

LENS NAMING — CRITICAL:
- The raw output may use codes like L1, L2, L3, L4, L5, L6, L7. These map to lens short codes and labels by position:
  ${lensShortCodes}
- In the "lenses" array, use EXACTLY the short codes listed above (e.g. ${config.lenses.slice(0, 3).map((l) => `"${lensCode(l)}"`).join(", ")}), NEVER the L-number (never "L1", "L2"), NEVER the full label (never "${config.lenses[0]?.label ?? "ML/AI Researcher"}"), NEVER an invented abbreviation.
- The short code is the 3-8 letter uppercase code given for each lens above.
- Available lenses: ${lensList}

REVIEWER NAMING — CRITICAL:
- The reviewer model keys in the raw output are: ${reviewerList}
- Map them to friendly names: ${reviewerHints}
- You MUST use the friendly name (e.g. "ChatGPT", "Claude", "Gemini") in the "reviewers" array, NEVER the raw model id.
- You MUST NEVER output "Committee Reviewer" or any generic placeholder. Always use the specific LLM name.
- If a finding appears in multiple reviewers' outputs, list ALL of them by friendly name.

Committee raw output:
${combinedOutput}

Parsed-from-table fallback (use as a cross-check, do not blindly copy):
${JSON.stringify(fallbackTasks)}`;
}

async function consumeChat(provider: LLMProvider, messages: ProviderMessage[], model: string, signal?: AbortSignal): Promise<string> {
  let text = "";
  for await (const ev of provider.chat(messages, { model, temperature: 0.3, signal })) {
    if (ev.type === "text.delta") {
      text += (ev.data as { text?: string } | undefined)?.text ?? "";
    } else if (ev.type === "error") {
      throw new Error((ev.data as { message?: string } | undefined)?.message ?? "Provider error");
    }
  }
  return text;
}

export interface ReviewRunOptions {
  config: ReviewConfig;
  workspace: Workspace;
  provider: LLMProvider;
  triggeredBy?: "manual" | "schedule";
  signal?: AbortSignal;
  onResultUpdate?: (result: ReviewResult) => void | Promise<void>;
}

export async function* runReview(opts: ReviewRunOptions): AsyncIterable<ReviewProgress> {
  const { config, workspace, provider, triggeredBy = "manual" } = opts;
  const result: ReviewResult = {
    id: reviewId("rev-"),
    configId: config.id,
    configName: config.name,
    startedAt: new Date().toISOString(),
    expertise: config.expertise,
    reviewerModels: [],
    aggregatorModel: "",
    targetPath: config.targetPath,
    tasks: [],
    rawOutputs: {},
    status: "running",
    triggeredBy,
    source: "review",
  };

  const persist = async () => { try { await opts.onResultUpdate?.({ ...result }); } catch { /* ignore */ } };

  try {
    // 1. Gather context.
    yield { phase: "context", message: "Mapping project and gathering context…" };
    const { text: context, tokens: contextTokens } = await gatherContext(workspace, config.targetPath);

    // 2. Resolve models + estimate cost.
    const reviewerCount = config.reviewerModels.length || 1;
    const { ids: reviewerIds, models: reviewerModelInfos } = await resolveReviewerModels(config, provider, reviewerCount);
    const aggregatorModel = resolveAggregatorModel(config, reviewerIds);
    result.reviewerModels = reviewerIds;
    result.aggregatorModel = aggregatorModel;

    // Fetch all models to find the aggregator's pricing.
    const { free, paid } = await fetchModelsByTier(provider);
    const allModels = [...free, ...paid];
    const aggModelInfo = findModel(allModels, aggregatorModel);

    const { cost, tokens } = estimateReviewCost(reviewerModelInfos, aggModelInfo, contextTokens, reviewerIds.length);
    result.estimatedCost = cost;
    result.estimatedTokens = tokens;
    yield { phase: "cost", estimatedCost: cost, estimatedTokens: tokens };
    await persist();

    // 3. Run committee across all reviewers in parallel.
    const committeePrompt = buildCommitteePrompt(config, context);
    const committeeMessages: ProviderMessage[] = [
      { role: "system", content: "You are a meticulous, senior committee of reviewers. Be concrete and actionable. Always end with the priority table in the exact requested format." },
      { role: "user", content: committeePrompt },
    ];

    yield {
      phase: "committee",
      message: `Running ${reviewerIds.length} reviewer${reviewerIds.length > 1 ? "s" : ""} × ${config.lenses.length} lenses…`,
      model: reviewerIds.join(", "),
      reviewerIndex: 0,
      reviewerCount: reviewerIds.length,
    };

    // Emit a start event per reviewer so the UI can show status cards.
    for (let i = 0; i < reviewerIds.length; i++) {
      yield { phase: "committee.start", model: reviewerIds[i], reviewerIndex: i, reviewerCount: reviewerIds.length };
    }

    // Stream per-reviewer text deltas through the generator using a shared
    // queue + drain pattern. Each reviewer promise pushes deltas; the main
    // generator loop yields them as they arrive.
    const deltaQueue: { model: string; reviewerIndex: number; text: string }[] = [];
    let deltaNotify: (() => void) | null = null;
    let reviewersDone = false;

    const pushDelta = (model: string, reviewerIndex: number, text: string) => {
      deltaQueue.push({ model, reviewerIndex, text });
      deltaNotify?.();
    };

    const reviewerPromises = reviewerIds.map(async (model, index) => {
      try {
        let text = "";
        for await (const ev of provider.chat(committeeMessages, { model, temperature: 0.3, signal: opts.signal })) {
          if (ev.type === "text.delta") {
            const chunk = (ev.data as { text?: string } | undefined)?.text ?? "";
            text += chunk;
            pushDelta(model, index, chunk);
          } else if (ev.type === "error") {
            throw new Error((ev.data as { message?: string } | undefined)?.message ?? "Provider error");
          }
        }
        result.rawOutputs[model] = text;
        return { model, raw: text, index, error: null as string | null };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result.rawOutputs[model] = `[REVIEWER ERROR: ${msg}]`;
        return { model, raw: "", index, error: msg };
      }
    });

    const allSettledPromise = Promise.allSettled(reviewerPromises);
    allSettledPromise.then(() => { reviewersDone = true; deltaNotify?.(); });

    // Yield deltas as they arrive until all reviewers settle.
    while (!reviewersDone) {
      if (deltaQueue.length === 0) {
        await new Promise<void>((r) => { deltaNotify = r; });
        deltaNotify = null;
      }
      while (deltaQueue.length > 0) {
        const d = deltaQueue.shift()!;
        yield { phase: "committee.delta", model: d.model, reviewerIndex: d.reviewerIndex, text: d.text };
      }
    }
    // Drain any remaining deltas.
    while (deltaQueue.length > 0) {
      const d = deltaQueue.shift()!;
      yield { phase: "committee.delta", model: d.model, reviewerIndex: d.reviewerIndex, text: d.text };
    }

    const settled = await allSettledPromise;
    for (const s of settled) {
      if (s.status === "fulfilled") {
        // Flag reviewers that completed but produced no text — this usually
        // means the model returned an empty response or an unrecognized format.
        const empty = !s.value.error && !s.value.raw;
        const err = s.value.error ?? (empty ? "No output — model returned empty response" : undefined);
        yield { phase: "committee.done", model: s.value.model, reviewerIndex: s.value.index, error: err ?? undefined };
      }
    }

    const successfulOutputs = Object.fromEntries(
      Object.entries(result.rawOutputs).filter(([, v]) => v && !v.startsWith("[REVIEWER ERROR:")),
    );
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (Object.keys(successfulOutputs).length === 0) {
      throw new Error("All reviewer models failed. Check API key and model availability.");
    }
    await persist();

    // 4. Parse priority tables from each reviewer (fallback).
    yield { phase: "parse", message: "Parsing committee outputs…" };
    const fallbackTasks: ReviewTask[] = [];
    for (const [model, raw] of Object.entries(successfulOutputs)) {
      for (const t of parsePriorityTable(raw)) {
        if (t.reviewers.length === 0) t.reviewers = [model];
        fallbackTasks.push(t);
      }
    }

    // 5. Aggregator → strict JSON (streamed).
    yield { phase: "aggregator", message: "Aggregating findings…", model: aggregatorModel };
    const aggPrompt = buildAggregatorPrompt(config, successfulOutputs, fallbackTasks, aggregatorModel);
    const aggMessages: ProviderMessage[] = [
      { role: "system", content: "You return ONLY a JSON object, no prose, no markdown fences." },
      { role: "user", content: aggPrompt },
    ];
    let aggRaw = "";
    let aggReasoning = "";
    for await (const ev of provider.chat(aggMessages, { model: aggregatorModel, temperature: 0.3, signal: opts.signal })) {
      if (ev.type === "text.delta") {
        const chunk = (ev.data as { text?: string } | undefined)?.text ?? "";
        aggRaw += chunk;
        yield { phase: "aggregator.delta", text: chunk };
      } else if (ev.type === "reasoning.delta") {
        const chunk = (ev.data as { text?: string } | undefined)?.text ?? "";
        aggReasoning += chunk;
        yield { phase: "aggregator.reasoning", text: chunk };
      } else if (ev.type === "error") {
        throw new Error((ev.data as { message?: string } | undefined)?.message ?? "Aggregator error");
      }
    }

    result.aggregatorOutput = aggRaw;
    const parsed = parseAggregatorJSON(aggRaw);
    let tasks = parsed.tasks;

    // Fall back to table parse.
    if (tasks.length === 0 && fallbackTasks.length > 0) {
      tasks = fallbackTasks;
    }

    // Ensure every task has an issue body + labels, and backfill structured
    // fields the judge left empty (from the issue body's Summary section).
    for (const t of tasks) {
      if (!t.issueBody) t.issueBody = buildIssueBody(t);
      if (t.labels.length === 0) t.labels = buildLabels(t);
      backfillTaskFields(t);
    }

    // 5b. Merge into the living task list (cross-run dedup). Tasks that were
    // already flagged keep their identity (GitHub URL, firstSeenAt, sticky
    // user-resolved state); tasks missing from this run auto-resolve.
    if (config.id) {
      yield { phase: "parse", message: "Merging into living task list…" };
      await reviewStore.load();
      const previous = reviewStore.getTaskList(config.id)?.tasks ?? [];
      const now = new Date().toISOString();
      const merged = mergeTaskList(previous, tasks, now);
      tasks = merged.tasks;
      result.mergeStats = merged.stats;
    }

    // 6. Optionally create GitHub issues for P0/P1 — only for open tasks that
    // don't already have one, so repeated runs never file duplicates.
    if (config.createGitHubIssues) {
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        if (t.resolved || t.githubUrl) continue;
        if (t.priority !== "P0" && t.priority !== "P1") continue;
        yield { phase: "github", message: `Creating GitHub issue: ${t.issue}`, taskIndex: i };
        try {
          const url = await createGitHubIssue(workspace.rootPath, t);
          if (url) { t.githubUrl = url; }
        } catch (e) {
          yield { phase: "github", message: `GitHub issue failed: ${e instanceof Error ? e.message : String(e)}`, taskIndex: i };
        }
      }
    }

    // 7. Persist the living list + optionally export TASKS.md to the project.
    if (config.id) {
      const list = { configId: config.id, tasks, updatedAt: new Date().toISOString() };
      await reviewStore.saveTaskList(list);
      if (config.writeTasksFile) {
        try {
          await fs.writeFile(path.join(workspace.rootPath, "TASKS.md"), buildTasksMarkdown(list, config.name), "utf-8");
        } catch { /* best-effort export */ }
      }
    }

    result.tasks = tasks;
    result.status = "complete";
    result.completedAt = new Date().toISOString();

    await opts.onResultUpdate?.(result);
    yield { phase: "complete", result };
  } catch (e) {
    // Check if this was a cancel (abort signal).
    if (opts.signal?.aborted || (e instanceof Error && e.name === "AbortError")) {
      result.status = "cancelled";
      result.error = "Cancelled by user";
      result.completedAt = new Date().toISOString();
      await opts.onResultUpdate?.(result);
      yield { phase: "cancelled", message: "Run cancelled" };
    } else {
      result.status = "error";
      result.error = e instanceof Error ? e.message : String(e);
      result.completedAt = new Date().toISOString();
      await opts.onResultUpdate?.(result);
      yield { phase: "error", message: result.error ?? "Unknown error" };
    }
  }
}

export interface AggregateOnlyOptions {
  config: ReviewConfig;
  workspace: Workspace;
  provider: LLMProvider;
  /** Pre-existing reviewer outputs keyed by model id. */
  reviewerOutputs: Record<string, string>;
  /** Aggregator model id (defaults to config.aggregatorModel or first reviewer). */
  aggregatorModel?: string;
  signal?: AbortSignal;
  onResultUpdate?: (result: ReviewResult) => void | Promise<void>;
}

/**
 * Run ONLY the aggregation + merge + persist phases, using pre-existing
 * reviewer outputs (e.g. pasted from an external AI analysis). Skips the
 * committee phase entirely — no reviewer models are called.
 */
export async function* runAggregateOnly(opts: AggregateOnlyOptions): AsyncIterable<ReviewProgress> {
  const { config, workspace, provider, reviewerOutputs } = opts;
  let aggregatorModel = opts.aggregatorModel || resolveAggregatorModel(config, Object.keys(reviewerOutputs));

  // In upload mode, the "reviewer ids" are pasted names (not real model ids).
  // If the resolved aggregator is "auto" or a pasted name, pick a real model
  // from the provider's catalog. "openrouter/auto" is a valid OpenRouter model
  // id that auto-routes to the best available model.
  if (aggregatorModel === "auto" || !aggregatorModel) {
    aggregatorModel = "openrouter/auto";
  }

  const result: ReviewResult = {
    id: reviewId("rev-"),
    configId: config.id,
    configName: config.name,
    startedAt: new Date().toISOString(),
    triggeredBy: "manual",
    expertise: config.expertise,
    reviewerModels: Object.keys(reviewerOutputs),
    aggregatorModel,
    tasks: [],
    rawOutputs: { ...reviewerOutputs },
    estimatedCost: 0,
    estimatedTokens: 0,
    status: "running",
    source: "upload",
  };

  await reviewStore.load();

  const persist = async () => { await opts.onResultUpdate?.(result); };

  try {
    // 1. Parse priority tables from each reviewer (fallback).
    yield { phase: "parse", message: "Parsing uploaded outputs…" };
    const fallbackTasks: ReviewTask[] = [];
    for (const [model, raw] of Object.entries(reviewerOutputs)) {
      for (const t of parsePriorityTable(raw)) {
        if (t.reviewers.length === 0) t.reviewers = [model];
        fallbackTasks.push(t);
      }
    }

    // 2. Aggregator → strict JSON (streamed).
    yield { phase: "aggregator", message: "Aggregating findings…", model: aggregatorModel };
    const aggPrompt = buildAggregatorPrompt(config, reviewerOutputs, fallbackTasks, aggregatorModel);
    const aggMessages: ProviderMessage[] = [
      { role: "system", content: "You return ONLY a JSON object, no prose, no markdown fences." },
      { role: "user", content: aggPrompt },
    ];
    let aggRaw = "";
    let aggReasoning = "";
    for await (const ev of provider.chat(aggMessages, { model: aggregatorModel, temperature: 0.3, signal: opts.signal })) {
      if (ev.type === "text.delta") {
        const chunk = (ev.data as { text?: string } | undefined)?.text ?? "";
        aggRaw += chunk;
        yield { phase: "aggregator.delta", text: chunk };
      } else if (ev.type === "reasoning.delta") {
        const chunk = (ev.data as { text?: string } | undefined)?.text ?? "";
        aggReasoning += chunk;
        yield { phase: "aggregator.reasoning", text: chunk };
      } else if (ev.type === "error") {
        throw new Error((ev.data as { message?: string } | undefined)?.message ?? "Aggregator error");
      }
    }

    result.aggregatorOutput = aggRaw;
    const parsed = parseAggregatorJSON(aggRaw);
    let tasks = parsed.tasks;
    if (tasks.length === 0 && fallbackTasks.length > 0) {
      tasks = fallbackTasks;
    }

    for (const t of tasks) {
      if (!t.issueBody) t.issueBody = buildIssueBody(t);
      if (t.labels.length === 0) t.labels = buildLabels(t);
      backfillTaskFields(t);
    }

    // 3. Merge into the living task list.
    if (config.id) {
      yield { phase: "parse", message: "Merging into living task list…" };
      await reviewStore.load();
      const previous = reviewStore.getTaskList(config.id)?.tasks ?? [];
      const now = new Date().toISOString();
      const merged = mergeTaskList(previous, tasks, now);
      tasks = merged.tasks;
      result.mergeStats = merged.stats;
    }

    // 4. Optionally create GitHub issues.
    if (config.createGitHubIssues) {
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        if (t.resolved || t.githubUrl) continue;
        if (t.priority !== "P0" && t.priority !== "P1") continue;
        yield { phase: "github", message: `Creating GitHub issue: ${t.issue}`, taskIndex: i };
        try {
          const url = await createGitHubIssue(workspace.rootPath, t);
          if (url) { t.githubUrl = url; }
        } catch (e) {
          yield { phase: "github", message: `GitHub issue failed: ${e instanceof Error ? e.message : String(e)}`, taskIndex: i };
        }
      }
    }

    // 5. Persist.
    if (config.id) {
      const list = { configId: config.id, tasks, updatedAt: new Date().toISOString() };
      await reviewStore.saveTaskList(list);
      if (config.writeTasksFile) {
        try {
          await fs.writeFile(path.join(workspace.rootPath, "TASKS.md"), buildTasksMarkdown(list, config.name), "utf-8");
        } catch { /* best-effort export */ }
      }
    }

    result.tasks = tasks;
    result.status = "complete";
    result.completedAt = new Date().toISOString();
    await persist();
    yield { phase: "complete", result };
  } catch (e) {
    if (opts.signal?.aborted || (e instanceof Error && e.name === "AbortError")) {
      result.status = "cancelled";
      result.error = "Cancelled by user";
      result.completedAt = new Date().toISOString();
      await opts.onResultUpdate?.(result);
      yield { phase: "cancelled", message: "Run cancelled" };
    } else {
      result.status = "error";
      result.error = e instanceof Error ? e.message : String(e);
      result.completedAt = new Date().toISOString();
      await opts.onResultUpdate?.(result);
      yield { phase: "error", message: result.error ?? "Unknown error" };
    }
  }
}

export async function createGitHubIssue(rootPath: string, task: ReviewTask): Promise<string | undefined> {
  const title = `[${task.priority}] ${task.issue}`;
  const labelsArg = task.labels.length > 0 ? `--label ${task.labels.map((l) => `"${l.replace(/"/g, '\\"')}"`).join(",")}` : "";
  const cmd = `gh issue create --title "${title.replace(/"/g, '\\"')}" ${labelsArg} --body - <<'ADaanIDE_REVIEW_BODY'\n${task.issueBody}\nADaanIDE_REVIEW_BODY`;
  const { stdout } = await execAsync(cmd, { cwd: rootPath, maxBuffer: 1024 * 1024 });
  return stdout.trim() || undefined;
}

// --- Active runs registry (for cancel support) ------------------------------

const activeRuns = new Map<string, AbortController>();

/** Register an active run so it can be cancelled. */
export function registerRun(resultId: string, controller: AbortController): void {
  activeRuns.set(resultId, controller);
}

/** Unregister a run (call when it completes/errors/cancels). */
export function unregisterRun(resultId: string): void {
  activeRuns.delete(resultId);
}

/** Cancel a specific run by result id. Returns true if found. */
export function cancelRun(resultId: string): boolean {
  const ctrl = activeRuns.get(resultId);
  if (ctrl) {
    ctrl.abort();
    activeRuns.delete(resultId);
    return true;
  }
  return false;
}

/** Cancel all active runs. Returns the number of runs cancelled. */
export function cancelAllRuns(): number {
  const count = activeRuns.size;
  for (const ctrl of activeRuns.values()) ctrl.abort();
  activeRuns.clear();
  return count;
}

/** Get the result ids of all active runs. */
export function getActiveRunIds(): string[] {
  return [...activeRuns.keys()];
}
