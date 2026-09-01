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
import { estimateTotalTokens, pruneMessages } from "./context.js";
import { telemetryStore, type ActiveTask } from "../telemetry/index.js";
import type { RequestType } from "../telemetry/types.js";
import type { TaskSummaryData } from "../../types.js";

const MAX_ITERATIONS = 10;
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
  private maxIterations: number;
  private systemPrompt: string;

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
    this.systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
  }

  /**
   * Run the agent loop for a session.
   * Emits events to the provided callback as an async generator.
   */
  async *run(
    session: AgentSession,
    workspace: import("../workspace.js").Workspace,
    userMessage: string,
    model: string,
    contextLength: number,
  ): AsyncIterable<AgentEvent> {
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
    session.messages.push({ role: "user", content: userMessage });

    // --- Telemetry: begin tracking this user task ---------------------------
    await telemetryStore.load();
    const task = telemetryStore.startTask(session.id, model, userMessage);
    let taskStatus: "success" | "error" | "cancelled" = "success";
    let taskFinalized = false;
    const finalizeTask = (): TaskSummaryData => {
      if (taskFinalized) return {} as TaskSummaryData;
      taskFinalized = true;
      const rec = telemetryStore.finishTask(task, taskStatus);
      return {
        requestCount: rec.requestCount,
        toolCalls: rec.toolCalls,
        cacheHits: rec.cacheHits,
        inputTokens: rec.inputTokens,
        outputTokens: rec.outputTokens,
        cost: rec.cost,
        durationMs: rec.durationMs,
        status: rec.status,
      };
    };

    try {
      let iteration = 0;

      while (iteration < this.maxIterations) {
        if (session.isCancelled()) {
          yield emit("cancelled");
          return;
        }

        // Build provider messages from session
        let providerMessages = this.buildProviderMessages(session);

        // Prune if approaching context limit
        const rawContextTokens = estimateTotalTokens(providerMessages);
        let prunedThisIteration = 0;
        if (rawContextTokens > contextLength - 2000) {
          const { messages: pruned, prunedCount } = pruneMessages(providerMessages, contextLength);
          providerMessages = pruned;
          prunedThisIteration = prunedCount;
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

        try {
          for await (const event of this.provider.chat(providerMessages, {
            model,
            tools,
            signal: session.abortController.signal,
          })) {
            switch (event.type) {
              case "text.delta": {
                const data = event.data as { text: string };
                assistantContent += data.text;
                yield emit("text.delta", { text: data.text });
                break;
              }
              case "tool_call.start": {
                const data = event.data as { toolCallId: string; toolName: string; index: number };
                toolCallArgs.set(data.index, { id: data.toolCallId, name: data.toolName, args: "" });
                yield emit("tool.start", { toolCallId: data.toolCallId, toolName: data.toolName });
                break;
              }
              case "tool_call.args.delta": {
                const data = event.data as { index: number; delta: string };
                const acc = toolCallArgs.get(data.index);
                if (acc) acc.args += data.delta;
                break;
              }
              case "tool_call.complete": {
                const data = event.data as { index: number; toolCallId: string; toolName: string; arguments: string };
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
                const data = event.data as { finishReason: string; model: string; usage?: {
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
                const data = event.data as { from: string; to: string; reason: string };
                yield emit("model.fallback", data);
                break;
              }
              case "error": {
                if (session.isCancelled()) {
                  taskStatus = "cancelled";
                  yield emit("cancelled");
                  yield emit("task.summary", finalizeTask());
                  return;
                }
                const data = event.data as {
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
          session.status = "done";
          taskStatus = "success";
          yield emit("done");
          yield emit("task.summary", finalizeTask());
          return;
        }

        // Execute tool calls
        let iterationHadError = false;
        for (const tc of assistantToolCalls) {
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

          // Check cache
          const cacheKey = tc.function.name;
          const cached = session.cache.get(cacheKey, parsedArgs);
          if (cached !== null) {
            yield emit("tool.cache_hit", { toolCallId: tc.id, toolName: tc.function.name });
            telemetryStore.recordToolCall(task, tc.function.name, { cached: true, success: true });
            session.messages.push({
              role: "tool",
              content: JSON.stringify(cached),
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

            // Cache the result
            const filePath = parsedArgs.path as string | undefined;
            session.cache.set(tc.function.name, parsedArgs, result.output, filePath);

            // Invalidate cache on writes
            if (["write_file", "apply_patch", "create_file", "delete_file"].includes(tc.function.name)) {
              if (filePath) session.cache.invalidatePath(filePath);
              session.cache.invalidateTree();
              // Commands and tests may depend on the changed file's contents —
              // stale cached output would hide whether the edit actually worked.
              session.cache.invalidateCommands();
            }

            session.messages.push({
              role: "tool",
              content: JSON.stringify(result.output),
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
      }

      // Hit iteration cap — one last text-only turn so command output
      // actually reaches the user instead of dying on a silent tool card.
      if (session.isCancelled()) {
        taskStatus = "cancelled";
        yield emit("cancelled");
        yield emit("task.summary", finalizeTask());
        return;
      }

      const summaryMessages = this.buildProviderMessages(session);
      summaryMessages.push({
        role: "user",
        content: "You have reached the tool-call limit. Do not call any more tools. Summarize what you did and quote any command stdout/stderr the user asked to see.",
      });

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
      try {
        for await (const event of this.provider.chat(summaryMessages, {
          model: session.modelUsed || model,
          signal: session.abortController.signal,
        })) {
          if (event.type === "text.delta") {
            const data = event.data as { text: string };
            summaryText += data.text;
            yield emit("text.delta", { text: data.text });
          } else if (event.type === "finish") {
            const data = event.data as { usage?: typeof summaryUsage };
            if (data.usage) summaryUsage = data.usage;
          } else if (event.type === "error") {
            const data = event.data as { message: string };
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
