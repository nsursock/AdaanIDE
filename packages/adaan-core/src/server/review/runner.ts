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

/** Default per-request deadline for review LLM calls. Review prompts are
 *  large (10k+ tokens of project context + committee instructions) and
 *  reasoning models can take 3-5 minutes. This is longer than the agent
 *  chat default (180s) because a review is a batch job, not interactive. */
const DEFAULT_REVIEW_TIMEOUT_MS = 300_000; // 5 minutes

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

/** Map expertise tiers to concrete behavioral descriptors — percentile claims
 *  shift tone more than correctness, so we describe experience and behavior
 *  instead (Claude + DeepSeek consensus). */
const EXPERTISE_PROMPT_MAP: Record<ExpertiseLevel, string> = {
  "top-0.1%": "You have 20+ years of deep production experience in your discipline. You've reviewed thousands of codebases and catch subtle defects that pass standard review — race conditions, off-by-one errors in numerical code, silent data corruption paths, and architectural decisions that fail under load",
  "top-1%": "You have 15+ years of production experience in your discipline. You catch non-obvious defects that a senior engineer might miss, including edge cases, concurrency issues, and silent failure modes",
  "top-10%": "You have 10+ years of production experience in your discipline. You identify concrete defects with clear failure scenarios, focusing on issues that would cause production incidents",
  "top-25%": "You have 5+ years of production experience in your discipline. You identify clear, well-evidenced defects with concrete failure scenarios",
};

/** Build the committee prompt. The expertise level is mapped to behavioral
 *  descriptors and prepended to each lens. */
