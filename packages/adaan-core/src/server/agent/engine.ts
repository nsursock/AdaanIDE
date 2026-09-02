import type {
  AgentEvent,
  ChatMessage,
  ProviderMessage,
  ProviderTool,
  ProviderEvent,
  ToolCall,
  ToolResult,
  ToolContext,
} from "../../types.js";
import type { LLMProvider } from "./provider.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { AgentSession } from "./session.js";
import { estimateTotalTokens, pruneContext, truncateToolContent } from "./context.js";
import { buildWorkspaceSnapshot } from "./snapshot.js";
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
}

export class AgentEngine {
  private provider: LLMProvider;
  private registry: ToolRegistry;
  maxIterations: number;
  private systemPrompt: string;
  /** Phase 3: adaptive router settings. */
  routerSettings: RouterSettings = DEFAULT_ROUTER_SETTINGS;
  /** Phase 4: whether paid-model exploration is allowed (default off). */
  explorationPaidEnabled = false;

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
    this.systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
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
    const finalizeTask = (): TaskSummaryData => {
      if (taskFinalized) return {} as TaskSummaryData;
      taskFinalized = true;

      // Phase 4: detect outcome from test results.
      if (taskStatus === "success" && task.testResults.length > 0) {
        const outcome = detectOutcome(task.testResults);
        task.outcome = outcome;
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
      let iteration = 0;
      let consecutiveErrors = 0;  // Phase 3: escalation trigger
      let consecutiveReadonlyIters = 0;  // exploration cap

      while (iteration < this.maxIterations) {
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
        let providerMessages = this.buildProviderMessages(session);

        // A3: inject a workspace snapshot on the first request of the session
        // (when no assistant message has been sent yet). This kills the common
        // "exploration" request where the model calls list_files just to orient.
        // The snapshot is merged INTO the system prompt (not inserted as a
        // separate system message) because some local model chat templates
        // (e.g. Qwen3.5 on Rapid-MLX) reject multiple system messages.
        const hasAssistantMsg = session.messages.some((m) => m.role === "assistant");
        if (!hasAssistantMsg && !task.snapshotInjected) {
          try {
            const snapshot = await buildWorkspaceSnapshot(workspace);
            if (snapshot) {
              providerMessages[0] = {
                ...providerMessages[0],
                content:
                  providerMessages[0].content +
                  `\n\nWorkspace snapshot (do not call list_files if this already answers your question):\n${snapshot}`,
              };
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

        // Get tools
        const tools: ProviderTool[] = this.registry.allSchemas as ProviderTool[];

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
                const tc: ToolCall = {
                  id: data.toolCallId,
                  type: "function",
                  function: { name: data.toolName, arguments: data.arguments },
                };
                assistantToolCalls.push(tc);

                // Parse args and emit
                let parsedArgs: Record<string, unknown> = {};
                try {
                  parsedArgs = JSON.parse(data.arguments || "{}");
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
          taskStatus = "success";
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
          // from burning iterations on identical broken calls.
          const argsHash = `${tc.function.name}:${JSON.stringify(parsedArgs)}`;
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
            const errorMsg = e.message ?? "Tool execution failed";
            const isConflict = e.code === "HASH_MISMATCH" || e.code === "HASH_REQUIRED";

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
        if (consecutiveReadonlyIters >= MAX_EXPLORATION_ITERATIONS && iteration < this.maxIterations - 1) {
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
            }
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

      // If the user asked for an action (code/build/create) but no files
      // were modified during the task, the model burned all iterations on
      // exploration/commands without producing the requested work. Instead
      // of a text-only summary that ends with a "plan", inject a
      // continuation nudge so the model starts writing files immediately
      // in the summary turn (which allows tool calls).
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
      if (isActionRequest && !filesModifiedInSession) {
        summaryMessages.push({
          role: "user",
          content: "You've reached the tool-call limit but haven't written any files yet. Stop exploring and start implementing NOW. Use create_file or apply_patch to write the code the user asked for. Do not call read_file, list_files, or execute_command — write the files directly.",
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
      taskStatus = "success";
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
        pm.tool_calls = msg.toolCalls;
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
