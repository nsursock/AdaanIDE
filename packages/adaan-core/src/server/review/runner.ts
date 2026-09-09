import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProviderMessage, ModelInfo } from "../../types.js";
import type { LLMProvider } from "../agent/provider.js";
import { OpenRouterProvider } from "../agent/providers/openrouter.js";
import type { Workspace } from "../workspace.js";
import type {
  ReviewConfig,
  ReviewResult,
  ReviewProgress,
  ReviewTask,
  ExpertiseLevel,
} from "./types.js";
import { reviewId, reviewStore } from "./store.js";
import { parsePriorityTable, parseAggregatorResponse, consolidateReviewerTasks, buildIssueBody, buildLabels, backfillTaskFields, lensCode } from "./parse.js";
import { mergeTaskList, buildTasksMarkdown } from "./tasklist.js";
import { resolveReviewerModels, resolveAggregatorModel, isAutoAggregator, pickAutoAggregator, estimateReviewCost, findModel, fetchModelsByTier, fetchAllGenerationMetadata, poolForTier } from "./models.js";

const execAsync = promisify(exec);

/** Max spare-model attempts per reviewer slot when the primary model errors
 *  out or returns empty output. Spares are drawn from the same tier pool as
 *  the reviewers (excluding models already assigned as reviewers), so a
 *  single transient 429/ResourceExhausted or empty response no longer kills
 *  the whole run. */
const MAX_REVIEWER_FAILOVER = 2;

/** Token budget escalation steps for truncation (finish: length). When a
 *  model hits the token limit, retry the SAME model with a higher budget
 *  before swapping to a spare — truncation is a budget problem, not a model
 *  problem, and a different model with the same budget will truncate too. */
const TOKEN_BUDGETS = [8192, 16384, 32768];

/** Max same-model retries for non-truncation failures (empty output, stream
 *  error). These are often transient/non-deterministic — retrying the same
 *  model is cheaper and more predictable than swapping to an unknown spare. */
const MAX_SAME_MODEL_RETRIES = 1;

/** System prompt for the judge — must match the FailoverProvider isAggregator
 *  heuristic in tests (`ONLY a JSON object`). */
const AGGREGATOR_SYSTEM =
  "You are an adversarial adjudicator for a committee code review. You verify findings against evidence, reject unsupported claims, and resolve disagreements from the code rather than by reviewer vote. You return ONLY a JSON object, no prose, no markdown fences.";

/** Follow-up when the judge burned tokens on analysis without emitting JSON. */
const AGGREGATOR_JSON_NUDGE =
  `STOP. Your previous response did not contain a parseable JSON object with a "tasks" array.\n\n` +
  `Emit ONLY the JSON object now — no prose, no markdown fences, no analysis, no catalog. Shape:\n` +
  `{"tasks":[{"priority":"P0","issue":"...","mainFinding":"...","fix":"...","lenses":["..."],"reviewers":["..."],"impact":"...","type":"bug","confidence":"high","issueBody":"## Summary\\n...","labels":["priority:p0"]}]}`;

/** Compact re-aggregate from already-parsed tables when full-context judges fail. */
function buildCompactAggregatorPrompt(fallbackTasks: ReviewTask[]): string {
  return `Deduplicate and prioritize these committee findings into ONE JSON object. Merge rows that share the same root cause. Use the highest priority when reviewers disagree. Union lenses and reviewers. Order P0→P3.

Return ONLY JSON (no prose, no fences):
{"tasks":[{"priority":"P0","issue":"...","mainFinding":"...","fix":"...","lenses":["..."],"reviewers":["..."],"impact":"...","type":"bug","confidence":"high","issueBody":"## Summary\\n...\\n\\n## Current behavior\\n...\\n\\n## Expected behavior\\n...\\n\\n## Affected code\\n...\\n\\n## Acceptance criteria\\n- [ ] ...\\n\\n## References\\n- **Priority:** P0","labels":["priority:p0"]}]}

Findings:
${JSON.stringify(fallbackTasks)}`;
}

function estTokens(s: string): number { return Math.ceil(s.length / 4); }

/** Detect tool-call-like output — some free models (e.g. Liquid lfm-2.5)
 *  ignore the review prompt and hallucinate tool calls instead, producing
 *  output like `<|tool_call_start|>[find_pattern(...)]<|tool_call_end|>`.
 *  This is not a review — it's a model that didn't follow the prompt. */
function isToolCallOutput(text: string): boolean {
  return /<\|tool_call(?:_start|_end)?\|>/.test(text);
}

