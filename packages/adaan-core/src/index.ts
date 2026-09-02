// Types
export type {
  ThemeId,
  ThemePalette,
  FileNode,
  FileContent,
  SearchResult,
  SymbolEntry,
  WorkspaceInfo,
  ModelInfo,
  ModelGroups,
  AgentEvent,
  AgentEventType,
  ChatMessage,
  ToolCall,
  ProviderMessage,
  ProviderTool,
  ProviderChatOptions,
  ProviderEvent,
  SessionState,
  SessionStatus,
  TaskSummaryData,
  WatcherEvent,
  WatcherEventType,
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolHandler,
} from "./types.js";

// Themes
export { THEMES, DEFAULT_THEME, THEME_IDS, getTheme, themeCSSVars } from "./themes.js";

// Diff (line-level add/modify/remove classification for the editor's
// Accept/Reject review UI)
export { computeLineDiff, changedNewLines, diffStats } from "./diff.js";
export type { DiffOpType, DiffLine, DiffStats } from "./diff.js";

// Stores (client-safe)
export { themeStore, workspaceStore, chatStore, settingsStore } from "./stores/index.js";
export type { OpenTab, PatchSignal, PendingFileChange, ChatMessageEntry, TimelineSegment, Settings } from "./stores/index.js";
export {
  SCHEMA_VERSION,
  STORAGE_KEY,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  CHAT_MIN,
  CHAT_MAX,
  TERMINAL_MIN,
  TERMINAL_MAX,
  DEFAULT_SIDEBAR_W,
  DEFAULT_CHAT_W,
  DEFAULT_TERMINAL_H,
  DEFAULT_SETTINGS,
  type TerminalMode,
  migrateBlob,
  migrateLegacy,
} from "./stores/index.js";
