// ============================================================================
// AdaanIDE Core Types
// ============================================================================

// --- Themes -----------------------------------------------------------------

export type ThemeId = "retrowave" | "ghibli" | "fiesta" | "dawn" | "synthwave84" | "solarizedDark";

export interface ThemePalette {
  id: ThemeId;
  name: string;
  base: {
    bg: string;
    surface: string;
    accent: string;
    text: string;
    muted: string;
  };
  syntax: {
    keyword: string;
    string: string;
    comment: string;
    number: string;
    variable: string;
    function: string;
    type: string;
    operator: string;
  };
}

// --- Workspace --------------------------------------------------------------

export interface FileNode {
  name: string;
  path: string; // relative to workspace root
  type: "file" | "dir";
  children?: FileNode[];
  size?: number;
  zone?: "normal" | "sensitive" | "protected";
  hidden?: boolean;
}

export interface FileContent {
  content: string;
  hash: string;
  path: string;
}

export interface SearchResult {
  path: string;
  line: number;
  column: number;
  text: string;
  match: string;
}

export interface SymbolEntry {
  name: string;
  kind: "function" | "class" | "method";
  lineStart: number;
  lineEnd: number;
  indent: number;
}

export interface WorkspaceInfo {
  rootPath: string;
  name: string;
}

// --- Models -----------------------------------------------------------------

export interface ModelInfo {
  id: string;
  name: string;
  /** User-defined display name (Settings → Models). Shown in the model
   *  selector instead of `name` when set. Currently only local models. */
  alias?: string;
  contextLength: number;
  pricing: {
    prompt: string;
    completion: string;
  };
  toolsCapable: boolean;
  free: boolean;
}

/** A model served by a local OpenAI-compatible runtime (Ollama, Rapid-MLX,
 *  LM Studio). Extends ModelInfo with the metadata needed to launch and
 *  connect to the local server. */
export interface LocalModelInfo extends ModelInfo {
  /** Provider id: "ollama" | "rapid-mlx" | "lmstudio" */
  providerId: string;
  /** Human-readable provider name for display */
  providerName: string;
  /** Full endpoint URL, e.g. "http://localhost:8000/v1" */
  endpoint: string;
  /** Whether this specific model is currently being served (not just
   *  whether the provider's server is running — only true for the model
   *  the server actually reports via /v1/models). */
  running: boolean;
  /** Model size string from the provider CLI (e.g. "5.6 GiB") */
  size?: string;
  /** Full HF repo name as reported by the server's /v1/models endpoint
   *  (e.g. "mlx-community/Qwen3.5-4B-MLX-4bit"). May differ from `id`
   *  (the alias). Used to match the served model. */
  hfRepo?: string;
}

export interface ModelGroups {
  free: ModelInfo[];
  paid: ModelInfo[];
  /** Locally-installed models from detected runtimes. Empty when no local
   *  providers are installed or the discovery hasn't run yet. */
  local: LocalModelInfo[];
}

// --- Agent Events ------------------------------------------------------------

export type AgentEventType =
  | "text.delta"
  | "reasoning.delta"
  | "tool.start"
  | "tool.args"
  | "tool.result"
  | "tool.error"
  | "tool.approval_required"
  | "tool.cache_hit"
  | "context.pruned"
  | "model.used"
  | "model.fallback"
  | "model.free_exhausted"
  | "model.routed"
  | "model.escalated"
  | "task.summary"
  | "status"
  | "progress"
  | "done"
  | "error"
  | "cancelled";

export interface AgentEvent {
  type: AgentEventType;
  sessionId: string;
  data?: unknown;
  timestamp: number;
}

export interface TextDeltaData {
  text: string;
}

/** A chunk of model reasoning/thinking, streamed from providers that support
 *  it (e.g. o1, DeepSeek-R1, Claude w/ extended thinking). Distinct from
 *  `text.delta` so the UI can render it in a separate, muted, collapsible
 *  block above the final answer. OpenRouter streams this via either
 *  `delta.reasoning` (their native field) or `delta.reasoning_content`
 *  (OpenAI/DeepSeek-compatible); the provider reads both. */
export interface ReasoningDeltaData {
  text: string;
}

/** Synthetic progress signal — emitted by the engine while the provider is
 *  silent (no tokens yet) so the UI can show "Working… 23s · waiting for
 *  model response" instead of a dead-looking bubble. `elapsedMs` is the time
 *  since the current LLM request started; `phase` indicates what we're
 *  waiting on. */
