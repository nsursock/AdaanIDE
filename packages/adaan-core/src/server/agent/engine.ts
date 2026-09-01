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

const MAX_ITERATIONS = 10;
const SYSTEM_PROMPT = `You are AdaanIDE, an autonomous coding agent integrated into a development IDE.
You can read, write, search, and execute commands in the user's workspace.

CRITICAL RULES:
- NEVER ask clarifying questions. Make reasonable assumptions and act on them. It is far better to attempt the task and get it slightly wrong than to ask the user for clarification — they chose an autonomous agent because they want action, not a conversation.
- Focus on the user's CURRENT request. Do not re-attempt previously failed tasks from earlier in the conversation unless the user explicitly asks you to.
- If you don't already know the relevant files from this conversation, explore first with list_files/list_symbols/search_files.
- If the user confirmed a proposed change ("yes", "do it", "fix it", "continue"), apply it immediately — do not re-explore or re-explain.
- When editing existing files, always read the file first to get its hash, then use apply_patch with the expectedHash.
- When creating new files, use create_file with the path AND content arguments in a single call. Do NOT create an empty file and then write to it — pass the full content directly to create_file.
- Run tests after making changes to verify your work.
- Use git_checkpoint before risky changes.
- Be concise in your explanations. Show the user what you're doing via tool calls.
- After running execute_command or run_tests, always quote the relevant stdout/stderr in your final reply — the user cannot see raw tool payloads unless they expand a card. Never finish a turn with only tool calls and no text.
- NEVER claim success when tool output shows failure. Read command output and test results carefully. If output contains "failed", "error", "✗", "Match: False", "traceback", or a non-zero exit code, report the failure honestly and attempt to fix it.
- If a tool call fails, read the error message carefully and fix the issue — do not give up or ask the user for help.
- NEVER end your response with "Would you like me to..." or "Do you want me to..." or similar offers. Just do the next logical thing. The user will tell you if they want something different.
- NEVER announce an action ("I'll create...", "I'll add...", "Let me write...") without immediately following through with the corresponding tool call in the same response. If you say you're going to do something, DO it — do not describe the plan and then stop.`;

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
        const totalTokens = estimateTotalTokens(providerMessages);
        if (totalTokens > contextLength - 2000) {
          const { messages: pruned, prunedCount } = pruneMessages(providerMessages, contextLength);
          providerMessages = pruned;
          if (prunedCount > 0) {
            yield emit("context.pruned", { prunedCount, remainingTokens: contextLength - estimateTotalTokens(pruned) });
          }
        }

        // Get tools
        const tools: ProviderTool[] = this.registry.allSchemas as ProviderTool[];

        // Call provider
        let assistantContent = "";
        let assistantToolCalls: ToolCall[] = [];
        let finishReason: string = "stop";
        let modelUsed = model;

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
                const data = event.data as { finishReason: string; model: string };
                finishReason = data.finishReason;
                modelUsed = data.model;
                yield emit("model.used", { modelId: data.model, modelName: data.model });
                break;
              }
              case "error": {
                if (session.isCancelled()) {
                  yield emit("cancelled");
                  return;
                }
                const data = event.data as { message: string };
                yield emit("error", { message: data.message });
                session.status = "error";
                return;
              }
            }
          }
        } catch (e: any) {
          if (session.isCancelled()) {
            yield emit("cancelled");
            return;
          }
          yield emit("error", { message: e.message ?? "Provider error" });
          session.status = "error";
          return;
        }

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

        // If no tool calls, we're done
        if (assistantToolCalls.length === 0) {
          session.status = "done";
          yield emit("done");
          return;
        }

        // Execute tool calls
        for (const tc of assistantToolCalls) {
          if (session.isCancelled()) {
            yield emit("cancelled");
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

            session.messages.push({
              role: "tool",
              content: JSON.stringify({ error: errorMsg, conflict: isConflict }),
              toolCallId: tc.id,
              name: tc.function.name,
            });
          }
        }

        iteration++;
        session.iterationCount = iteration;
      }

      // Hit iteration cap — one last text-only turn so command output
      // actually reaches the user instead of dying on a silent tool card.
      if (session.isCancelled()) {
        yield emit("cancelled");
        return;
      }

      const summaryMessages = this.buildProviderMessages(session);
      summaryMessages.push({
        role: "user",
        content: "You have reached the tool-call limit. Do not call any more tools. Summarize what you did and quote any command stdout/stderr the user asked to see.",
      });

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
          } else if (event.type === "error") {
            const data = event.data as { message: string };
            yield emit("error", { message: data.message });
            session.status = "error";
            return;
          }
        }
      } catch (e: any) {
        yield emit("error", { message: e.message ?? "Failed to summarize after tool-step limit" });
        session.status = "error";
        return;
      }

      if (summaryText) {
        session.messages.push({ role: "assistant", content: summaryText });
      }
      session.status = "done";
      yield emit("done");
    } catch (e: any) {
      session.status = "error";
      yield emit("error", { message: e.message ?? "Engine error" });
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
