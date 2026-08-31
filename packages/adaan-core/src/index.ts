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
  WatcherEvent,
  WatcherEventType,
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolHandler,
} from "./types.js";

// Themes
export { THEMES, DEFAULT_THEME, THEME_IDS, getTheme, themeCSSVars } from "./themes.js";

// Stores (client-safe)
export { themeStore, workspaceStore, chatStore } from "./stores/index.js";
export type { OpenTab, ChatMessageEntry } from "./stores/index.js";
