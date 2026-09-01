export { Workspace } from "./workspace.js";
export { FileHistory } from "./file-history.js";
export type { HistoryEntry, HistoryListEntry } from "./file-history.js";
export {
  safeResolve,
  checkSymlinkEscape,
  isCommandAllowed,
  classifyPath,
  assertAgentPathAccess,
  PathSecurityError,
  PathAccessDeniedError,
  CommandDeniedError,
  DEFAULT_IGNORE_DIRS,
  PROTECTED_DIRS,
  COMMAND_DENY_LIST,
  DEFAULT_SECURITY,
  type SecurityOptions,
  type PathZone,
} from "./security.js";
export { FileWatcher, getWatcher, stopAllWatchers, type WatcherCallback } from "./watcher.js";
export { AgentEngine } from "./agent/engine.js";
export { AgentSession, SessionStore, sessionStore } from "./agent/session.js";
export { ToolResultCache } from "./agent/cache.js";
export { estimateTokens, estimateMessageTokens, estimateTotalTokens, pruneMessages } from "./agent/context.js";
export { OpenRouterProvider, DEFAULT_FREE_POOL } from "./agent/providers/openrouter.js";
export type { LLMProvider } from "./agent/provider.js";
export { ToolRegistry, defaultRegistry } from "./agent/tools/registry.js";
export { TOOL_SCHEMAS, TOOL_NAMES } from "./agent/tools/schema.js";
export { listSymbols, extractSymbolContent } from "./agent/tools/symbols.js";
export { TelemetryStore, telemetryStore, type ActiveTask } from "./telemetry/index.js";
export type {
  RequestType,
  TokenUsage,
  RequestRecord,
  TaskStatus,
  TaskRecord,
  ModelDailyStats,
  DailyRollup,
  TelemetryData,
  TelemetrySummary,
} from "./telemetry/index.js";
export {
  initProvider,
  updateProviderKey,
  getProvider,
  getEngine,
  getWorkspace,
  registerWorkspace,
  getSession,
  createSSEStream,
  createCallbackSSEStream,
} from "./routes.js";
