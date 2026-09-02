import type {
  AgentEvent,
  AgentEventType,
  ChatMessage,
  ProviderMessage,
  ProviderTool,
  ProviderEvent,
  ProviderTextDelta,
  ToolCall,
  ToolResult,
  ToolContext,
} from "../../types.js";
import type { LLMProvider } from "./provider.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { AgentSession } from "./session.js";
import { estimateTotalTokens, pruneContext, truncateToolContent } from "./context.js";
import { buildWorkspaceSnapshot } from "./snapshot.js";
import type { Workspace } from "../workspace.js";
import {
  buildClassifyPrompt,
  parseClassifyResponse,
  buildEditPrompt,
  parseEditResponse,
  exceedsEditBudget,
  type FileContent,
} from "./single-shot.js";
import { verifyEditedFile } from "./verify.js";
import { L2_CACHEABLE_TOOLS } from "./workspace-cache.js";
import { classifyTask, routeModel, DEFAULT_ROUTER_SETTINGS, type RouterSettings } from "../router/index.js";
import { modelRegistry } from "../registry/index.js";
import { isCorrectionMessage, detectOutcome, OUTCOME_WEIGHTS } from "../learn/outcome.js";
import { learnedStats, routeWithLearning, seededRng } from "../learn/index.js";
import { telemetryStore, type ActiveTask } from "../telemetry/index.js";
import type { RequestType } from "../telemetry/types.js";
import type { TaskSummaryData } from "../../types.js";

const MAX_ITERATIONS = 10;
/** Max consecutive read-only (exploration) iterations before a plan-or-act nudge. */
const MAX_EXPLORATION_ITERATIONS = 3;
/** Read-only / non-productive tools that count as "exploration" for the cap.
 *  Includes execute_command and run_tests because a model that spends all
 *  iterations running version checks and launch tests without writing any
 *  files is effectively exploring, not implementing. */
const READ_ONLY_TOOLS = new Set([
  "read_file", "list_files", "list_symbols", "search_files", "git_status", "git_diff",
  "execute_command", "run_tests",
]);
/** Consecutive error iterations at the cap that indicate the model is stuck
 *  (not merely slow). Used by the D9 budget guard to decide whether the
 *  summary turn should be a continuation nudge (one more chance to finish)
 *  vs. a plain text summary. */
const STUCK_ERROR_THRESHOLD = 2;

/**
 * Compute a normalized hash key for the B1 repeat-failure guard. For tools
 * whose args contain large text blobs (apply_patch patch, write_file/create_file
 * content), trailing whitespace is trimmed before hashing so a model can't
 * evade the guard by adding a trailing newline or spaces to an otherwise
 * identical failed call. The normalization is conservative — only trailing
 * whitespace is touched, so genuinely different calls still hash differently.
 */
export function argsHashKey(toolName: string, args: Record<string, unknown>): string {
  const normalized: Record<string, unknown> = { ...args };
  if (typeof normalized.patch === "string") {
    normalized.patch = normalized.patch.replace(/\s+$/g, "");
  }
  if (typeof normalized.content === "string") {
    normalized.content = normalized.content.replace(/\s+$/g, "");
  }
  return `${toolName}:${JSON.stringify(normalized)}`;
}

/**
 * Detect whether an apply_patch error is a *format* problem (the model
 * structured the patch wrong) vs. a content/hash problem (the patch is
 * well-formed but doesn't match the file). Format errors benefit from a
 * directive hint showing the correct structure and the write_file fallback,
 * because weak models often know the fix but can't get SEARCH/REPLACE
 * syntax right and burn their whole budget retrying malformed patches.
 */
export function isApplyPatchFormatError(errorMsg: string): boolean {
  return (
    errorMsg.includes("no REPLACE section") ||
    errorMsg.includes("No valid SEARCH/REPLACE blocks") ||
    errorMsg.includes("SEARCH block not found")
  );
}

const APPLY_PATCH_FORMAT_HINT =
  '\n\nFORMAT HINT — apply_patch needs SEARCH/REPLACE markers. Correct structure:\nSEARCH\n<exact original lines copied from read_file output>\nREPLACE\n<the new lines to put in their place>\n---\nTo DELETE lines, use an empty REPLACE section.\nIf you keep getting the format wrong, use write_file instead — pass the ENTIRE corrected file content plus the hash from your last read_file. write_file does NOT need SEARCH/REPLACE markers.';

const SYSTEM_PROMPT = `You are AdaanIDE, an autonomous coding agent integrated into a development IDE.
You can read, write, search, and execute commands in the user's workspace.

CRITICAL RULES:
- NEVER ask clarifying questions. Make reasonable assumptions and act on them. It is far better to attempt the task and get it slightly wrong than to ask the user for clarification — they chose an autonomous agent because they want action, not a conversation.
- Focus on the user's CURRENT request. Do not re-attempt previously failed tasks from earlier in the conversation unless the user explicitly asks you to.
- If you don't already know the relevant files from this conversation, explore first with list_files/list_symbols/search_files.
- If the user confirmed a proposed change ("yes", "do it", "fix it", "continue"), apply it immediately — do not re-explore or re-explain.
- When editing existing files, always read the file first to get its hash, then use apply_patch with the expectedHash.
- apply_patch REQUIRES SEARCH/REPLACE markers. The SEARCH section must contain the EXACT original lines (copied from read_file output), and REPLACE contains the new lines. Do NOT send bare replacement code without markers — it will be rejected. Format:
  SEARCH
  <exact original lines from the file>
  REPLACE
  <new lines to put in their place>
  ---
  SEARCH
  <another block's original lines>
  REPLACE
  <new lines>
  To delete lines, use an empty REPLACE section.
- execute_command runs from the workspace root — do NOT cd to other directories (e.g. /home/user). Just run the command directly (e.g. "python3 algos.py", not "cd /home/user && python3 algos.py").
- When creating new files, use create_file with the path AND content arguments in a single call. Do NOT create an empty file and then write to it — pass the full content directly to create_file.
- When asked to code, build, or implement an app, game, component, or algorithm, complete the ENTIRE implementation. Write all required files (HTML, CSS, JS, Svelte, components, tests, etc.) to disk. Do not stop after only listing files or creating directories.
- NEVER output full file contents as markdown code blocks in chat. ALWAYS use create_file or apply_patch to write code directly to disk.
- If a file you just created or edited turns out wrong or corrupted (e.g. broken syntax, wrong design), fix it with write_file (using the hash from read_file) or apply_patch — NEVER use delete_file to "start over". delete_file requires user approval and interrupts the flow; overwriting does not and is always the right tool for correcting your own mistakes.
- Run tests after making changes to verify your work.
- Use git_checkpoint before risky changes.
- Be concise in your explanations. Show the user what you're doing via tool calls.
- After running execute_command or run_tests, always quote the relevant stdout/stderr in your final reply — the user cannot see raw tool payloads unless they expand a card. Never finish a turn with only tool calls and no text.
- NEVER claim success when tool output shows failure. Read command output and test results carefully. If output contains "failed", "error", "✗", "Match: False", "traceback", or a non-zero exit code, report the failure honestly and attempt to fix it.
- If a tool call fails, read the error message carefully and fix the issue — do not give up or ask the user for help.
- NEVER end your response with "Would you like me to..." or "Do you want me to..." or similar offers. Just do the next logical thing. The user will tell you if they want something different.
- NEVER announce an action ("I'll create...", "I'll add...", "Let me write...") without immediately following through with the corresponding tool call in the same response. If you say you're going to do something, DO it — do not describe the plan and then stop.
- NEVER use pkill, killall, or kill to terminate processes you did not start yourself. These commands kill ALL matching processes on the machine, including the user's own dev servers, IDE processes, and other unrelated work. If you need to stop a process you started, track its PID and kill that specific PID only.
- NEVER try to start long-lived servers (npm run dev, vite, python -m http.server, etc.) via execute_command. Background processes started by execute_command do not persist beyond the tool call, so the server will be dead before the user can open it. Instead, tell the user to run the command themselves in their terminal.
- When creating a Vite-based project, ALWAYS set \`server: { host: '127.0.0.1' }\` in vite.config.js. Node.js 18+ binds to IPv6 (::1) by default, but most browsers resolve localhost to IPv4 (127.0.0.1) first — without this setting the user gets ERR_CONNECTION_REFUSED even though vite says it's ready.`;

export interface EngineOptions {
  provider: LLMProvider;
  registry: ToolRegistry;
  maxIterations?: number;
  systemPrompt?: string;
  /** Phase B: optional tool filter — when set, only these tool schemas are
   *  exposed to the model. Used by the benchmark runner to test edit-format
   *  variants (e.g. excluding apply_patch to force write_file). Does NOT
   *  mutate the shared registry. */
  tools?: string[];
}

