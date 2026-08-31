// ============================================================================
// AdaanIDE Core Types
// ============================================================================

// --- Themes -----------------------------------------------------------------

export type ThemeId = "retrowave" | "ghibli" | "fiesta" | "dawn";

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
  contextLength: number;
  pricing: {
    prompt: string;
    completion: string;
  };
  toolsCapable: boolean;
  free: boolean;
}

export interface ModelGroups {
  free: ModelInfo[];
  paid: ModelInfo[];
}

// --- Agent Events ------------------------------------------------------------

export type AgentEventType =
  | "text.delta"
  | "tool.start"
  | "tool.args"
  | "tool.result"
  | "tool.error"
  | "tool.approval_required"
  | "tool.cache_hit"
  | "context.pruned"
  | "model.used"
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

export interface ErrorData {
  message: string;
}

// --- Chat Messages -----------------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
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
  | "tool_call.start"
  | "tool_call.args.delta"
  | "tool_call.complete"
  | "finish"
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