/** Detect degenerate/repetitive output — a model stuck in a reasoning loop
 *  that repeats the same sentence with minor variations (common with free
 *  reasoning models that hit the token limit). Splits into sentences and
 *  checks if any single sentence template accounts for >40% of the total.
 *  This catches the "The PPO class also has a _compile_update method..."
 *  pattern where the model fills the entire token budget with variations
 *  of the same sentence. */
function isDegenerate(text: string, minLen = 500): boolean {
  if (text.length < minLen) return false;
  const sentences = text.split(/[.!?]\n/).map((s) => s.trim()).filter((s) => s.length > 30);
  if (sentences.length < 10) return false;
  // Normalize for comparison: lowercase, collapse whitespace, strip
  // trailing variable words.
  const normalized = sentences.map((s) => s.toLowerCase().replace(/\s+/g, " "));
  // Check for a dominant repeating prefix (first 40 chars) — catches
  // "The PPO class also has a _compile_update method that uses mx.grad
  // and optimizer. It may have issues with the [X]." where only the
  // last word changes.
  const prefixes = normalized.map((s) => s.slice(0, 40));
  const counts = new Map<string, number>();
  for (const p of prefixes) counts.set(p, (counts.get(p) ?? 0) + 1);
  const maxCount = Math.max(...counts.values());
  return maxCount / sentences.length > 0.4;
}

/** After a run completes, fetch actual generation metadata from the
 *  OpenRouter Generation API for every captured generation ID. This
 *  reveals what model/provider OpenRouter actually routed to (failover,
 *  auto-router decisions) vs what was requested. Silently skips when the
 *  provider is a custom/local endpoint (no OpenRouter API to query) or
 *  when there are no generation IDs. */