export function buildCommitteePrompt(config: ReviewConfig, context: string): string {
  const expertiseDesc = EXPERTISE_PROMPT_MAP[config.expertise] ?? EXPERTISE_PROMPT_MAP["top-1%"];

  const lenses = config.lenses
    .map((l, i) => {
      const role = l.role || l.label.toLowerCase();
      const code = lensCode(l);
      return `${i + 1}. ${l.emoji} **${l.label}** (${code}): ${expertiseDesc} as a ${role}. Focus exclusively on ${role} concerns — do not report generic style or architecture issues unless they directly cause a ${role} defect.`;
    })
    .join("\n");

  const scope = config.targetPath ? ` Limit the review to the path \`${config.targetPath}\`.` : "";

  const lensCodes = config.lenses.map((l) => lensCode(l));
  const lensCodeHint = lensCodes.slice(0, 3).map((c) => `"${c}"`).join(", ");

  return `Perform a rigorous, multi-perspective committee code review of the project.${scope} You are reviewing code that will run in production — bugs will cost real money.

A project map (file tree + key file contents) is provided below. Use it to ground your analysis — do not waste effort re-deriving the architecture.

OUTPUT CONSTRAINT — CRITICAL:
- Do NOT repeat, echo, quote, or reproduce the provided project code in your output. The user already has the code.
- Produce ONLY your analysis, findings, and the final priority table.
- Reference files and symbols by name (e.g. "In scripts/data.py, the volatility computation…") — never paste the source code back.

Analyze the code sequentially through these specialized lenses:

${lenses}

EVIDENCE RULES (apply to every lens):
- Report only findings supported by concrete evidence in the supplied code, configuration, tests, or logs. Do not invent behavior that is not established by the project.
- Do not infer missing implementation details as facts. If evidence is insufficient, mark the concern as unverified rather than presenting it as a finding.
- Do not report generic best practices unless they address a concrete problem in this project.
- Reviewer intuition is not evidence.
- It is valid to return zero findings. Do not manufacture findings to fill the table.

FINDING QUALITY:
For every finding, follow this reasoning structure:
  evidence → mechanism → consequence → fix
Identify the concrete code evidence, explain the mechanism that causes the problem, describe the practical consequence (a concrete failure scenario — what breaks in production?), and propose the smallest appropriate corrective action.

Distinguish confirmed defects (the code provably does the wrong thing) from risks (likely but not verified) and improvements (valid engineering, but not a defect).

End with a prioritized action list using ONLY P0, P1, P2, P3 (do NOT invent P4 or higher) across all lenses. Prioritize by severity, likelihood, affected scope, and consequence — a speculative optimization must never outrank a confirmed correctness defect. Do not assign priority based on how interesting or sophisticated a finding is.

Use exactly this table format as the final section, under a \`## Priority list\` heading:

## Priority list

| Priority | Issue | Main finding | Fix | Lens(es) | Reviewer(s) | Impact |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | {concise title} | {evidence + mechanism, concrete} | {actionable fix} | {comma-separated lens short codes, e.g. ${lensCodeHint}} | {your own model name, e.g. Claude, Gemini, GPT} | {concrete real-world consequence} |

Priority definitions:
- P0 — Critical: correctness, security, or data-integrity failure that makes the system unsafe or unusable.
- P1 — High: major correctness, reliability, performance, or architectural defect with real-world impact.
- P2 — Medium: important defect or substantial improvement that should be addressed but doesn't compromise the system fundamentally.
- P3 — Low: minor defect, maintainability issue, or non-critical optimization.

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

  return `You are an adversarial adjudicator for a committee code review — not a summarizer. Below ${reviewerIds.length > 1 ? `are the raw outputs from ${reviewerIds.length} reviewer models` : "is the raw committee output"}. Produce a single, deduplicated, prioritized task list as STRICT JSON — no prose, no markdown fences.

Return exactly this shape:
{
  "tasks": [
    {
      "priority": "P0",
      "issue": "concise title (one short phrase)",
      "mainFinding": "one crisp sentence describing the core problem",
      "fix": "one crisp sentence describing the proposed solution",
      "lenses": ["MLAI","DATA","STAT"],
      "reviewers": ["ChatGPT","Claude"],
      "impact": "one crisp sentence describing the real-world consequence",
      "type": "bug",
      "confidence": "high",
      "issueBody": "full markdown issue body — see format below",
      "labels": ["priority:p0","lens:mlai","type:bug"]
    }
  ]
}

type: one of "bug" (confirmed defect), "risk" (likely but unverified), "improvement" (valid engineering, not a defect). Only "bug" should reach P0.
confidence: one of "high", "medium", "low" — how well the evidence supports the finding.

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
- **Type:** <bug|risk|improvement>
- **Confidence:** <high|medium|low>
- **Lenses:** <comma-separated lens short codes>
- **Reviewers:** <comma-separated reviewer names>
- **Priority:** <P0|P1|P2|P3>

EXECUTION ORDER (follow this sequence internally before producing output):
1. Catalog all candidate findings across all reviewers and cluster duplicates by root cause.
2. Map every L-code and model ID to its canonical short code and friendly name.
3. Adjudicate each candidate (verify, classify, prioritize).
4. Generate the final JSON payload.

ADJUDICATION RULES:
- Independently verify whether the supplied evidence actually supports each claim. Reject findings whose conclusions depend on assumptions not established by the project context.
- Reject purely stylistic findings or findings with no concrete code evidence.
- Two findings are duplicates when they identify the same underlying root cause, even if they describe different symptoms, use different terminology, or appear under different lenses. Merge them into ONE task.
- Do NOT merge findings merely because they affect the same file, function, or subsystem when their root causes differ. Preserve distinct findings even when they affect the same subsystem.
- Resolve reviewer disagreement using project evidence, not reviewer majority. Reviewer consensus is evidence of agreement, NOT evidence that the claim is true. A finding must not become more severe merely because multiple reviewers reported it.
- If reviewers disagree on priority, default to the HIGHER priority. If reviewers disagree on whether something is a bug, classify it as "risk" with confidence "medium".

EVIDENCE HIERARCHY (strongest to weakest):
1. Executable behavior / tests / logs
2. Concrete implementation in supplied code
3. Configuration and documented invariants
4. Strong architectural inference
5. Reviewer speculation
Never present level 4–5 reasoning as a confirmed defect without qualification.

PRIORITY DEFINITIONS:
- P0 — Critical: correctness, security, or data-integrity failure that makes the system unsafe or unusable. Only "bug" type.
- P1 — High: major correctness, reliability, performance, or architectural defect with real-world impact.
- P2 — Medium: important defect or substantial improvement that should be addressed but doesn't compromise the system fundamentally.
- P3 — Low: minor defect, maintainability issue, or non-critical optimization.
- Do NOT invent P4 or higher. If a finding doesn't fit P0-P3, use P3.
- Prioritize by severity, likelihood, affected scope, and consequence. A speculative optimization must never outrank a confirmed correctness defect.

OUTPUT RULES:
- Order tasks by priority (P0 first).
- One task entry per finding, with a GitHub-issue-ready body following the format above.
- List ALL lenses and ALL reviewers that flagged a finding in the merged task.

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

async function consumeChat(provider: LLMProvider, messages: ProviderMessage[], model: string, signal?: AbortSignal, deadlineMs?: number): Promise<string> {
  let text = "";
  for await (const ev of provider.chat(messages, { model, temperature: 0.3, signal, deadlineMs })) {
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
  /** Reuse a specific result id (the run manager owns run identity). */
  resultId?: string;
  /** Resume from an interrupted run: reviewers whose output already exists in
   *  `resumeFrom.rawOutputs` (non-empty, non-error) are skipped instead of
   *  re-run; their text is carried into the aggregation. */
  resumeFrom?: ReviewResult;
}

export async function* runReview(opts: ReviewRunOptions): AsyncIterable<ReviewProgress> {
  const { config, workspace, provider, triggeredBy = "manual" } = opts;

  // Outputs carried over from an interrupted run — these reviewers are NOT
  // re-called on this pass.
  const preserved: Record<string, string> = {};
  for (const [model, text] of Object.entries(opts.resumeFrom?.rawOutputs ?? {})) {
    if (text && !text.startsWith("[REVIEWER ERROR:")) preserved[model] = text;
  }

  const result: ReviewResult = {
    id: opts.resumeFrom?.id ?? opts.resultId ?? reviewId("rev-"),
    configId: config.id,
    configName: config.name,
    startedAt: opts.resumeFrom?.startedAt ?? new Date().toISOString(),
    expertise: config.expertise,
    reviewerModels: [],
    aggregatorModel: "",
    targetPath: config.targetPath,
    tasks: [],
    rawOutputs: { ...preserved },
    status: "running",
    triggeredBy,
    source: opts.resumeFrom?.source ?? "review",
  };

  const persist = async () => { try { await opts.onResultUpdate?.({ ...result }); } catch { /* ignore */ } };

  /** OpenRouter session id — groups all reviewer + aggregator requests
   *  from this run together in the OpenRouter dashboard for debugging. */
  const sessionId = `review-${result.id}`;

  // Persist the skeleton immediately so the store reflects "running" even if
  // the process dies before the first milestone.
  await persist();

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

    // Fetch all models to find the aggregator's pricing. Try exact match
    // first, then prefix match (catalog slugs often have date suffixes).
    const { free, paid } = await fetchModelsByTier(provider);
    const allModels = [...free, ...paid];
    const aggModelInfo = findModel(allModels, aggregatorModel)
      ?? allModels.find((m) => m.id.startsWith(aggregatorModel + "-") || m.id.startsWith(aggregatorModel));

    const { cost, tokens } = estimateReviewCost(reviewerModelInfos, aggModelInfo, contextTokens, reviewerIds.length);
    result.estimatedCost = cost;
    result.estimatedTokens = tokens;
    yield { phase: "cost", estimatedCost: cost, estimatedTokens: tokens };
    await persist();

    // 3. Run committee across all reviewers in parallel.
    const committeePrompt = buildCommitteePrompt(config, context);
    const committeeMessages: ProviderMessage[] = [
      { role: "system", content: "You are a rigorous software-review committee reviewing code that will run in production. Be evidence-driven, skeptical, concrete, and actionable. Report only findings supported by the supplied project evidence. Do not invent behavior or manufacture findings. Distinguish confirmed defects from risks and recommendations. Explain the causal mechanism behind every defect. It is valid to return zero findings. Prioritize correctness and real-world impact over stylistic preferences." },
      { role: "user", content: committeePrompt },
    ];

    yield {
      phase: "committee",
      message: `Running ${reviewerIds.length} reviewer${reviewerIds.length > 1 ? "s" : ""} × ${config.lenses.length} lenses…`,
      model: reviewerIds.join(", "),
      reviewerIndex: 0,
      reviewerCount: reviewerIds.length,
    };

    // Reviewers carried over from an interrupted run emit begin+done
    // immediately (their text is already in result.rawOutputs and comes back
    // to attaching clients via the manager's replay).
    const pendingModels = reviewerIds.filter((m) => !(m in preserved));
    for (let i = 0; i < reviewerIds.length; i++) {
      const model = reviewerIds[i];
      if (pendingModels.includes(model)) continue;
      yield { phase: "committee.start", model, reviewerIndex: i, reviewerCount: reviewerIds.length };
      yield { phase: "committee.done", model, reviewerIndex: i };
    }

    // Emit a start event per pending reviewer so the UI can show status cards.
    for (let i = 0; i < reviewerIds.length; i++) {
      if (!pendingModels.includes(reviewerIds[i])) continue;
      yield { phase: "committee.start", model: reviewerIds[i], reviewerIndex: i, reviewerCount: reviewerIds.length };
    }

    // Stream per-reviewer text deltas through the generator using a shared
    // queue + drain pattern. Each reviewer promise pushes deltas; the main
    // generator loop yields them as they arrive.
    const deltaQueue: { model: string; reviewerIndex: number; text: string }[] = [];
    const queuedQueue: { model: string; reviewerIndex: number }[] = [];
    let deltaNotify: (() => void) | null = null;
    let reviewersDone = false;

    const pushDelta = (model: string, reviewerIndex: number, text: string) => {
      deltaQueue.push({ model, reviewerIndex, text });
      deltaNotify?.();
    };

    const pushQueued = (model: string, reviewerIndex: number) => {
      queuedQueue.push({ model, reviewerIndex });
      deltaNotify?.();
    };

    const reviewerPromises = reviewerIds
      .map((model, index) => ({ model, index }))
      .filter(({ model }) => pendingModels.includes(model))
      .map(async ({ model, index }) => {
        try {
          let text = "";
          let started = false;
          for await (const ev of provider.chat(committeeMessages, { model, temperature: 0.3, signal: opts.signal, deadlineMs: opts.config.timeoutMs || DEFAULT_REVIEW_TIMEOUT_MS, sessionId })) {
            if (ev.type === "text.delta") {
              const chunk = (ev.data as { text?: string } | undefined)?.text ?? "";
              text += chunk;
              started = true;
              pushDelta(model, index, chunk);
            } else if (ev.type === "provider.queued") {
              // OpenRouter sends PROCESSING keep-alives throughout the stream,
              // not just before the first token. Only surface the queued state
              // before any text has arrived — afterwards it's just noise.
              if (!started) pushQueued(model, index);
            } else if (ev.type === "finish") {
              const genId = (ev.data as { generationId?: string } | undefined)?.generationId;
              if (genId) {
                result.generationIds ??= {};
                result.generationIds[model] = genId;
              }
            } else if (ev.type === "error") {
              throw new Error((ev.data as { message?: string } | undefined)?.message ?? "Provider error");
            }
          }
          result.rawOutputs[model] = text;
          // Persist after every reviewer so an interruption (quit/restart)
          // keeps the completed work — resume skips already-done reviewers.
          await persist();
          return { model, raw: text, index, error: null as string | null };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.rawOutputs[model] = `[REVIEWER ERROR: ${msg}]`;
          return { model, raw: "", index, error: msg };
        }
      });

    const allSettledPromise = Promise.allSettled(reviewerPromises);
    allSettledPromise.then(() => { reviewersDone = true; deltaNotify?.(); });

    // Yield deltas and queue events as they arrive until all reviewers settle.
    while (!reviewersDone) {
      if (deltaQueue.length === 0 && queuedQueue.length === 0) {
        await new Promise<void>((r) => { deltaNotify = r; });
        deltaNotify = null;
      }
      while (queuedQueue.length > 0) {
        const q = queuedQueue.shift()!;
        yield { phase: "committee.queued", model: q.model, reviewerIndex: q.reviewerIndex, reviewerCount: reviewerIds.length };
      }
      while (deltaQueue.length > 0) {
        const d = deltaQueue.shift()!;
        yield { phase: "committee.delta", model: d.model, reviewerIndex: d.reviewerIndex, text: d.text };
      }
    }
    // Drain any remaining events.
    while (queuedQueue.length > 0) {
      const q = queuedQueue.shift()!;
      yield { phase: "committee.queued", model: q.model, reviewerIndex: q.reviewerIndex, reviewerCount: reviewerIds.length };
    }
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
      { role: "system", content: "You are an adversarial adjudicator for a committee code review. You verify findings against evidence, reject unsupported claims, and resolve disagreements from the code rather than by reviewer vote. You return ONLY a JSON object, no prose, no markdown fences." },
      { role: "user", content: aggPrompt },
    ];
    let aggRaw = "";
    let aggReasoning = "";
    let aggStarted = false;
    for await (const ev of provider.chat(aggMessages, { model: aggregatorModel, temperature: 0.3, signal: opts.signal, deadlineMs: opts.config.timeoutMs || DEFAULT_REVIEW_TIMEOUT_MS, sessionId })) {
      if (ev.type === "text.delta") {
        const chunk = (ev.data as { text?: string } | undefined)?.text ?? "";
        aggRaw += chunk;
        aggStarted = true;
        yield { phase: "aggregator.delta", text: chunk };
      } else if (ev.type === "reasoning.delta") {
        const chunk = (ev.data as { text?: string } | undefined)?.text ?? "";
        aggReasoning += chunk;
        aggStarted = true;
        yield { phase: "aggregator.reasoning", text: chunk };
      } else if (ev.type === "provider.queued") {
        // Suppress keep-alive queue events after output has started —
        // OpenRouter intersperses them between reasoning/text chunks.
        if (!aggStarted) yield { phase: "aggregator.queued", model: aggregatorModel };
      } else if (ev.type === "finish") {
        const genId = (ev.data as { generationId?: string } | undefined)?.generationId;
        if (genId) {
          result.generationIds ??= {};
          result.generationIds[aggregatorModel] = genId;
        }
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
  /** Reuse a specific result id (the run manager owns run identity — used
   *  when resuming an interrupted upload run). */
  resultId?: string;
  /** Resuming an interrupted run — keeps its original start time. */
  resumeFrom?: ReviewResult;
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
    id: opts.resumeFrom?.id ?? opts.resultId ?? reviewId("rev-"),
    configId: config.id,
    configName: config.name,
    startedAt: opts.resumeFrom?.startedAt ?? new Date().toISOString(),
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

  /** OpenRouter session id for the upload-judge path. */
  const sessionId = `review-${result.id}`;

  // Persist the skeleton immediately (see runReview).
  await persist();

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
      { role: "system", content: "You are an adversarial adjudicator for a committee code review. You verify findings against evidence, reject unsupported claims, and resolve disagreements from the code rather than by reviewer vote. You return ONLY a JSON object, no prose, no markdown fences." },
      { role: "user", content: aggPrompt },
    ];
    let aggRaw = "";
    let aggReasoning = "";
    let aggStarted = false;
    for await (const ev of provider.chat(aggMessages, { model: aggregatorModel, temperature: 0.3, signal: opts.signal, deadlineMs: opts.config.timeoutMs || DEFAULT_REVIEW_TIMEOUT_MS, sessionId })) {
      if (ev.type === "text.delta") {
        const chunk = (ev.data as { text?: string } | undefined)?.text ?? "";
        aggRaw += chunk;
        aggStarted = true;
        yield { phase: "aggregator.delta", text: chunk };
      } else if (ev.type === "reasoning.delta") {
        const chunk = (ev.data as { text?: string } | undefined)?.text ?? "";
        aggReasoning += chunk;
        aggStarted = true;
        yield { phase: "aggregator.reasoning", text: chunk };
      } else if (ev.type === "provider.queued") {
        // Suppress keep-alive queue events after output has started —
        // OpenRouter intersperses them between reasoning/text chunks.
        if (!aggStarted) yield { phase: "aggregator.queued", model: aggregatorModel };
      } else if (ev.type === "finish") {
        const genId = (ev.data as { generationId?: string } | undefined)?.generationId;
        if (genId) {
          result.generationIds ??= {};
          result.generationIds[aggregatorModel] = genId;
        }
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