export interface ProgressData {
  elapsedMs: number;
  phase: "requesting" | "queued" | "streaming";
}

/** Status line emitted at the start of each iteration's LLM request, e.g.
 *  "iteration 2 → requesting qwen3.8-max…". Replaces (or refines) the
 *  `phase` shown by progress heartbeats. */
export interface StatusData {
  message: string;
  iteration: number;
  model: string;
}

export interface ToolStartData {
  toolCallId: string;
  toolName: string;
}

export interface ToolArgsData {
  toolCallId: string;
  args: Record<string, unknown>;
}

export interface ToolResultData {
  toolCallId: string;
  toolName: string;
  result: unknown;
}

export interface ToolErrorData {
  toolCallId: string;
  toolName: string;
  error: string;
}

export interface ToolApprovalData {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolCacheHitData {
  toolCallId: string;
  toolName: string;
}

export interface ContextPrunedData {
  prunedCount: number;
  remainingTokens: number;
}

export interface ModelUsedData {
  modelId: string;
  modelName: string;
}

export interface ModelFallbackData {
  from: string;
  to: string;
  reason: string;
}

export interface ErrorData {
  message: string;
}

/** Per-task cost/token footer emitted at the end of a turn so the UI can show
 *  `7 reqs · 92k tokens · $0.031 · 84s` under the assistant message. */
export interface TaskSummaryData {
  requestCount: number;
  toolCalls: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
  status: "success" | "error" | "cancelled";
  /** Phase 2: tokens saved by truncation + compaction (A1/A2). */
  truncationTokensSaved: number;
  compactionTokensSaved: number;
  /** Phase 2: redundant calls blocked by the repeat-failure guard (B1). */
  redundantCallsAvoided: number;
  /** Phase 3: whether this task was routed by the adaptive router. */
  routedBy: "auto" | "manual";
  /** Phase 3: task category from the classifier. */
  category: string | null;
  /** Phase 3: number of intra-task escalations. */
  escalations: number;
}

// --- Chat Messages -----------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  /** Reasoning/thinking text from reasoning-capable models (o1, DeepSeek-R1,
   *  Claude w/ extended thinking). Stored on the message so it round-trips
   *  through the session and can be re-displayed, but NOT sent back to the
   *  provider on subsequent requests (providers don't accept reasoning in
   *  the message history — it would be rejected or ignored). */
  reasoning?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// --- Provider ----------------------------------------------------------------

export interface ProviderMessage {
  role: MessageRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ProviderTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderChatOptions {
  model: string;
  tools?: ProviderTool[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type ProviderEventType =
  | "text.delta"
  | "reasoning.delta"
  | "tool_call.start"
  | "tool_call.args.delta"
  | "tool_call.complete"
  | "finish"
  | "model.fallback"
  | "provider.queued"
  | "error";

export interface ProviderEvent {
  type: ProviderEventType;
  data?: unknown;
}

export interface ProviderTextDelta {
  text: string;
}

export interface ProviderToolCallStart {
  toolCallId: string;
  toolName: string;
  index: number;
}

export interface ProviderToolCallArgsDelta {
  index: number;
  delta: string;
}

export interface ProviderToolCallComplete {
  index: number;
  toolCallId: string;
  toolName: string;
  arguments: string;
}

export interface ProviderFinish {
  finishReason: "stop" | "tool_calls" | "length" | "content_filter";
  model: string;
  /** Real token usage parsed from OpenRouter's final SSE chunk. Present
   *  whenever the provider reports usage; absent for error/empty streams. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
    cost: number;
  };
}

export interface ProviderError {
  message: string;
  statusCode?: number;
  retryable: boolean;
}

// --- Session -----------------------------------------------------------------

export type SessionStatus = "idle" | "running" | "cancelled" | "error" | "done";

export interface SessionState {
  id: string;
  workspaceId: string;
  status: SessionStatus;
  messages: ChatMessage[];
  iterationCount: number;
  modelUsed: string | null;
  createdAt: number;
}

// --- File Watcher ------------------------------------------------------------

export type WatcherEventType = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

export interface WatcherEvent {
  type: WatcherEventType;
  path: string;
  timestamp: number;
}

// --- Tool Definitions --------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  output: unknown;
  error?: string;
}

export interface ToolContext {
  workspace: import("./server/workspace.js").Workspace;
  signal: AbortSignal;
  sessionId: string;
  emit: (event: AgentEvent) => void;
  requestApproval: (toolCallId: string, toolName: string, args: Record<string, unknown>) => Promise<boolean>;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