async function enrichWithGenerationMetadata(result: ReviewResult, provider: LLMProvider): Promise<void> {
  if (!result.generationIds || Object.keys(result.generationIds).length === 0) return;
  // Only query the OpenRouter Generation API when using the real OpenRouter
  // endpoint — local/custom servers don't have this API.
  if (!(provider instanceof OpenRouterProvider) || provider.hasCustomBaseUrl()) return;
  const apiKey = provider.getApiKey();
  if (!apiKey || apiKey === "not-needed") return;
  try {
    const meta = await fetchAllGenerationMetadata(apiKey, result.generationIds, provider.getBaseUrl());
    if (Object.keys(meta).length > 0) {
      result.generationMetadata = meta;
      let totalCost = 0;
      let totalTokens = 0;
      for (const m of Object.values(meta)) {
        totalCost += m.totalCost || 0;
        totalTokens += (m.tokensPrompt || 0) + (m.tokensCompletion || 0);
      }
      result.actualCost = Math.round(totalCost * 10000) / 10000;
      result.actualTokens = totalTokens;
    }
  } catch { /* best-effort — don't fail the run over metadata fetch */ }
}

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

  return `You are an adversarial adjudicator for a committee code review — not a summarizer. Below ${reviewerIds.length > 1 ? `are the raw outputs from ${reviewerIds.length} reviewer models` : "is the raw committee output"}. Produce a single, deduplicated, prioritized task list as STRICT JSON.

CRITICAL OUTPUT CONTRACT:
- Your ENTIRE response must be a single JSON object. No prose before or after. No markdown fences. No chain-of-thought in the content channel.
- Do your adjudication silently; do NOT narrate steps, catalogs, or reconsiderations in the output.
- If you have a reasoning channel, you may think there — but the content channel must still be ONLY the JSON object.

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

ADJUDICATION RULES (apply silently, then emit JSON):
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
    let aggregatorModel = resolveAggregatorModel(config, reviewerIds);

    // Fetch all models to find the aggregator's pricing and resolve the auto
    // aggregator to a concrete model from the same tier as the reviewers.
    // Try exact match first, then prefix match (catalog slugs often have date suffixes).
    const { free, paid } = await fetchModelsByTier(provider);
    const allModels = [...free, ...paid];
    if (isAutoAggregator(aggregatorModel)) {
      aggregatorModel = pickAutoAggregator(reviewerIds, free, paid);
    }
    result.reviewerModels = reviewerIds;
    result.aggregatorModel = aggregatorModel;

    // Spare model pool for reviewer failover: same tier as the reviewers,
    // minus any model already assigned as a reviewer (so a failover never
    // duplicates an in-flight reviewer) and minus the aggregator model (the
    // judge must stay independent from the committee). Consumed atomically by
    // failing slots — `shift()` is synchronous so there's no race between the
    // empty-check and the pop across parallel reviewer promises.
    const reviewerIdSet = new Set(reviewerIds);
    const sparePool: string[] = poolForTier(config.modelTier, free, paid)
      .map((m) => m.id)
      .filter((id) => !reviewerIdSet.has(id) && id !== aggregatorModel);
    const takeSpare = (): string | null => (sparePool.length > 0 ? sparePool.shift()! : null);

    // Spare pool for aggregator failover: same tier, minus all reviewer
    // models (the judge must stay independent) and minus the original
    // aggregator. Built from the same pool but tracked separately so
    // reviewer failovers don't starve the aggregator and vice-versa.
    const aggSparePool: string[] = poolForTier(config.modelTier, free, paid)
      .map((m) => m.id)
      .filter((id) => !reviewerIdSet.has(id) && id !== aggregatorModel);
    const takeAggSpare = (): string | null => (aggSparePool.length > 0 ? aggSparePool.shift()! : null);

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
    const failoverQueue: { from: string; to: string; reviewerIndex: number; reason: string }[] = [];
    const retryQueue: { model: string; reviewerIndex: number; reason: string; maxTokens: number }[] = [];
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

    const pushFailover = (from: string, to: string, reviewerIndex: number, reason: string) => {
      failoverQueue.push({ from, to, reviewerIndex, reason });
      deltaNotify?.();
    };

    const pushRetry = (model: string, reviewerIndex: number, reason: string, maxTokens: number) => {
      retryQueue.push({ model, reviewerIndex, reason, maxTokens });
      deltaNotify?.();
    };

    const reviewerPromises = reviewerIds
      .map((model, index) => ({ model, index }))
      .filter(({ model }) => pendingModels.includes(model))
      .map(async ({ model, index }) => {
        let currentModel = model;
        let lastError: string | null = null;
        let successModel: string | null = null;
        let successText = "";
        let tokenBudgetIdx = 0;
        let sameModelRetries = 0;
        let spareFailovers = 0;
        // Best partial output across all attempts — used as a last resort
        // if every retry and spare fails. Partial findings are better than
        // none, but we only accept them after exhausting all retries.
        let partialOutput: { model: string; text: string } | null = null;

        // Retry strategy (in order of preference):
        // 1. Truncation (finish: length) → retry SAME model with a higher
        //    token budget. Truncation is a budget problem, not a model
        //    problem — a different model with the same budget will truncate
        //    too.
        // 2. Transient failure (empty output, stream error, partial output
        //    before error) → retry SAME model once with the same params.
        //    These are often non-deterministic infrastructure issues.
        // 3. Model-specific failure (tool-call syntax, degenerate reasoning)
        //    → swap to a SPARE model immediately. The model can't or won't
        //    do the task; retrying it won't help.
        // 4. Same-model retries exhausted → swap to a SPARE model.
        // 5. All retries and spares exhausted → use partial output from an
        //    earlier attempt if available (better than nothing).
        while (true) {
          let text = "";
          let reasoning = "";
          let started = false;
          let finishReason: string | undefined;
          const reviewerKey = `reviewer:${currentModel}`;
          let attemptError: string | null = null;
          // Reset per-iteration — the reasoning guard may set this to a
          // specific message (truncated/degenerate), but it must not leak
          // into the next attempt's "no usable output" fallback.
          lastError = null;
          const maxTokens = TOKEN_BUDGETS[tokenBudgetIdx];
          try {
            for await (const ev of provider.chat(committeeMessages, { model: currentModel, temperature: 0.3, maxTokens, signal: opts.signal, deadlineMs: opts.config.timeoutMs || DEFAULT_REVIEW_TIMEOUT_MS, sessionId })) {
              if (ev.type === "text.delta") {
                const chunk = (ev.data as { text?: string } | undefined)?.text ?? "";
                text += chunk;
                started = true;
                pushDelta(currentModel, index, chunk);
              } else if (ev.type === "reasoning.delta") {
                // Some free models (e.g. Cohere, Nemotron) produce thousands
                // of reasoning tokens before — or instead of — content. With
                // a limited token budget, a reasoning-heavy model can fill
                // the entire budget with chain-of-thought and never emit any
                // content, leaving `text` empty. Capture reasoning as a
                // fallback so the run doesn't failover when the model
                // genuinely produced an analysis — just in its thinking trace.
                const chunk = (ev.data as { text?: string } | undefined)?.text ?? "";
                reasoning += chunk;
                started = true;
              } else if (ev.type === "provider.started") {
                const genId = (ev.data as { generationId?: string } | undefined)?.generationId;
                if (genId) {
                  result.generationIds ??= {};
                  result.generationIds[reviewerKey] = genId;
                }
              } else if (ev.type === "provider.queued") {
                // OpenRouter sends PROCESSING keep-alives throughout the stream,
                // not just before the first token. Only surface the queued state
                // before any text has arrived — afterwards it's just noise.
                if (!started) pushQueued(currentModel, index);
              } else if (ev.type === "finish") {
                const data = ev.data as { generationId?: string; finishReason?: string } | undefined;
                const genId = data?.generationId;
                if (genId) {
                  result.generationIds ??= {};
                  result.generationIds[reviewerKey] = genId;
                }
                finishReason = data?.finishReason;
              } else if (ev.type === "error") {
                throw new Error((ev.data as { message?: string } | undefined)?.message ?? "Provider error");
              }
            }
          } catch (e) {
            attemptError = e instanceof Error ? e.message : String(e);
          }

          // If the model produced no content but did produce reasoning, use
          // the reasoning as the output — but ONLY when the model completed
          // normally (no error AND finish: stop). Reject when:
          //  - The stream errored (terminated/fetch failed/timeout): the
          //    reasoning was interrupted mid-thought and is incomplete.
          //  - finish: length: the model hit the token limit during reasoning
          //    (the trace is almost always incomplete or degenerate).
          //  - Degenerate: repetitive loop stuck on the same sentence.
          // In all rejected cases, trigger retry/failover instead of accepting
          // incomplete chain-of-thought as a reviewer output.
          if (!text.trim() && reasoning.trim().length > 200) {
            const degenerate = isDegenerate(reasoning);
            const truncated = finishReason === "length";
            if (!attemptError && !truncated && !degenerate) {
              text = `[NOTE: Model produced only reasoning (no content) — using reasoning trace as output.]\n\n${reasoning}`;
              pushDelta(currentModel, index, text);
            } else if (attemptError) {
              lastError = `Model produced only reasoning then stream errored (${attemptError}, ${reasoning.length} chars) — reasoning is incomplete`;
            } else if (truncated) {
              lastError = `Model hit token limit during reasoning (${reasoning.length} chars, finish: length) — reasoning is incomplete`;
            } else {
              lastError = `Model reasoning is degenerate/repetitive (${reasoning.length} chars) — not usable as output`;
            }
          }

          // Save partial text from a stream error as a fallback — but DON'T
          // accept it yet. Stream errors (JSON in SSE, fetch failed, timeout)
          // are transient infrastructure issues, not model failures. Retry
          // the same model first; only use the partial as a last resort if
          // all retries and spares are exhausted.
          if (attemptError && text.trim().length > 200 && !isToolCallOutput(text)) {
            partialOutput = { model: currentModel, text: text + `\n\n[NOTE: Reviewer stopped early: ${attemptError}]` };
            lastError = attemptError;
          }
          // Truncated output (finish: length) with non-empty text — don't
          // accept as success. Save as fallback and fall through to budget
          // escalation. A different model with the same budget will truncate
          // too, so retry the same model with a higher budget first.
          const truncated = finishReason === "length";
          if (!attemptError && truncated && text.trim().length > 0 && !isToolCallOutput(text)) {
            partialOutput = { model: currentModel, text };
            lastError = `Model output truncated (finish: length, ${text.length} chars) at maxTokens=${TOKEN_BUDGETS[tokenBudgetIdx]}`;
          }
          // Success (completed normally, not truncated) → accept, break.
          if (!attemptError && !truncated && text.trim().length > 0 && !isToolCallOutput(text)) {
            successModel = currentModel;
            successText = text;
            lastError = null;
            break;
          }
          // If the output was tool-call-like, set a specific error message.
          if (isToolCallOutput(text)) {
            lastError = `Model produced tool-call syntax instead of review content (${text.length} chars) — did not follow the review prompt`;
          }

          // No usable output this attempt — decide the retry strategy.
          lastError = lastError ?? attemptError ?? "No output — model returned empty response";
          const modelSpecific = isToolCallOutput(text) || (reasoning.trim().length > 200 && isDegenerate(reasoning));

          // Strategy 1: Truncation → raise token budget, retry same model.
          if (truncated && tokenBudgetIdx < TOKEN_BUDGETS.length - 1) {
            tokenBudgetIdx++;
            const newBudget = TOKEN_BUDGETS[tokenBudgetIdx];
            result.retries ??= [];
            result.retries.push({ model: currentModel, reviewerIndex: index, reason: lastError, maxTokens: newBudget });
            pushRetry(currentModel, index, lastError, newBudget);
            continue;
          }

          // Strategy 2: Transient failure (not model-specific) → retry same
          // model once with the same params.
          if (!modelSpecific && sameModelRetries < MAX_SAME_MODEL_RETRIES) {
            sameModelRetries++;
            result.retries ??= [];
            result.retries.push({ model: currentModel, reviewerIndex: index, reason: lastError, maxTokens: TOKEN_BUDGETS[tokenBudgetIdx] });
            pushRetry(currentModel, index, lastError, TOKEN_BUDGETS[tokenBudgetIdx]);
            continue;
          }

          // Strategy 3 & 4: Swap to a spare model (model-specific failure or
          // same-model retries exhausted).
          if (spareFailovers >= MAX_REVIEWER_FAILOVER) break;
          const spare = takeSpare();
          if (!spare) break;
          spareFailovers++;
          sameModelRetries = 0; // reset for the new model
          // Keep tokenBudgetIdx — if the prompt needs more tokens, the spare
          // needs them too. A concise spare may finish within the current
          // budget; a verbose one will have room.
          result.failovers ??= [];
          result.failovers.push({ from: currentModel, to: spare, reviewerIndex: index, reason: lastError });
          pushFailover(currentModel, spare, index, lastError);
          currentModel = spare;
        }

        // If all retries and spares failed but we have a partial output
        // from an earlier attempt, use it as a last resort rather than
        // recording an error — partial findings are better than none.
        if (!successModel && partialOutput) {
          successModel = partialOutput.model;
          successText = partialOutput.text;
        }
        // Persist the slot's outcome, keyed by the model that produced it.
        if (successModel) {
          result.rawOutputs[successModel] = successText;
        } else {
          result.rawOutputs[currentModel] = `[REVIEWER ERROR: ${lastError ?? "Unknown error"}]`;
        }
        await persist();
        return {
          model: successModel ?? currentModel,
          raw: successText,
          index,
          error: successModel ? (lastError ?? null) : (lastError ?? "Unknown error"),
        };
      });

    const allSettledPromise = Promise.allSettled(reviewerPromises);
    allSettledPromise.then(() => { reviewersDone = true; deltaNotify?.(); });

    // Yield deltas and queue events as they arrive until all reviewers settle.
    while (!reviewersDone) {
      if (deltaQueue.length === 0 && queuedQueue.length === 0 && failoverQueue.length === 0 && retryQueue.length === 0) {
        await new Promise<void>((r) => { deltaNotify = r; });
        deltaNotify = null;
      }
      while (queuedQueue.length > 0) {
        const q = queuedQueue.shift()!;
        yield { phase: "committee.queued", model: q.model, reviewerIndex: q.reviewerIndex, reviewerCount: reviewerIds.length };
      }
      while (retryQueue.length > 0) {
        const r = retryQueue.shift()!;
        yield { phase: "committee.retry", model: r.model, reviewerIndex: r.reviewerIndex, reviewerCount: reviewerIds.length, reason: r.reason, maxTokens: r.maxTokens };
      }
      while (failoverQueue.length > 0) {
        const f = failoverQueue.shift()!;
        yield { phase: "committee.failover", from: f.from, to: f.to, reviewerIndex: f.reviewerIndex, reviewerCount: reviewerIds.length, reason: f.reason };
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
    while (retryQueue.length > 0) {
      const r = retryQueue.shift()!;
      yield { phase: "committee.retry", model: r.model, reviewerIndex: r.reviewerIndex, reviewerCount: reviewerIds.length, reason: r.reason, maxTokens: r.maxTokens };
    }
    while (failoverQueue.length > 0) {
      const f = failoverQueue.shift()!;
      yield { phase: "committee.failover", from: f.from, to: f.to, reviewerIndex: f.reviewerIndex, reviewerCount: reviewerIds.length, reason: f.reason };
    }
    while (deltaQueue.length > 0) {
      const d = deltaQueue.shift()!;
      yield { phase: "committee.delta", model: d.model, reviewerIndex: d.reviewerIndex, text: d.text };
    }

    const settled = await allSettledPromise;
    // Reflect the actual model that served each slot — failover may have
    // swapped a failed primary for a spare. reviewerModels is indexed by
    // the original slot order so the UI/aggregator can attribute findings.
    const actualModels = [...reviewerIds];
    for (const s of settled) {
      if (s.status === "fulfilled") {
        actualModels[s.value.index] = s.value.model;
      }
    }
    result.reviewerModels = actualModels;
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
    const consolidatedFallback = consolidateReviewerTasks(fallbackTasks);

    // 5. Aggregator → strict JSON (streamed). Uses the same retry strategy
    //    as the reviewers: same-model retry first (with raised token budget
    //    for truncation), then spare-model failover as last resort.
    //    After LLM judges fail, a compact table-only attempt runs once; if
    //    that also fails, we use the deterministic consolidated fallback so
    //    the run still ends with a clean priority list.
    yield { phase: "aggregator", message: "Aggregating findings…", model: aggregatorModel };
    const aggPrompt = buildAggregatorPrompt(config, successfulOutputs, consolidatedFallback, aggregatorModel);
    const baseAggMessages: ProviderMessage[] = [
      { role: "system", content: AGGREGATOR_SYSTEM },
      { role: "user", content: aggPrompt },
    ];

    let aggRaw = "";
    let aggReasoning = "";
    let actualAggModel = aggregatorModel;
    let aggFinishReason: string | undefined;
    let aggError: string | null = null;
    let aggSuccess = false;
    let parsedTasks: ReviewTask[] = [];
    const MAX_AGGREGATOR_FAILOVER = 2;
    let aggTokenBudgetIdx = 0;
    let aggSameModelRetries = 0;
    let aggSpareFailovers = 0;
    let aggUseJsonNudge = false;

    while (true) {
      aggRaw = "";
      aggReasoning = "";
      aggFinishReason = undefined;
      aggError = null;
      let aggStarted = false;
      const aggKey = `aggregator:${actualAggModel}`;
      const aggMaxTokens = TOKEN_BUDGETS[aggTokenBudgetIdx];
      const attemptMessages: ProviderMessage[] = aggUseJsonNudge
        ? [
            ...baseAggMessages,
            {
              role: "assistant",
              content: "(previous attempt produced analysis without a parseable JSON tasks array)",
            },
            { role: "user", content: AGGREGATOR_JSON_NUDGE },
          ]
        : baseAggMessages;
      try {
        for await (const ev of provider.chat(attemptMessages, { model: actualAggModel, temperature: 0.2, maxTokens: aggMaxTokens, signal: opts.signal, deadlineMs: opts.config.timeoutMs || DEFAULT_REVIEW_TIMEOUT_MS, sessionId })) {
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
          } else if (ev.type === "provider.started") {
            const genId = (ev.data as { generationId?: string } | undefined)?.generationId;
            if (genId) {
              result.generationIds ??= {};
              result.generationIds[aggKey] = genId;
            }
          } else if (ev.type === "provider.queued") {
            // Suppress keep-alive queue events after output has started —
            // OpenRouter intersperses them between reasoning/text chunks.
            if (!aggStarted) yield { phase: "aggregator.queued", model: actualAggModel };
          } else if (ev.type === "finish") {
            const data = ev.data as { generationId?: string; finishReason?: string } | undefined;
            const genId = data?.generationId;
            if (genId) {
              result.generationIds ??= {};
              result.generationIds[aggKey] = genId;
            }
            aggFinishReason = data?.finishReason;
          } else if (ev.type === "error") {
            throw new Error((ev.data as { message?: string } | undefined)?.message ?? "Aggregator error");
          }
        }
      } catch (e) {
        aggError = e instanceof Error ? e.message : String(e);
      }

      // Try to parse JSON from content and/or reasoning. If the judge returned
      // valid JSON (even with an empty tasks array), we're done — {"tasks": []}
      // is a correct response when there are no findings to aggregate.
      // Only retry/failover when no JSON could be parsed at all.
      const parsed = parseAggregatorResponse(aggRaw, aggReasoning);
      if (parsed.parsed) {
        aggSuccess = true;
        parsedTasks = parsed.tasks;
        result.aggregatorOutput = aggRaw || (parsed.tasks.length ? JSON.stringify({ tasks: parsed.tasks }, null, 2) : '{"tasks":[]}');
        if (aggReasoning) result.aggregatorReasoning = aggReasoning;
        break;
      }

      // No JSON content. Determine why and decide the retry strategy.
      const truncated = aggFinishReason === "length";
      const degenerate = aggReasoning.trim().length > 200 && isDegenerate(aggReasoning);
      if (aggError) {
        aggError = `Aggregator stream errored${aggReasoning ? ` after ${aggReasoning.length} chars of reasoning` : ""}: ${aggError}`;
      } else if (truncated && !aggRaw.trim()) {
        aggError = `Aggregator hit token limit during reasoning (${aggReasoning.length} chars, finish: length) — no JSON emitted`;
      } else if (degenerate) {
        aggError = `Aggregator reasoning is degenerate/repetitive (${aggReasoning.length} chars) — no JSON emitted`;
      } else if (!aggRaw.trim() && aggReasoning.trim()) {
        aggError = `Aggregator produced ${aggReasoning.length} chars of reasoning but no JSON content`;
      } else if (!aggRaw.trim()) {
        aggError = "Aggregator returned empty output — no JSON emitted";
      } else {
        aggError = `Aggregator output did not parse as JSON (${aggRaw.length} chars)`;
      }

      // Strategy 1: Truncation → raise token budget, retry same model.
      if (truncated && aggTokenBudgetIdx < TOKEN_BUDGETS.length - 1) {
        aggTokenBudgetIdx++;
        aggUseJsonNudge = true; // after a truncation, demand JSON-only
        const newBudget = TOKEN_BUDGETS[aggTokenBudgetIdx];
        result.aggregatorRetries ??= [];
        result.aggregatorRetries.push({ model: actualAggModel, reason: aggError, maxTokens: newBudget });
        yield { phase: "aggregator.retry", model: actualAggModel, reason: aggError, maxTokens: newBudget };
        continue;
      }

      // Strategy 2: Transient / no-JSON failure → retry same model once with
      // a strict JSON-only nudge (more effective than replaying the huge prompt).
      if (!degenerate && aggSameModelRetries < MAX_SAME_MODEL_RETRIES) {
        aggSameModelRetries++;
        aggUseJsonNudge = true;
        result.aggregatorRetries ??= [];
        result.aggregatorRetries.push({ model: actualAggModel, reason: aggError, maxTokens: TOKEN_BUDGETS[aggTokenBudgetIdx] });
        yield { phase: "aggregator.retry", model: actualAggModel, reason: aggError, maxTokens: TOKEN_BUDGETS[aggTokenBudgetIdx] };
        continue;
      }

      // Strategy 3: Swap to a spare model.
      if (aggSpareFailovers >= MAX_AGGREGATOR_FAILOVER) break;
      const spare = takeAggSpare();
      if (!spare) break;
      aggSpareFailovers++;
      aggSameModelRetries = 0;
      aggUseJsonNudge = false; // fresh model gets the full prompt first
      result.aggregatorFailovers ??= [];
      result.aggregatorFailovers.push({ from: actualAggModel, to: spare, reason: aggError });
      yield { phase: "aggregator.failover", from: actualAggModel, to: spare, reason: aggError };
      actualAggModel = spare;
    }

    // Reflect the actual model that served the aggregator.
    result.aggregatorModel = actualAggModel;

    // Compact table-only LLM attempt when full-context judges all failed.
    if (!aggSuccess && consolidatedFallback.length > 0) {
      yield { phase: "aggregator", message: "Judges failed — compact re-aggregate from tables…", model: actualAggModel };
      const compactMessages: ProviderMessage[] = [
        { role: "system", content: AGGREGATOR_SYSTEM },
        { role: "user", content: buildCompactAggregatorPrompt(consolidatedFallback) },
      ];
      aggRaw = "";
      aggReasoning = "";
      try {
        for await (const ev of provider.chat(compactMessages, {
          model: actualAggModel,
          temperature: 0.1,
          maxTokens: TOKEN_BUDGETS[Math.min(aggTokenBudgetIdx, TOKEN_BUDGETS.length - 1)],
          signal: opts.signal,
          deadlineMs: opts.config.timeoutMs || DEFAULT_REVIEW_TIMEOUT_MS,
          sessionId,
        })) {
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
        const compactParsed = parseAggregatorResponse(aggRaw, aggReasoning);
        if (compactParsed.parsed) {
          aggSuccess = true;
          parsedTasks = compactParsed.tasks;
          result.aggregatorOutput = aggRaw || JSON.stringify({ tasks: compactParsed.tasks }, null, 2);
          if (aggReasoning) result.aggregatorReasoning = (result.aggregatorReasoning ?? "") + (result.aggregatorReasoning ? "\n\n" : "") + aggReasoning;
          result.aggregatorRetries ??= [];
          result.aggregatorRetries.push({
            model: actualAggModel,
            reason: "compact table-only re-aggregate after judge failure",
            maxTokens: TOKEN_BUDGETS[Math.min(aggTokenBudgetIdx, TOKEN_BUDGETS.length - 1)],
          });
        }
      } catch {
        // Fall through to deterministic consolidate.
      }
    }

    // If we never got parseable JSON, keep whatever content we have for debug
    // and use the deterministic consolidated fallback for the task list.
    if (!aggSuccess) {
      result.aggregatorOutput = aggRaw;
      if (aggReasoning) result.aggregatorReasoning = aggReasoning;
    }

    let tasks: ReviewTask[];
    if (aggSuccess) {
      // Trust the judge, including {"tasks": []} — do NOT overwrite with tables.
      tasks = parsedTasks;
      result.taskListSource = "aggregator";
    } else {
      yield { phase: "parse", message: "Judge produced no JSON — using consolidated reviewer tables…" };
      tasks = consolidatedFallback;
      result.taskListSource = "fallback";
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

    // Fetch actual generation metadata from OpenRouter — reveals failover
    // (requested gemma → got cohere) and auto-router decisions (auto → GPT-5.6).
    await enrichWithGenerationMetadata(result, provider);

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

  // In upload mode, the "reviewer ids" are pasted names (not real model ids),
  // so pickAutoAggregator can't classify them by tier. Use the config's
  // modelTier instead: free tier → openrouter/free (best free model);
  // otherwise openrouter/auto (best paid model).
  if (isAutoAggregator(aggregatorModel)) {
    if (config.modelTier === "free") {
      aggregatorModel = "openrouter/free";
    } else {
      aggregatorModel = "openrouter/auto";
    }
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
    const consolidatedFallback = consolidateReviewerTasks(fallbackTasks);

    // 2. Aggregator → strict JSON (streamed). Upload path is single-shot;
    //    on failure we still return a clean consolidated table list.
    yield { phase: "aggregator", message: "Aggregating findings…", model: aggregatorModel };
    const aggPrompt = buildAggregatorPrompt(config, reviewerOutputs, consolidatedFallback, aggregatorModel);
    const aggMessages: ProviderMessage[] = [
      { role: "system", content: AGGREGATOR_SYSTEM },
      { role: "user", content: aggPrompt },
    ];
    let aggRaw = "";
    let aggReasoning = "";
    let aggStarted = false;
    const aggKey = `aggregator:${aggregatorModel}`;
    for await (const ev of provider.chat(aggMessages, { model: aggregatorModel, temperature: 0.2, maxTokens: 16384, signal: opts.signal, deadlineMs: opts.config.timeoutMs || DEFAULT_REVIEW_TIMEOUT_MS, sessionId })) {
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
      } else if (ev.type === "provider.started") {
        const genId = (ev.data as { generationId?: string } | undefined)?.generationId;
        if (genId) {
          result.generationIds ??= {};
          result.generationIds[aggKey] = genId;
        }
      } else if (ev.type === "provider.queued") {
        // Suppress keep-alive queue events after output has started —
        // OpenRouter intersperses them between reasoning/text chunks.
        if (!aggStarted) yield { phase: "aggregator.queued", model: aggregatorModel };
      } else if (ev.type === "finish") {
        const genId = (ev.data as { generationId?: string } | undefined)?.generationId;
        if (genId) {
          result.generationIds ??= {};
          result.generationIds[aggKey] = genId;
        }
      } else if (ev.type === "error") {
        throw new Error((ev.data as { message?: string } | undefined)?.message ?? "Aggregator error");
      }
    }

    result.aggregatorOutput = aggRaw;
    if (aggReasoning) result.aggregatorReasoning = aggReasoning;
    const parsed = parseAggregatorResponse(aggRaw, aggReasoning);
    let tasks: ReviewTask[];
    if (parsed.parsed) {
      tasks = parsed.tasks;
      result.taskListSource = "aggregator";
      if (!aggRaw.trim() && parsed.tasks.length > 0) {
        result.aggregatorOutput = JSON.stringify({ tasks: parsed.tasks }, null, 2);
      }
    } else {
      yield { phase: "parse", message: "Judge produced no JSON — using consolidated reviewer tables…" };
      tasks = consolidatedFallback;
      result.taskListSource = "fallback";
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

    // Fetch actual generation metadata from OpenRouter (same as full review).
    await enrichWithGenerationMetadata(result, provider);

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
