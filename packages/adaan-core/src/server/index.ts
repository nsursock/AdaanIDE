export { Workspace } from "./workspace.js";
export type { ShellResult, GitLogEntry } from "./workspace.js";
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
export { ModelRegistry, modelRegistry } from "./registry/index.js";
export type { RegistryEntry, RegistryData, ModelTier } from "./registry/index.js";
export { mergeEmpirical, assignTiers } from "./registry/index.js";
export { classifyTask, routeModel, DEFAULT_ROUTER_SETTINGS } from "./router/index.js";
export type { TaskClassification, TaskCategory, RouterSettings, RouteResult } from "./router/index.js";
export { BenchmarkRunner, benchmarkRunner, BENCHMARK_TASKS, buildCapabilityMatrix } from "./benchmark/index.js";
export type { BenchmarkResult, CapabilityCell, CapabilityMatrix, BenchmarkTask, BenchmarkProgress } from "./benchmark/index.js";
export { LearnedModelStats, learnedStats, bayesianSmooth, applyDecay, expectedRequests } from "./learn/index.js";
export type { Outcome, LearnedCell, LearnedData, Posterior, LearnReport, DriftAlert } from "./learn/index.js";
export { detectOutcome, isCorrectionMessage, isUpgrade, OUTCOME_WEIGHTS, buildReport, detectDrift, thompsonSelect, routeWithLearning, seededRng } from "./learn/index.js";
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