export class AgentEngine {
  private provider: LLMProvider;
  private registry: ToolRegistry;
  maxIterations: number;
  private systemPrompt: string;
  /** Phase B: optional tool filter — only these tools are exposed to the model. */
  private toolFilter: string[] | undefined;
  /** Phase C: single-shot mode — "auto" (local only), "always", "never". */
  singleShotMode: "auto" | "always" | "never" = "auto";
  /** Phase D: when set, the next provider request uses this compact case
   *  file instead of the full conversation history. Cleared after one use. */
  private caseFileOverride: ProviderMessage[] | null = null;
  /** Phase 3: adaptive router settings. */
  routerSettings: RouterSettings = DEFAULT_ROUTER_SETTINGS;
  /** Phase 4: whether paid-model exploration is allowed (default off). */
  explorationPaidEnabled = false;

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
    this.systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
    this.toolFilter = opts.tools;
  }

  /** Phase 6: derive the economic regime for a task from the active provider
   *  and model id. Local endpoint → "local"; free-tier slug (`:free`) → "free";
   *  anything else on the default OpenRouter endpoint → "paid". */
  private deriveRegime(model: string): "paid" | "free" | "local" {
    const p = this.provider as {
      isLocalModel?: (m: string) => boolean;
      hasCustomBaseUrl?: () => boolean;
    };
    if (p.isLocalModel?.(model)) return "local";
    // A custom primary baseUrl with no local endpoint mapping means every
    // request goes to a local-compatible server → treat as local.
    if (p.hasCustomBaseUrl?.()) return "local";
    return model.endsWith(":free") ? "free" : "paid";
  }

  /** Phase 6: best-effort provider id for telemetry. Falls back to "openrouter". */
  private deriveProvider(model: string): string {
    const p = this.provider as { isLocalModel?: (m: string) => boolean; hasCustomBaseUrl?: () => boolean };
    if (p.isLocalModel?.(model) || p.hasCustomBaseUrl?.()) return "local";
    return "openrouter";
  }

  /**
   * Run the agent loop for a session.
   * Emits events to the provided callback as an async generator.
   */
  async *run(
    session: AgentSession,
    workspace: import("../workspace.js").Workspace,
    userMessage: string,
    model: string | undefined,
    contextLength: number,
    experiment?: { name: string; arm: string } | null,
  ): AsyncIterable<AgentEvent> {
    // A turn may start without an explicit model (manual routing, nothing
    // selected). Resolve that to the provider's default pick up front so the
    // rest of the loop — telemetry, status lines, provider requests — always
    // works with a concrete model id.
    if (!model) {
      model = ((this.provider as { pickModel?: () => string }).pickModel?.() ?? "") || "auto";
    }
    const emit = (type: AgentEvent["type"], data?: unknown): AgentEvent => {
      const event: AgentEvent = {
        type,
        sessionId: session.id,
        data,
        timestamp: Date.now(),
      };
      return event;
    };

    // Add user message to session (works for both new sessions and follow-ups)
    session.resume();

    // Clean up orphaned assistant messages from an abandoned previous turn.
    // If the previous run() was interrupted mid-tool-execution, the session
    // may end with an assistant message containing tool_calls but no
    // corresponding tool-result messages. Sending that malformed sequence
    // to the provider causes empty responses or rejections on the next turn.
    this.cleanupOrphanedToolCalls(session);

    // This is the active turn now — clear the superseded flag that
    // resume() may have set to signal the previous generator to exit.
    session.superseded = false;

    session.messages.push({ role: "user", content: userMessage });

    // --- Telemetry: begin tracking this user task ---------------------------
    await telemetryStore.load();

    // Phase 4: detect correction of the previous task in this session.
    // If the previous task ended < 5 min ago and this message matches a
    // correction pattern, relabel the previous task's outcome to "corrected".
    const prevTask = telemetryStore.getLastTaskInSession(session.id);
    if (prevTask && prevTask.status === "success") {
      const elapsed = Date.now() - (prevTask.timestamp + prevTask.durationMs);
      if (elapsed < 5 * 60_000 && isCorrectionMessage(userMessage)) {
        telemetryStore.relabelOutcome(prevTask.taskId, "corrected");
      }
    }

    const requestedModel = model;
    const task = telemetryStore.startTask(session.id, model, userMessage, {
      regime: this.deriveRegime(model),
      provider: this.deriveProvider(model),
      requestedModel,
      experiment: experiment ?? null,
    });
    let taskStatus: "success" | "error" | "cancelled" = "success";
    let taskFinalized = false;

    // --- Phase 3: adaptive routing — if model is "auto", classify the task
    // and route to the cheapest model likely to succeed. 100% local. ---
    let routedBy: "auto" | "manual" = "manual";
    if (model === "auto") {
      try {
        await modelRegistry.load();
        await modelRegistry.refresh();
        await learnedStats.load();
        const cls = classifyTask(userMessage);
        // Phase 4: try learned policy first (Thompson sampling), fall back
        // to Phase 3's threshold rule when samples < 3.
        let route = routeWithLearning(
          cls, modelRegistry, this.routerSettings, learnedStats,
          seededRng(Date.now() & 0xffffffff),
          { explorationPaidEnabled: this.explorationPaidEnabled },
        );
        if (!route) {
          route = routeModel(cls, modelRegistry, this.routerSettings);
        }
        if (route) {
          model = route.model;
          routedBy = "auto";
          task.routedBy = "auto";
          task.category = route.category;
          yield emit("model.routed", {
            model: route.model,
            category: route.category,
            reason: route.reason,
            classification: {
              complexity: route.classification.complexity,
              coding: route.classification.coding,
              reasoning: route.classification.reasoning,
            },
          });
        } else {
          // Router returned null (manual mode or no models) — fall back to
          // the provider's default model selection.
          model = (this.provider as { pickModel?: () => string }).pickModel?.() ?? model;
        }
      } catch {
        // Routing is best-effort — don't fail the task if it errors.
        model = (this.provider as { pickModel?: () => string }).pickModel?.() ?? model ?? "auto";
      }
    }
    // Re-derive regime now that routing may have changed the effective model.
    task.regime = this.deriveRegime(model);
    task.provider = this.deriveProvider(model);

    // E2: pre-flight scope check — if the effective regime is "local" and
    // the task category is complex (refactor/greenfield) or multiFile signal
    // is high, emit a scope warning. When routing mode is auto and non-local
    // tiers are allowed, prefer the cloud free tier for these tasks — a 4B
    // local model will likely burn iterations without completing.
    {
      const scopeCls = classifyTask(userMessage);
      const isComplexCategory = scopeCls.category === "refactor" || scopeCls.category === "greenfield";
      const isMultiFile = scopeCls.multiFile > 0.5;
      if (task.regime === "local" && (isComplexCategory || isMultiFile)) {
        const reason = isComplexCategory
          ? `Task category "${scopeCls.category}" is likely too complex for a local model`
          : `Task touches multiple files (multiFile=${scopeCls.multiFile.toFixed(2)}), likely too complex for a local model`;
        yield emit("scope.warning", { reason });
        // When auto-routing with non-local options available, prefer cloud.
        if (
          this.routerSettings.mode === "auto" &&
          this.routerSettings.allowedTiers.length > 1 &&
          task.regime === "local"
        ) {
          // Try to find a free-tier cloud model that's tools-capable.
          try {
            const freeModels = modelRegistry.byTier("free").filter((e) => e.toolsCapable);
            if (freeModels.length > 0) {
              const oldModel = model;
              model = freeModels[0].id;
              task.regime = this.deriveRegime(model);
              task.provider = this.deriveProvider(model);
              yield emit("model.routed", {
                model,
                category: scopeCls.category,
                reason: `${reason}; rerouted to cloud free tier`,
                classification: {
                  complexity: scopeCls.complexity,
                  coding: scopeCls.coding,
                  reasoning: scopeCls.reasoning,
                },
              });
            }
          } catch {
            // Registry not loaded — skip rerouting, just emit the warning.
          }
        }
      }
    }
    const finalizeTask = (): TaskSummaryData => {
      if (taskFinalized) return {} as TaskSummaryData;
      taskFinalized = true;

      // Phase 4: detect outcome from test results.
      if (taskStatus === "success" && task.testResults.length > 0) {
        const outcome = detectOutcome(task.testResults);
        task.outcome = outcome;
      }
      // D12: when the task ended in error (e.g. stuck in tool errors at the
      // iteration cap), the outcome must reflect failure — not the default
      // "silent" (weight 0.7) which the learning system would interpret as
      // a weak positive signal. Respect monotonicity: never downgrade
      // verified/accepted (which would only happen if tests passed but
      // later iterations errored — extremely unlikely since a passing test
      // run resets consecutiveErrors, but guard against it anyway).
      if (taskStatus === "error" && task.outcome !== "verified" && task.outcome !== "accepted") {
        task.outcome = "rejected";
      }

      const rec = telemetryStore.finishTask(task, taskStatus);

      // Phase 4: record into learned model stats.
      if (rec.category && rec.status === "success") {
        try {
          learnedStats.record(
            rec.category,
            rec.model,
            OUTCOME_WEIGHTS[rec.outcome as keyof typeof OUTCOME_WEIGHTS] ?? 0.7,
            rec.day,
          );
        } catch {
          // best-effort learning
        }
      }

      return {
        requestCount: rec.requestCount,
        toolCalls: rec.toolCalls,
        cacheHits: rec.cacheHits,
        inputTokens: rec.inputTokens,
        outputTokens: rec.outputTokens,
        cost: rec.cost,
        durationMs: rec.durationMs,
        status: rec.status,
        truncationTokensSaved: rec.truncationTokensSaved,
        compactionTokensSaved: rec.compactionTokensSaved,
        redundantCallsAvoided: rec.redundantCallsAvoided,
        routedBy: rec.routedBy,
        category: rec.category,
        escalations: rec.escalations,
      };
    };

    try {
      // Phase C: single-shot pipeline for weak-tier models. Check whether
      // single-shot mode should be used for this task's regime.
      const useSingleShot =
        this.singleShotMode === "always" ||
        (this.singleShotMode === "auto" && task.regime === "local");

      if (useSingleShot) {
        let singleShotHandled = false;
        for await (const ev of this.runSingleShotPipeline(session, workspace, userMessage, model, task)) {
          yield ev;
          if (ev.type === "done") {
            singleShotHandled = true;
          }
        }
        // If the pipeline emitted "done", the task is complete.
        if (singleShotHandled || (task as any)._singleShotDone) {
          taskStatus = "success";
          yield emit("task.summary", finalizeTask());
          return;
        }
        // Otherwise, fall through to the normal ReAct loop.
      }

      let iteration = 0;
      let consecutiveErrors = 0;  // Phase 3: escalation trigger
      let consecutiveReadonlyIters = 0;  // exploration cap
      // D9: dynamic iteration budget. When the model hits the cap while
      // stuck in errors on an action request, we grant a small bonus so it
      // gets a real tool-capable turn to recover (the "one tool call away
      // from finishing" failure mode). The bonus fires at most once per task.
      let effectiveMaxIterations = this.maxIterations;
      let continuationBonusUsed = false;

      while (iteration < effectiveMaxIterations) {
        // If a new turn superseded this one (session.resume() was called
        // by another engine.run() invocation), exit silently — the new
        // generator owns the session now. Emitting cancelled/error here
        // would clobber the new turn's UI.
        if (session.superseded) {
          finalizeTask();
          return;
        }
        if (session.isCancelled()) {
          yield emit("cancelled");
          return;
        }

        // Build provider messages from session
        let providerMessages: ProviderMessage[];
        if (this.caseFileOverride) {
          // Phase D: use the compact case file for the first request after
          // escalation, then resume normal history building.
          providerMessages = this.caseFileOverride;
          this.caseFileOverride = null;
        } else {
          providerMessages = this.buildProviderMessages(session);
        }

        // A3: inject a workspace snapshot on the first request of the session
        // (when no assistant message has been sent yet). This kills the common
        // "exploration" request where the model calls list_files just to orient.
        // E1: the snapshot is appended to the first USER message (not the
        // system prompt) so the system prompt stays constant and benefits
        // from prefix-cache reuse on local servers (Rapid-MLX caches on
        // identical prefixes). Qwen chat templates accept long user messages
        // fine.
        const hasAssistantMsg = session.messages.some((m) => m.role === "assistant");
        if (!hasAssistantMsg && !task.snapshotInjected) {
          try {
            const snapshot = await buildWorkspaceSnapshot(workspace);
            if (snapshot) {
              // Find the first user message in providerMessages (index 0
              // is the system prompt).
              const firstUserIdx = providerMessages.findIndex(
                (m) => m.role === "user",
              );
              if (firstUserIdx >= 0) {
                providerMessages[firstUserIdx] = {
                  ...providerMessages[firstUserIdx],
                  content:
                    providerMessages[firstUserIdx].content +
                    `\n\nWorkspace snapshot (do not call list_files if this already answers your question):\n${snapshot}`,
                };
              }
              task.snapshotInjected = true;
            }
          } catch {
            // snapshot is best-effort — don't fail the request if it errors
          }
        }

        // Prune if approaching context limit (A2: turn-aware + compaction)
        const rawContextTokens = estimateTotalTokens(providerMessages);
        let prunedThisIteration = 0;
        if (rawContextTokens > contextLength - 2000) {
          const { messages: pruned, prunedCount, compactedTokensSaved } = pruneContext(providerMessages, contextLength);
          providerMessages = pruned;
          prunedThisIteration = prunedCount;
          if (compactedTokensSaved > 0) {
            task.compactionTokensSaved += compactedTokensSaved;
          }
          if (prunedCount > 0) {
            yield emit("context.pruned", { prunedCount, remainingTokens: contextLength - estimateTotalTokens(pruned) });
          }
        }
        const actualContextTokens = estimateTotalTokens(providerMessages);

        // Classify this request from the task's running state.
        const requestType: RequestType = telemetryStore.classifyRequest(task);
        const requestStart = Date.now();

        // Get tools — apply optional tool filter (Phase B: benchmark experiments)
        const allSchemas = this.registry.allSchemas as ProviderTool[];
        const tools: ProviderTool[] = this.toolFilter
          ? allSchemas.filter((t) => this.toolFilter!.includes(t.function.name))
          : allSchemas;

        // Call provider
        let assistantContent = "";
        let assistantReasoning = "";
        let assistantToolCalls: ToolCall[] = [];
        let finishReason: string = "stop";
        let modelUsed = model;
        let capturedUsage: {
          inputTokens: number;
          outputTokens: number;
          cachedTokens: number;
          reasoningTokens: number;
          cost: number;
        } | undefined;

        const toolCallArgs: Map<number, { id: string; name: string; args: string }> = new Map();

        // Synthetic progress: tell the UI which iteration/model we're about
        // to request. Cleared on the first real token (see text.delta below).
        const iterationLabel = iteration + 1;
        yield emit("status", {
          message: `iteration ${iterationLabel} → requesting ${model}…`,
          iteration: iterationLabel,
          model,
        });
        let streamingStarted = false;

        try {
          const providerStream = withHeartbeat(
            this.provider.chat(providerMessages, {
              model,
              tools,
              signal: session.abortController.signal,
            }),
            HEARTBEAT_INTERVAL_MS,
            session.abortController.signal,
          );
          for await (const event of providerStream) {
            // Heartbeat marker — the provider is silent. Surface it as a
            // progress event so the UI can show "Working… Ns".
            if (event && (event as Heartbeat).__heartbeat) {
              const hb = event as Heartbeat;
              if (session.superseded) {
                finalizeTask();
                return;
              }
              if (session.isCancelled()) {
                taskStatus = "cancelled";
                yield emit("cancelled");
                yield emit("task.summary", finalizeTask());
                return;
              }
              yield emit("progress", {
                elapsedMs: hb.elapsedMs,
                phase: streamingStarted ? "streaming" : "requesting",
              });
              continue;
            }
            const ev = event as ProviderEvent;
            switch (ev.type) {
              case "provider.queued": {
                // OpenRouter keep-alive — the model is queued at the
                // provider. A genuine alive signal, distinct from a stall.
                yield emit("progress", {
                  elapsedMs: Date.now() - requestStart,
                  phase: "queued",
                });
                break;
              }
              case "text.delta": {
                const data = ev.data as { text: string };
                assistantContent += data.text;
                if (!streamingStarted) {
                  streamingStarted = true;
                  // First real token — clear the "waiting" status line.
                  yield emit("status", { message: "", iteration: iterationLabel, model });
                }
                yield emit("text.delta", { text: data.text });
                break;
              }
              case "reasoning.delta": {
                const data = ev.data as { text: string };
                assistantReasoning += data.text;
                if (!streamingStarted) {
                  streamingStarted = true;
                  // Reasoning is a genuine alive signal too — clear the
                  // "waiting" status line so the UI shows the thought block
                  // instead of "Working… Ns".
                  yield emit("status", { message: "", iteration: iterationLabel, model });
                }
                yield emit("reasoning.delta", { text: data.text });
                break;
              }
              case "tool_call.start": {
                const data = ev.data as { toolCallId: string; toolName: string; index: number };
                toolCallArgs.set(data.index, { id: data.toolCallId, name: data.toolName, args: "" });
                yield emit("tool.start", { toolCallId: data.toolCallId, toolName: data.toolName });
                break;
              }
              case "tool_call.args.delta": {
                const data = ev.data as { index: number; delta: string };
                const acc = toolCallArgs.get(data.index);
                if (acc) acc.args += data.delta;
                break;
              }
              case "tool_call.complete": {
                const data = ev.data as { index: number; toolCallId: string; toolName: string; arguments: string };
                // D19: normalize empty/malformed arguments to "{}" so the
                // stored ToolCall is always valid JSON. Some free models
                // (e.g. cohere/north-mini-code) emit an empty string or
                // malformed JSON as tool arguments. If we store it as-is,
                // the next provider request sends the malformed arguments
                // back, causing a 400: "tool arguments must be a stringified
                // JSON object". Normalizing here ensures the stored call is
                // always provider-safe.
                let normalizedArgs = data.arguments;
                if (!normalizedArgs || !normalizedArgs.trim()) {
                  normalizedArgs = "{}";
                } else {
                  try {
                    JSON.parse(normalizedArgs);
                  } catch {
                    // Malformed JSON — normalize to "{}" so the stored call
                    // doesn't poison the next request. The tool execution
                    // loop below will emit a tool.error for the malformed
                    // args, giving the model a chance to retry.
                    normalizedArgs = "{}";
                  }
                }
                const tc: ToolCall = {
                  id: data.toolCallId,
                  type: "function",
                  function: { name: data.toolName, arguments: normalizedArgs },
                };
                assistantToolCalls.push(tc);

                // Parse args and emit
                let parsedArgs: Record<string, unknown> = {};
                try {
                  parsedArgs = JSON.parse(normalizedArgs);
                } catch {
                  // malformed args — will be handled as tool error below
                }
                yield emit("tool.args", { toolCallId: data.toolCallId, args: parsedArgs });
                break;
              }
              case "finish": {
                const data = ev.data as { finishReason: string; model: string; usage?: {
                  inputTokens: number;
                  outputTokens: number;
                  cachedTokens: number;
                  reasoningTokens: number;
                  cost: number;
                } };
                finishReason = data.finishReason;
                modelUsed = data.model;
                if (data.usage) capturedUsage = data.usage;
                yield emit("model.used", { modelId: data.model, modelName: data.model });
                break;
              }
              case "model.fallback": {
                const data = ev.data as { from: string; to: string; reason: string };
                // The provider switched models mid-request (429/503 failover).
                // Update the task's effective model so telemetry records the
                // model that actually produced the reply, not the one the user
                // originally picked.
                task.model = data.to;
                task.regime = this.deriveRegime(data.to);
                task.fallbacks++;
                yield emit("model.fallback", data);
                break;
              }
              case "model.retry": {
                const data = ev.data as { model: string; reason: string };
                task.retries++;
                yield emit("model.retry", data);
                break;
              }
              case "error": {
                if (session.superseded) {
                  finalizeTask();
                  return;
                }
                if (session.isCancelled()) {
                  taskStatus = "cancelled";
                  yield emit("cancelled");
                  yield emit("task.summary", finalizeTask());
                  return;
                }
                const data = ev.data as {
                  message: string;
                  allFreeModelsExhausted?: boolean;
                  triedModels?: string[];
                };
                // The provider attempted at least one request that failed —
                // record it so it counts against the daily request budget.
                telemetryStore.recordRequest(task, {
                  model: modelUsed,
                  requestType,
                  contextTokens: actualContextTokens,
                  rawContextTokens,
                  prunedMessages: prunedThisIteration,
                  iteration,
                  latencyMs: Date.now() - requestStart,
                  inputTokens: capturedUsage?.inputTokens ?? 0,
                  outputTokens: capturedUsage?.outputTokens ?? 0,
                  cachedTokens: capturedUsage?.cachedTokens ?? 0,
                  reasoningTokens: capturedUsage?.reasoningTokens ?? 0,
                  cost: capturedUsage?.cost ?? 0,
                  success: false,
                });
                // If every free model we tried is currently unavailable,
                // give the user the option to fall back to a paid model
                // instead of just reporting a dead end.
                if (data.allFreeModelsExhausted) {
                  taskStatus = "error";
                  yield emit("model.free_exhausted", {
                    message: data.message,
                    triedModels: data.triedModels ?? [],
                  });
                } else {
                  taskStatus = "error";
                  yield emit("error", { message: data.message });
                }
                yield emit("task.summary", finalizeTask());
                session.status = "error";
                return;
              }
            }
          }
        } catch (e: any) {
          // The request was sent to the provider even though it threw — it
          // still counts against OpenRouter's daily cap, so record it.
          telemetryStore.recordRequest(task, {
            model: modelUsed,
            requestType,
            contextTokens: actualContextTokens,
            rawContextTokens,
            prunedMessages: prunedThisIteration,
            iteration,
            latencyMs: Date.now() - requestStart,
            inputTokens: capturedUsage?.inputTokens ?? 0,
            outputTokens: capturedUsage?.outputTokens ?? 0,
            cachedTokens: capturedUsage?.cachedTokens ?? 0,
            reasoningTokens: capturedUsage?.reasoningTokens ?? 0,
            cost: capturedUsage?.cost ?? 0,
            success: false,
          });
          if (session.superseded) {
            finalizeTask();
            return;
          }
          if (session.isCancelled()) {
            taskStatus = "cancelled";
            yield emit("cancelled");
            yield emit("task.summary", finalizeTask());
            return;
          }
          taskStatus = "error";
          yield emit("error", { message: e.message ?? "Provider error" });
          yield emit("task.summary", finalizeTask());
          session.status = "error";
          return;
        }

        // Record the completed LLM request with real usage from the provider.
        telemetryStore.recordRequest(task, {
          model: modelUsed,
          requestType,
          contextTokens: actualContextTokens,
          rawContextTokens,
          prunedMessages: prunedThisIteration,
          iteration,
          latencyMs: Date.now() - requestStart,
          inputTokens: capturedUsage?.inputTokens ?? 0,
          outputTokens: capturedUsage?.outputTokens ?? 0,
          cachedTokens: capturedUsage?.cachedTokens ?? 0,
          reasoningTokens: capturedUsage?.reasoningTokens ?? 0,
          cost: capturedUsage?.cost ?? 0,
          success: true,
        });

        // Add assistant message to session
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: assistantContent,
        };
        if (assistantReasoning) {
          assistantMsg.reasoning = assistantReasoning;
        }
        if (assistantToolCalls.length > 0) {
          assistantMsg.toolCalls = assistantToolCalls;
        }
        session.messages.push(assistantMsg);
        session.modelUsed = modelUsed;

        // If no tool calls, check if we're truly done or if the model stopped prematurely
        if (assistantToolCalls.length === 0) {
          const isEmpty = !assistantContent.trim();
          const isAnnouncement = /\b(I'll|I will|Let me|Let's|I'm going to|Now I'll|I'll now|I'll start|Next I will|Next I'll|Next, I will|Next, I'll)\b/i.test(
            assistantContent,
          );
          // Check if model emitted source code blocks in text instead of writing to disk
          const hasSourceCodeBlocks = /```(svelte|javascript|js|typescript|ts|python|py|html|css|json)\n[\s\S]{30,}?\n```/i.test(
            assistantContent,
          );

          // Check if the user asked for an action (code/build/create) and no files have been written yet in this session
          const filesModifiedInSession = session.messages.some(
            (m) =>
              m.role === "assistant" &&
              m.toolCalls?.some((tc) =>
                ["create_file", "write_file", "apply_patch"].includes(tc.function.name),
              ),
          );
          const initialUserPrompt = session.messages.find((m) => m.role === "user")?.content.trim() ?? "";
          const isActionRequest = /^(code|build|create|implement|make|write|develop|generate|setup|set up)\b/i.test(
            initialUserPrompt,
          );
          const stoppedWithoutWriting = isActionRequest && !filesModifiedInSession;

          const canRetry = iteration < this.maxIterations - 1;

          if (canRetry && (isEmpty || isAnnouncement || hasSourceCodeBlocks || stoppedWithoutWriting)) {
            // Replace the incomplete assistant message with a specific nudge
            session.messages.pop();
            let nudgeContent: string;
            if (isEmpty) {
              nudgeContent = "Your previous response was empty. Please take action and execute the tools needed to complete the user's request.";
            } else if (hasSourceCodeBlocks) {
              nudgeContent = "You provided code in markdown text instead of writing it to disk. Use create_file to write each file to the workspace.";
            } else if (isAnnouncement) {
              nudgeContent = "You announced an action but did not call any tools. Do not describe what you plan to do — call the tools now to actually do it.";
            } else {
              nudgeContent = "You haven't created the implementation files yet. Please proceed with creating the files using create_file to complete the requested task.";
            }

            session.messages.push({
              role: "user",
              content: nudgeContent,
            });
            telemetryStore.markIterationEnd(task, false);
            iteration++;
            session.iterationCount = iteration;
            continue;
          }

          // Last iteration — if the model returned empty content, emit a
          // fallback message so the user never sees a silent "done".
          if (isEmpty) {
            const fallback = "I wasn't able to produce a response for this request. This may be due to a model limitation or an overly long conversation context. Try rephrasing your request or starting a new session.";
            assistantContent = fallback;
            yield emit("text.delta", { text: fallback });
            // Update the assistant message in session with the fallback.
            if (session.messages.length > 0) {
              const lastMsg = session.messages[session.messages.length - 1];
              if (lastMsg.role === "assistant") lastMsg.content = fallback;
            }
          }
          session.status = "done";
          // D12: if the model stopped calling tools after a streak of
          // consecutive errors, it likely gave up without completing the
          // task. Mark as error so the experiment/learning system doesn't
          // count it as a success. (If the model genuinely finished, the
          // last iteration wouldn't have had errors, so consecutiveErrors
          // would be 0.)
          taskStatus = consecutiveErrors >= STUCK_ERROR_THRESHOLD ? "error" : "success";
          yield emit("done");
          yield emit("task.summary", finalizeTask());
          return;
        }

        // Execute tool calls
        let iterationHadError = false;
        for (const tc of assistantToolCalls) {
          if (session.superseded) {
            telemetryStore.markIterationEnd(task, iterationHadError);
            finalizeTask();
            return;
          }
          if (session.isCancelled()) {
            taskStatus = "cancelled";
            telemetryStore.markIterationEnd(task, iterationHadError);
            yield emit("cancelled");
            yield emit("task.summary", finalizeTask());
            return;
          }

          let parsedArgs: Record<string, unknown> = {};
          const rawArgs = tc.function.arguments;
          try {
            // Some free models emit an empty string instead of "{}" — treat
            // it as no-args rather than failing the whole tool call.
            parsedArgs = JSON.parse(rawArgs || "{}");
          } catch {
            yield emit("tool.error", {
              toolCallId: tc.id,
              toolName: tc.function.name,
              error: "Malformed tool arguments (invalid JSON)",
            });
            telemetryStore.recordToolCall(task, tc.function.name, { cached: false, success: false });
            iterationHadError = true;
            session.messages.push({
              role: "tool",
              content: JSON.stringify({
                error: "Malformed tool arguments: the arguments string was not valid JSON. Please re-issue the tool call with valid JSON arguments.",
                rawArguments: rawArgs?.slice(0, 500),
              }),
              toolCallId: tc.id,
              name: tc.function.name,
            });
            continue;
          }

          // Check cache — L1 (session) then L2 (workspace)
          const cacheKey = tc.function.name;
          const cached = session.cache.get(cacheKey, parsedArgs);
          const l2Cached = cached === null && L2_CACHEABLE_TOOLS.has(tc.function.name)
            ? workspace.workspaceCache.get(cacheKey, parsedArgs)
            : null;
          if (cached !== null || l2Cached !== null) {
            const hit = cached !== null ? cached : l2Cached;
            yield emit("tool.cache_hit", { toolCallId: tc.id, toolName: tc.function.name });
            telemetryStore.recordToolCall(task, tc.function.name, { cached: true, success: true });
            // Populate L1 from L2 so the next session-level check hits L1.
            if (cached === null && l2Cached !== null) {
              const filePath = parsedArgs.path as string | undefined;
              session.cache.set(cacheKey, parsedArgs, l2Cached, filePath);
            }
            session.messages.push({
              role: "tool",
              content: JSON.stringify(hit),
              toolCallId: tc.id,
              name: tc.function.name,
            });
            continue;
          }

          // Execute tool
          const handler = this.registry.getHandler(tc.function.name);
          if (!handler) {
            yield emit("tool.error", {
              toolCallId: tc.id,
              toolName: tc.function.name,
              error: `Unknown tool: ${tc.function.name}`,
            });
            telemetryStore.recordToolCall(task, tc.function.name, { cached: false, success: false });
            iterationHadError = true;
            session.messages.push({
              role: "tool",
              content: JSON.stringify({ error: `Unknown tool: ${tc.function.name}` }),
              toolCallId: tc.id,
              name: tc.function.name,
            });
            continue;
          }

          // Build tool context — approval is handled outside the handler
          // (we can't yield from inside an async callback)
          const ctx: ToolContext = {
            workspace,
            signal: session.abortController.signal,
            sessionId: session.id,
            emit: (_event: AgentEvent) => {
              // No-op — events from tools are not needed in v1
            },
            requestApproval: async (_toolCallId: string, _toolName: string, _args: Record<string, unknown>) => {
              // Approval is handled before the handler is called (see below)
              return true;
            },
          };

          // Special handling for delete_file — emit approval_required before executing
          if (tc.function.name === "delete_file") {
            yield emit("tool.approval_required", {
              toolCallId: tc.id,
              toolName: tc.function.name,
              args: parsedArgs,
            });
            const approved = await session.awaitApproval(tc.id);
            if (!approved) {
              yield emit("tool.error", {
                toolCallId: tc.id,
                toolName: tc.function.name,
                error: "Delete denied by user",
              });
              telemetryStore.recordToolCall(task, tc.function.name, { cached: false, success: false });
              iterationHadError = true;
              session.messages.push({
                role: "tool",
                content: JSON.stringify({ error: "Delete denied by user" }),
                toolCallId: tc.id,
                name: tc.function.name,
              });
              continue;
            }
          }

          // B1: repeat-failure guard — if the exact same tool+args already
          // failed earlier this session and no write has succeeded since,
          // skip execution and return the cached error. Prevents the model
          // from burning iterations on identical broken calls. The hash is
          // whitespace-normalized for text-blob args (patch/content) so a
          // model can't evade the guard by adding a trailing newline to an
          // otherwise identical failed call.
          const argsHash = argsHashKey(tc.function.name, parsedArgs);
          const priorError = session.failedCallCache.get(argsHash);
          if (priorError) {
            const guardMsg = `${priorError}\n\nYou already tried this exact call and it failed. Do NOT repeat it unchanged — fix the arguments or change approach.`;
            yield emit("tool.error", {
              toolCallId: tc.id,
              toolName: tc.function.name,
              error: guardMsg,
            });
            telemetryStore.recordToolCall(task, tc.function.name, { cached: false, success: false });
            task.redundantCallsAvoided++;
            iterationHadError = true;
            session.messages.push({
              role: "tool",
              content: JSON.stringify({ error: guardMsg, redundantCallBlocked: true }),
              toolCallId: tc.id,
              name: tc.function.name,
            });
            continue;
          }

          try {
            const result: ToolResult = await handler(parsedArgs, ctx);

            // When a handler reports a logical failure (e.g. no test framework
            // detected), surface it as a tool.error so the UI shows it red
            // instead of a silent null result.
            if (!result.success) {
              const errorMsg = result.error ?? "Tool execution failed";
              yield emit("tool.error", {
                toolCallId: tc.id,
                toolName: tc.function.name,
                error: errorMsg,
              });
              telemetryStore.recordToolCall(task, tc.function.name, { cached: false, success: false });
              iterationHadError = true;
              // B1: record this failure so an identical call isn't re-executed.
              session.failedCallCache.set(argsHash, errorMsg);
              session.messages.push({
                role: "tool",
                content: JSON.stringify({ error: errorMsg }),
                toolCallId: tc.id,
                name: tc.function.name,
              });
              continue;
            }

            yield emit("tool.result", {
              toolCallId: tc.id,
              toolName: tc.function.name,
              result: result.output,
            });
            telemetryStore.recordToolCall(task, tc.function.name, { cached: false, success: true });

            // Phase 4: track run_tests results for outcome detection.
            if (tc.function.name === "run_tests") {
              task.testResults.push(result.output);
            }

            // Cache the result — L1 (session) always, L2 (workspace) for read-only tools.
            const filePath = parsedArgs.path as string | undefined;
            session.cache.set(tc.function.name, parsedArgs, result.output, filePath);
            if (L2_CACHEABLE_TOOLS.has(tc.function.name)) {
              workspace.workspaceCache.set(tc.function.name, parsedArgs, result.output, filePath);
            }

            // Invalidate cache on writes
            if (["write_file", "apply_patch", "create_file", "delete_file"].includes(tc.function.name)) {
              if (filePath) session.cache.invalidatePath(filePath);
              session.cache.invalidateTree();
              // Commands and tests may depend on the changed file's contents —
              // stale cached output would hide whether the edit actually worked.
              session.cache.invalidateCommands();
              // B1: a successful write means the model has made progress —
              // clear the failure cache so it can retry previously-failed
              // calls with the new file state.
              session.failedCallCache.clear();

              // Phase A3: auto git checkpoint before the first write of a task.
              // Best-effort — silently skip if not a git repo.
              if (!task.checkpointTaken) {
                try {
                  await workspace.gitCheckpoint("auto: pre-task checkpoint");
                  task.checkpointTaken = true;
                } catch {
                  // Not a git repo or git unavailable — skip silently.
                  task.checkpointTaken = true;
                }
              }

              // Phase A2: post-edit verification gate. Run the cheapest
              // file-scoped syntax check on the edited file. On failure,
              // convert into the existing tool-error path so B1 guard +
              // Phase-3 escalation engage automatically. Skip after 2
              // failures on the same file to avoid infinite loops.
              if (filePath && tc.function.name !== "delete_file") {
                const fileFailCount = task.verifyFailuresByFile.get(filePath) ?? 0;
                if (fileFailCount < 2) {
                  const verifyResult = await verifyEditedFile(workspace, filePath);
                  if (verifyResult.checkRan && !verifyResult.ok) {
                    const verifyError = `Syntax check failed after edit:\n${verifyResult.errors}`;
                    task.verifyGateFailures++;
                    task.verifyFailuresByFile.set(filePath, fileFailCount + 1);

                    // Emit tool.error so the UI shows the failure in red.
                    yield emit("tool.error", {
                      toolCallId: tc.id,
                      toolName: tc.function.name,
                      error: verifyError,
                    });
                    telemetryStore.recordToolCall(task, tc.function.name, { cached: false, success: false });
                    iterationHadError = true;
                    // Record in B1 cache so an identical write isn't re-executed.
                    session.failedCallCache.set(argsHash, verifyError);
                    session.messages.push({
                      role: "tool",
                      content: JSON.stringify({
                        error: "Syntax check failed after edit",
                        diagnostics: verifyResult.errors,
                        verifyGate: true,
                      }),
                      toolCallId: tc.id,
                      name: tc.function.name,
                    });
                    continue;  // skip the normal success-path message push below
                  }
                }
              }
            }

            // A1: truncate large tool results before they enter conversation
            // history. The full result was already emitted to the UI above; only
            // the copy re-sent on every subsequent LLM request is trimmed.
            const fullOutput = JSON.stringify(result.output);
            const { content: truncatedOutput, tokensSaved } = truncateToolContent(fullOutput);
            if (tokensSaved > 0) {
              task.truncationTokensSaved += tokensSaved;
            }

            session.messages.push({
              role: "tool",
              content: truncatedOutput,
              toolCallId: tc.id,
              name: tc.function.name,
            });
          } catch (e: any) {
            let errorMsg = e.message ?? "Tool execution failed";
            const isConflict = e.code === "HASH_MISMATCH" || e.code === "HASH_REQUIRED";
            // D10: apply_patch format-failure recovery — when the model
            // structures a patch wrong (no REPLACE, no valid blocks, search
            // not found), append a directive hint showing the correct format
            // and the write_file fallback. Weak models often know the fix
            // but can't get SEARCH/REPLACE syntax right and burn their whole
            // budget retrying malformed patches; the hint + fallback gives
            // them a path to succeed on the next attempt.
            if (tc.function.name === "apply_patch" && isApplyPatchFormatError(errorMsg)) {
              errorMsg = errorMsg + APPLY_PATCH_FORMAT_HINT;
            }

            yield emit("tool.error", {
              toolCallId: tc.id,
              toolName: tc.function.name,
              error: errorMsg,
            });
            telemetryStore.recordToolCall(task, tc.function.name, { cached: false, success: false });
            iterationHadError = true;
            // B1: record this failure so an identical call isn't re-executed.
            // Store the base error (without the format hint) so the B1 guard
            // message stays concise when it fires.
            session.failedCallCache.set(argsHash, e.message ?? "Tool execution failed");

            session.messages.push({
              role: "tool",
              content: JSON.stringify({ error: errorMsg, conflict: isConflict }),
              toolCallId: tc.id,
              name: tc.function.name,
            });
          }
        }

        telemetryStore.markIterationEnd(task, iterationHadError);
        iteration++;
        session.iterationCount = iteration;

        // --- Exploration cap: if the model has spent several consecutive
        // iterations calling only read-only tools (read_file, list_files,
        // search_files, etc.) without making any changes, inject a nudge
        // to either produce a plan or start implementing. Prevents the
        // "explore forever, never act" failure mode common with free models. ---
        const allToolsReadonly = assistantToolCalls.length > 0 &&
          assistantToolCalls.every((tc) => READ_ONLY_TOOLS.has(tc.function.name));
        if (allToolsReadonly) {
          consecutiveReadonlyIters++;
        } else {
          consecutiveReadonlyIters = 0;
        }
        if (consecutiveReadonlyIters >= MAX_EXPLORATION_ITERATIONS && iteration < effectiveMaxIterations - 1) {
          session.messages.push({
            role: "user",
            content: "You've spent several iterations exploring the codebase. Stop reading files and either: (1) write a brief plan of what you'll change, then immediately start implementing it, or (2) start making changes now with apply_patch/create_file. Do not call any more read-only tools unless strictly necessary.",
          });
          consecutiveReadonlyIters = 0;  // reset so the nudge doesn't fire every iteration
        }

        // --- Phase 3: intra-task escalation — if 2 consecutive iterations
        // end in tool errors and the current model is not the top allowed
        // tier, switch to the next tier for the remainder of the task. ---
        if (iterationHadError) {
          consecutiveErrors++;
        } else {
          consecutiveErrors = 0;
        }
        if (
          consecutiveErrors >= 2 &&
          this.routerSettings.mode === "auto" &&
          this.routerSettings.allowedTiers.length > 1
        ) {
          const currentTier = modelRegistry.tierOf(model);
          const tierOrder: Record<string, number> = { free: 0, mid: 1, frontier: 2 };
          const currentIdx = tierOrder[currentTier] ?? 0;
          const nextTier = this.routerSettings.allowedTiers
            .filter((t) => (tierOrder[t] ?? 0) > currentIdx)
            .sort((a, b) => (tierOrder[a] ?? 0) - (tierOrder[b] ?? 0))[0];
          if (nextTier) {
            const nextModels = modelRegistry.byTier(nextTier).filter((e) => e.toolsCapable);
            if (nextModels.length > 0) {
              const oldModel = model;
              model = nextModels[0].id;
              consecutiveErrors = 0;
              task.escalations++;
              // Escalation may cross regimes (free → paid); keep regime honest.
              task.regime = this.deriveRegime(model);
              yield emit("model.escalated", {
                from: oldModel,
                to: model,
                reason: "repeated tool failures",
              });

              // Phase D: build a compact case file for the escalated model
              // instead of sending the full conversation history. The
              // stronger model gets a distilled problem statement + current
              // file state + last errors, which is cheaper and easier to
              // solve than a long transcript of the weak model's failures.
              this.caseFileOverride = await this.buildCaseFile(session, workspace);
            }
          }
        }

        // D9: stuck-in-errors recovery — if the model has reached the
        // iteration cap while stuck on a streak of tool errors for an
        // action request, grant a 2-iteration bonus so it gets a real
        // tool-capable turn to apply the fix it likely already knows.
        // This catches the common "one tool call away from finishing"
        // failure mode: the model diagnosed the bug, knows the fix, but
        // burned its budget retrying a malformed apply_patch. The bonus
        // fires at most once per task, and the nudge points the model at
        // the write_file fallback (no SEARCH/REPLACE markers needed) so
        // even models that can't get patch formatting right can finish.
        if (
          iteration >= effectiveMaxIterations &&
          consecutiveErrors >= STUCK_ERROR_THRESHOLD &&
          !continuationBonusUsed
        ) {
          const initialUserPrompt =
            session.messages.find((m) => m.role === "user")?.content.trim() ?? "";
          const isActionReq = /^(code|build|create|implement|make|write|develop|generate|setup|set up|adapt|port|rewrite|fix|test|debug|refactor)\b/i.test(
            initialUserPrompt,
          );
          if (isActionReq) {
            continuationBonusUsed = true;
            effectiveMaxIterations += 2;
            session.messages.push({
              role: "user",
              content:
                "You've reached the tool-call limit but your last attempts failed with errors — you appear to be one step away from finishing. You have 2 more attempts. Fix the error from your last tool call and apply the change now. If apply_patch keeps failing on formatting, use write_file instead — pass the ENTIRE corrected file content plus the hash from your last read_file. write_file does NOT need SEARCH/REPLACE markers. Do not re-explain the fix in text — write it to disk.",
            });
          }
        }
      }

      // Hit iteration cap — one last text-only turn so command output
      // actually reaches the user instead of dying on a silent tool card.
      if (session.superseded) {
        finalizeTask();
        return;
      }
      if (session.isCancelled()) {
        taskStatus = "cancelled";
        yield emit("cancelled");
        yield emit("task.summary", finalizeTask());
        return;
      }

      const summaryMessages = this.buildProviderMessages(session);

      // D9: action-request budget guard. If the user asked for an action
      // (code/build/create) but no files were modified during the task, the
      // model burned all iterations on exploration/commands without producing
      // the requested work — inject a continuation nudge instead of a
      // text-only "plan". Also fires when the model ended stuck in a streak
      // of tool errors (even if files were modified earlier) so it honestly
      // reports the failure and the error it couldn't fix, rather than
      // claiming success.
      const filesModifiedInSession = session.messages.some(
        (m) =>
          m.role === "assistant" &&
          m.toolCalls?.some((tc) =>
            ["create_file", "write_file", "apply_patch"].includes(tc.function.name),
          ),
      );
      const initialUserPrompt = session.messages.find((m) => m.role === "user")?.content.trim() ?? "";
      const isActionRequest = /^(code|build|create|implement|make|write|develop|generate|setup|set up|adapt|port|rewrite)\b/i.test(
        initialUserPrompt,
      );
      const stuckInErrors = consecutiveErrors >= STUCK_ERROR_THRESHOLD;
      if (isActionRequest && !filesModifiedInSession) {
        summaryMessages.push({
          role: "user",
          content: "You've reached the tool-call limit but haven't written any files yet. Stop exploring and start implementing NOW. Use create_file or apply_patch to write the code the user asked for. Do not call read_file, list_files, or execute_command — write the files directly.",
        });
      } else if (isActionRequest && stuckInErrors) {
        summaryMessages.push({
          role: "user",
          content: "You've reached the tool-call limit and your last attempts failed with errors. Do not call any more tools. Summarize what you accomplished, honestly state that the task is incomplete, quote the last error you could not fix, and tell the user exactly what change is still needed so they can apply it themselves or ask you to continue.",
        });
      } else {
        summaryMessages.push({
          role: "user",
          content: "You have reached the tool-call limit. Do not call any more tools. Summarize what you did and quote any command stdout/stderr the user asked to see.",
        });
      }

      const summaryRawTokens = estimateTotalTokens(summaryMessages);
      const summaryRequestStart = Date.now();
      let summaryUsage: {
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        reasoningTokens: number;
        cost: number;
      } | undefined;
      let summaryText = "";
      const summaryModel = session.modelUsed || model;
      yield emit("status", {
        message: `summarizing → requesting ${summaryModel}…`,
        iteration: iteration + 1,
        model: summaryModel,
      });
      let summaryStreamingStarted = false;
      try {
        const summaryStream = withHeartbeat(
          this.provider.chat(summaryMessages, {
            model: summaryModel,
            signal: session.abortController.signal,
          }),
          HEARTBEAT_INTERVAL_MS,
          session.abortController.signal,
        );
        for await (const event of summaryStream) {
          if (event && (event as Heartbeat).__heartbeat) {
            const hb = event as Heartbeat;
            if (session.superseded) {
              finalizeTask();
              return;
            }
            if (session.isCancelled()) {
              taskStatus = "cancelled";
              yield emit("cancelled");
              yield emit("task.summary", finalizeTask());
              return;
            }
            yield emit("progress", {
              elapsedMs: hb.elapsedMs,
              phase: summaryStreamingStarted ? "streaming" : "requesting",
            });
            continue;
          }
          const ev = event as ProviderEvent;
          if (ev.type === "provider.queued") {
            yield emit("progress", {
              elapsedMs: Date.now() - summaryRequestStart,
              phase: "queued",
            });
          } else if (ev.type === "text.delta") {
            const data = ev.data as { text: string };
            if (!summaryStreamingStarted) {
              summaryStreamingStarted = true;
              yield emit("status", { message: "", iteration: iteration + 1, model: summaryModel });
            }
            summaryText += data.text;
            yield emit("text.delta", { text: data.text });
          } else if (ev.type === "reasoning.delta") {
            const data = ev.data as { text: string };
            if (!summaryStreamingStarted) {
              summaryStreamingStarted = true;
              yield emit("status", { message: "", iteration: iteration + 1, model: summaryModel });
            }
            yield emit("reasoning.delta", { text: data.text });
          } else if (ev.type === "finish") {
            const data = ev.data as { usage?: typeof summaryUsage };
            if (data.usage) summaryUsage = data.usage;
          } else if (ev.type === "model.fallback") {
            const data = ev.data as { from: string; to: string; reason: string };
            task.model = data.to;
            task.regime = this.deriveRegime(data.to);
            task.fallbacks++;
            yield emit("model.fallback", data);
          } else if (ev.type === "model.retry") {
            const data = ev.data as { model: string; reason: string };
            task.retries++;
            yield emit("model.retry", data);
          } else if (ev.type === "error") {
            const data = ev.data as { message: string };
            telemetryStore.recordRequest(task, {
              model: session.modelUsed || model,
              requestType: "final_response",
              contextTokens: summaryRawTokens,
              rawContextTokens: summaryRawTokens,
              prunedMessages: 0,
              iteration,
              latencyMs: Date.now() - summaryRequestStart,
              inputTokens: summaryUsage?.inputTokens ?? 0,
              outputTokens: summaryUsage?.outputTokens ?? 0,
              cachedTokens: summaryUsage?.cachedTokens ?? 0,
              reasoningTokens: summaryUsage?.reasoningTokens ?? 0,
              cost: summaryUsage?.cost ?? 0,
              success: false,
            });
            taskStatus = "error";
            yield emit("error", { message: data.message });
            yield emit("task.summary", finalizeTask());
            session.status = "error";
            return;
          }
        }
      } catch (e: any) {
        telemetryStore.recordRequest(task, {
          model: session.modelUsed || model,
          requestType: "final_response",
          contextTokens: summaryRawTokens,
          rawContextTokens: summaryRawTokens,
          prunedMessages: 0,
          iteration,
          latencyMs: Date.now() - summaryRequestStart,
          inputTokens: summaryUsage?.inputTokens ?? 0,
          outputTokens: summaryUsage?.outputTokens ?? 0,
          cachedTokens: summaryUsage?.cachedTokens ?? 0,
          reasoningTokens: summaryUsage?.reasoningTokens ?? 0,
          cost: summaryUsage?.cost ?? 0,
          success: false,
        });
        taskStatus = "error";
        yield emit("error", { message: e.message ?? "Failed to summarize after tool-step limit" });
        yield emit("task.summary", finalizeTask());
        session.status = "error";
        return;
      }

      telemetryStore.recordRequest(task, {
        model: session.modelUsed || model,
        requestType: "final_response",
        contextTokens: summaryRawTokens,
        rawContextTokens: summaryRawTokens,
        prunedMessages: 0,
        iteration,
        latencyMs: Date.now() - summaryRequestStart,
        inputTokens: summaryUsage?.inputTokens ?? 0,
        outputTokens: summaryUsage?.outputTokens ?? 0,
        cachedTokens: summaryUsage?.cachedTokens ?? 0,
        reasoningTokens: summaryUsage?.reasoningTokens ?? 0,
        cost: summaryUsage?.cost ?? 0,
        success: true,
      });

      if (summaryText) {
        session.messages.push({ role: "assistant", content: summaryText });
      } else {
        // The summary turn returned empty — emit a fallback so the user
        // never sees a silent completion after hitting the iteration cap.
        const fallback = "I reached the tool-call limit for this task. The work may be partially complete — please check the workspace for any files that were created or modified, and let me know if you'd like me to continue.";
        yield emit("text.delta", { text: fallback });
        session.messages.push({ role: "assistant", content: fallback });
      }
      session.status = "done";
      // D12: if the model hit the iteration cap while stuck in a streak of
      // tool errors, the task did not succeed — even if the summary turn
      // produced text. Without this, the experiment/learning system counts
      // "model wrote a summary explaining why it failed" as a 100% success,
      // which is the exact bug that let the PPO/CartPole task score as
      // successful despite ending with broken, unfixed code.
      taskStatus = consecutiveErrors >= STUCK_ERROR_THRESHOLD ? "error" : "success";
      yield emit("done");
      yield emit("task.summary", finalizeTask());
    } catch (e: any) {
      session.status = "error";
      taskStatus = "error";
      yield emit("error", { message: e.message ?? "Engine error" });
      yield emit("task.summary", finalizeTask());
    } finally {
      // If the generator was abandoned mid-turn (e.g. the consumer started a
      // new turn), the explicit finalize calls above were skipped — record
      // the task as cancelled so it doesn't leak as an in-flight task.
      if (!taskFinalized) {
        taskStatus = "cancelled";
        finalizeTask();
      }
    }
  }

  /**
   * Remove trailing messages from an abandoned turn that would leave the
   * conversation in a malformed state for the next provider request.
   *
   * When a turn is interrupted mid-tool-execution, the session may end with:
   *   - An assistant message with tool_calls but no tool results, OR
   *   - Some tool results but not all (e.g. 3 tool_calls, only 1 result).
   *
   * Both cases produce an invalid message sequence that providers reject
   * or respond to with empty content. This method trims the trailing
   * assistant message and any partial tool results that belong to it.
   */
  private cleanupOrphanedToolCalls(session: AgentSession): void {
    const msgs = session.messages;
    if (msgs.length === 0) return;

    // Find the last assistant message that has tool_calls.
    let lastAssistantIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx === -1) return;

    // Check whether ALL tool_calls from that assistant message have
    // corresponding tool-result messages after it.
    const expectedIds = new Set(msgs[lastAssistantIdx].toolCalls!.map((tc) => tc.id));
    const resolvedIds = new Set<string>();
    for (let i = lastAssistantIdx + 1; i < msgs.length; i++) {
      if (msgs[i].role === "tool" && msgs[i].toolCallId) {
        resolvedIds.add(msgs[i].toolCallId!);
      }
    }
    const allResolved = [...expectedIds].every((id) => resolvedIds.has(id));
    if (allResolved) return;

    // Not all tool calls were resolved — remove the assistant message and
    // everything after it (the partial tool results are orphaned without
    // their parent assistant message).
    msgs.splice(lastAssistantIdx);
  }

  /** Phase C: run the single-shot pipeline for weak-tier models.
   *  Returns true if the pipeline handled the task (either success or
   *  fallback to ReAct), false if it should not run (and the normal ReAct
   *  loop should proceed). Emits existing events so the UI keeps working. */
  private async *runSingleShotPipeline(
    session: AgentSession,
    workspace: Workspace,
    userMessage: string,
    model: string,
    task: ActiveTask,
  ): AsyncGenerator<AgentEvent> {
    const emit = (type: AgentEventType, data?: unknown): AgentEvent => ({
      type,
      sessionId: session.id,
      data,
      timestamp: Date.now(),
    });

    // Step 1: Classify call — fresh message array, no transcript.
    const fileTree = await buildWorkspaceSnapshot(workspace);
    const classifyPrompt = buildClassifyPrompt(userMessage, fileTree ?? "");
    const classifyMessages: ProviderMessage[] = [
      { role: "system", content: "You are a task classifier. Respond concisely." },
      { role: "user", content: classifyPrompt },
    ];

    let classifyRaw = "";
    try {
      const stream = this.provider.chat(classifyMessages, {
        model,
        signal: session.abortController.signal,
      });
      for await (const ev of stream) {
        if (ev.type === "text.delta") {
          classifyRaw += (ev.data as ProviderTextDelta)?.text ?? "";
        }
      }
    } catch {
      // Classification failed — fall back to ReAct.
      yield emit("text.delta", { text: "[Single-shot classification failed, falling back to ReAct loop]" });
      return;
    }

    const classifyResult = parseClassifyResponse(classifyRaw);
    if (!classifyResult) {
      yield emit("text.delta", { text: "[Single-shot classification unclear, falling back to ReAct loop]" });
      return;
    }

    // null/reject/search → fall back to ReAct
    if (classifyResult.action === "reject" || classifyResult.action === "search") {
      yield emit("text.delta", { text: "[Single-shot: " + (classifyResult.reason || "task not suitable for single-shot") + ", falling back to ReAct loop]" });
      return;
    }

    // explain → one normal chat completion, done.
    if (classifyResult.action === "explain") {
      const explainMessages: ProviderMessage[] = [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: userMessage },
      ];
      try {
        const stream = this.provider.chat(explainMessages, {
          model,
          signal: session.abortController.signal,
        });
        for await (const ev of stream) {
          if (ev.type === "text.delta") {
            yield emit("text.delta", ev.data);
          }
        }
      } catch (e) {
        yield emit("text.delta", { text: "Error: " + (e instanceof Error ? e.message : String(e)) });
      }
      yield emit("done");
      // Mark task as done — the caller should check for this.
      (task as any)._singleShotDone = true;
      return;
    }

    // edit/create → read target files, edit call, write, verify.
    if (classifyResult.action === "edit" || classifyResult.action === "create") {
      if (classifyResult.targetFiles.length === 0) {
        yield emit("text.delta", { text: "[Single-shot: no target files specified, falling back to ReAct]" });
        return;
      }

      // Read target files (for edit only — create doesn't need existing content).
      const files: FileContent[] = [];
      if (classifyResult.action === "edit") {
        for (const filePath of classifyResult.targetFiles) {
          try {
            const { content } = await workspace.readFile(filePath);
            files.push({ path: filePath, content });
          } catch {
            // File doesn't exist — skip it (model may want to create it).
          }
        }
        if (files.length === 0) {
          yield emit("text.delta", { text: "[Single-shot: target files not found, falling back to ReAct]" });
          return;
        }
        if (exceedsEditBudget(files)) {
          yield emit("text.delta", { text: "[Single-shot: target files too large, falling back to ReAct]" });
          return;
        }
      }

      // Edit call — fresh message array.
      const editPrompt = buildEditPrompt(userMessage, files);
      const editMessages: ProviderMessage[] = [
        { role: "system", content: "You are a code editor. Output complete file contents." },
        { role: "user", content: editPrompt },
      ];

      let editRaw = "";
      try {
        const stream = this.provider.chat(editMessages, {
          model,
          signal: session.abortController.signal,
        });
        for await (const ev of stream) {
          if (ev.type === "text.delta") {
            editRaw += (ev.data as ProviderTextDelta)?.text ?? "";
          }
        }
      } catch {
        yield emit("text.delta", { text: "[Single-shot: edit call failed, falling back to ReAct]" });
        return;
      }

      const parsedEdits = parseEditResponse(editRaw);
      if (parsedEdits.length === 0) {
        yield emit("text.delta", { text: "[Single-shot: no file blocks in response, falling back to ReAct]" });
        return;
      }

      // Write files via workspace, respecting hash-based concurrency.
      for (const edit of parsedEdits) {
        try {
          // Read current hash for existing files.
          let expectedHash: string | undefined;
          try {
            const { hash } = await workspace.readFile(edit.path);
            expectedHash = hash;
          } catch {
            // New file — no hash needed.
          }

          await workspace.writeFile(edit.path, edit.content, expectedHash);

          // Emit tool events so the UI shows activity.
          yield emit("tool.start", { toolCallId: "ss-" + edit.path, toolName: "write_file" });
          yield emit("tool.result", {
            toolCallId: "ss-" + edit.path,
            toolName: "write_file",
            result: { path: edit.path, lines: edit.content.split("\n").length },
          });

          // Phase A: verify the written file.
          const verifyResult = await verifyEditedFile(workspace, edit.path);
          if (verifyResult.checkRan && !verifyResult.ok) {
            // One repair attempt.
            const repairPrompt = "The file " + edit.path + " has a syntax error after your edit:\n" +
              verifyResult.errors + "\n\nPlease output the corrected complete file content.\n\n" +
              "FILE: " + edit.path + "\n```\n" + edit.content + "\n```";
            const repairMessages: ProviderMessage[] = [
              { role: "system", content: "You are a code editor. Fix the syntax error and output the complete file." },
              { role: "user", content: repairPrompt },
            ];
            let repairRaw = "";
            try {
              const repairStream = this.provider.chat(repairMessages, {
                model,
                signal: session.abortController.signal,
              });
              for await (const ev of repairStream) {
                if (ev.type === "text.delta") {
                  repairRaw += (ev.data as ProviderTextDelta)?.text ?? "";
                }
              }
              const repairEdits = parseEditResponse(repairRaw);
              if (repairEdits.length > 0) {
                await workspace.writeFile(edit.path, repairEdits[0].content, expectedHash);
                // Verify again — if still failing, fall back to ReAct.
                const reverify = await verifyEditedFile(workspace, edit.path);
                if (reverify.checkRan && !reverify.ok) {
                  yield emit("tool.error", {
                    toolCallId: "ss-" + edit.path,
                    toolName: "write_file",
                    error: "Syntax check still failing after repair:\n" + reverify.errors,
                  });
                  yield emit("text.delta", { text: "[Single-shot: repair failed, falling back to ReAct]" });
                  return;
                }
              }
            } catch {
              yield emit("text.delta", { text: "[Single-shot: repair call failed, falling back to ReAct]" });
              return;
            }
          }

          task.filesModified++;
        } catch (e) {
          yield emit("tool.error", {
            toolCallId: "ss-" + edit.path,
            toolName: "write_file",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Emit a summary text.
      yield emit("text.delta", {
        text: "Modified " + parsedEdits.length + " file(s): " + parsedEdits.map((e) => e.path).join(", "),
      });
      yield emit("done");
      (task as any)._singleShotDone = true;
      return;
    }
  }

  /** Phase D: build a compact case file for the escalated model. Contains
   *  the original user request, current file contents of modified files,
   *  and the last 3 tool error messages — instead of the full transcript. */
  private async buildCaseFile(
    session: AgentSession,
    workspace: Workspace,
  ): Promise<ProviderMessage[]> {
    // Original user request = first user message in session.
    const firstUserMsg = session.messages.find((m) => m.role === "user");
    const userRequest = firstUserMsg?.content ?? "(no user message found)";

    // Files modified so far — find write-family tool calls in the transcript
    // and read their current content from the workspace.
    const modifiedPaths = new Set<string>();
    for (const msg of session.messages) {
      if (msg.role === "assistant" && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          if (["write_file", "apply_patch", "create_file"].includes(tc.function.name)) {
            const args = tc.function.arguments;
            const parsed = typeof args === "string" ? JSON.parse(args) : args;
            const path = (parsed as Record<string, unknown>)?.path as string | undefined;
            if (path) modifiedPaths.add(path);
          }
        }
      }
    }

    // Read current content of modified files (truncate each to ~800 chars).
    const fileSections: string[] = [];
    for (const filePath of modifiedPaths) {
      try {
        const { content } = await workspace.readFile(filePath);
        const truncated = content.length > 800
          ? content.slice(0, 800) + "\n... (truncated)"
          : content;
        fileSections.push("FILE: " + filePath + "\n" + truncated);
      } catch {
        fileSections.push("FILE: " + filePath + " (could not read)");
      }
    }

    // Last 3 tool error messages (truncated 300 chars each).
    const errorMessages: string[] = [];
    for (const msg of session.messages) {
      if (msg.role === "tool") {
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed.error) {
            errorMessages.push(String(parsed.error).slice(0, 300));
          }
        } catch {
          // Not JSON — skip.
        }
      }
    }
    const lastErrors = errorMessages.slice(-3);

    // Build the case file as a system + user message pair.
    const caseFileContent =
      "USER REQUEST:\n" + userRequest + "\n\n" +
      "FILES MODIFIED SO FAR:\n" +
      (fileSections.length > 0 ? fileSections.join("\n\n") : "(none)") + "\n\n" +
      "LAST ERRORS:\n" +
      (lastErrors.length > 0 ? lastErrors.map((e) => "- " + e).join("\n") : "(none)") + "\n\n" +
      "INSTRUCTION: Continue this task. Previous model failed repeatedly.";

    return [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: caseFileContent },
    ];
  }

  private buildProviderMessages(session: AgentSession): ProviderMessage[] {
    const messages: ProviderMessage[] = [
      { role: "system", content: this.systemPrompt },
    ];

    for (const msg of session.messages) {
      const pm: ProviderMessage = {
        role: msg.role,
        content: msg.content,
      };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        // D19: safety net — normalize any tool calls with empty/malformed
        // arguments before sending to the provider. This catches calls
        // that slipped through the tool_call.complete normalization (e.g.
        // from older sessions loaded from disk) and prevents 400 errors
        // from strict providers like Cohere.
        pm.tool_calls = msg.toolCalls.map((tc) => {
          const args = tc.function.arguments;
          if (!args || !args.trim()) {
            return { ...tc, function: { ...tc.function, arguments: "{}" } };
          }
          try {
            JSON.parse(args);
            return tc;
          } catch {
            return { ...tc, function: { ...tc.function, arguments: "{}" } };
          }
        });
      }
      if (msg.toolCallId) {
        pm.tool_call_id = msg.toolCallId;
      }
      if (msg.name) {
        pm.name = msg.name;
      }
      messages.push(pm);
    }

    return messages;
  }
}

// --- Synthetic progress heartbeat ---------------------------------------------

/** How often to emit a `progress` event while the provider is silent (no
 *  tokens, no tool calls). Tuned so the user sees a live "waiting 8s…"
 *  indicator without flooding the SSE stream. */
const HEARTBEAT_INTERVAL_MS = 8_000;

/** Marker yielded by `withHeartbeat` when the provider hasn't produced an
 *  event within the heartbeat interval. The engine turns these into
 *  `progress` AgentEvents. */
interface Heartbeat {
  __heartbeat: true;
  elapsedMs: number;
}

/**
 * Wrap a provider async iterable so that, while the provider is silent (its
 * `.next()` hasn't resolved), a heartbeat marker is yielded every
 * `intervalMs`. This lets the engine surface "Working… Ns · waiting for
 * model response" to the UI during the pre-headers hang and mid-stream
 * stalls — the two failure modes that real reasoning/thought deltas can't
 * cover (zero bytes arrive during a true stall).
 *
 * Async iterators generally do not support concurrent `.next()` calls, so
 * we call `.next()` once per outer iteration and then race that single
 * pending promise against repeated timers in an inner loop until it
 * resolves. On abort the wrapper returns immediately.
 */
export async function* withHeartbeat(
  iterable: AsyncIterable<ProviderEvent>,
  intervalMs: number,
  signal: AbortSignal,
): AsyncIterable<ProviderEvent | Heartbeat> {
  const iter = iterable[Symbol.asyncIterator]();
  const start = Date.now();
  try {
    while (true) {
      if (signal.aborted) return;
      const nextPromise = iter.next();
      // Inner loop: race the single pending .next() against fresh timers
      // until the real event resolves. Never call .next() concurrently.
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timerPromise = new Promise<Heartbeat>((resolve) => {
          timer = setTimeout(
            () => resolve({ __heartbeat: true, elapsedMs: Date.now() - start }),
            intervalMs,
          );
        });
        const raced = (await Promise.race([nextPromise, timerPromise])) as
          | Heartbeat
          | IteratorResult<ProviderEvent>;
        if (raced && (raced as Heartbeat).__heartbeat) {
          if (signal.aborted) return;
          yield raced as Heartbeat;
          continue; // timer already fired — set a fresh one, same nextPromise
        }
        if (timer) clearTimeout(timer);
        const r = raced as IteratorResult<ProviderEvent>;
        if (r.done) return;
        yield r.value;
        break; // got a real event → outer loop calls .next() again
      }
    }
  } finally {
    // Trigger the provider generator's finally block (releases the reader,
    // cleans up timers) when the engine stops consuming — cancel, supersede,
    // or error.
    await iter.return?.();
  }
}
