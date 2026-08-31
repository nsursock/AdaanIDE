// ============================================================================
// Unified user settings — pure logic (no Svelte runes), importable by tests.
// The reactive store lives in `settings.svelte.ts`.
// ============================================================================

import type { ThemeId } from "../types.js";
import { DEFAULT_THEME, THEME_IDS } from "../themes.js";

/** Bump when the persisted shape changes; `migrateBlob` always rewrites to this. */
export const SCHEMA_VERSION = 1;

/** Single localStorage key holding the whole settings blob as JSON. */
export const STORAGE_KEY = "adaan.settings.v1";

/** Legacy per-feature keys folded into the unified blob on first run. */
export const LEGACY_KEYS = ["adaan-theme", "adaan.sidebarWidth", "adaan.chatWidth"];

// Layout bounds — shared between the store, the page wiring, and the panel UI.
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 520;
export const CHAT_MIN = 280;
export const CHAT_MAX = 640;
export const DEFAULT_SIDEBAR_W = 288; // w-72
export const DEFAULT_CHAT_W = 384;    // w-96
export const TERMINAL_MIN = 90;
export const TERMINAL_MAX = 520;
export const DEFAULT_TERMINAL_H = 220;

/** Terminal pane width mode: "full" spans the whole window, "editor" is
 *  contained between the sidebar and chat panes (under the editor only). */
export type TerminalMode = "full" | "editor";
export const TERMINAL_MODES: TerminalMode[] = ["full", "editor"];

export interface Settings {
  schemaVersion: number;
  theme: ThemeId;
  sidebarWidth: number;
  chatWidth: number;
  /** Height of the bottom terminal pane in px (when open). */
  terminalHeight: number;
  /** Whether the bottom terminal pane is shown. */
  terminalEnabled: boolean;
  /** Terminal width mode: "full" = whole window, "editor" = between sidebars. */
  terminalMode: TerminalMode;
  /** Persisted model id; resolved to a full ModelInfo by the chat UI at load. */
  selectedModelId: string | null;
  threeEnabled: boolean;
  /**
   * OpenRouter API key entered via the UI. When null, the server falls back
   * to the OPENROUTER_API_KEY env var. Stored in localStorage in plaintext —
   * acceptable for a local-first IDE but not for a hosted multi-user app.
   */
  openrouterApiKey: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SCHEMA_VERSION,
  theme: DEFAULT_THEME,
  sidebarWidth: DEFAULT_SIDEBAR_W,
  chatWidth: DEFAULT_CHAT_W,
  terminalHeight: DEFAULT_TERMINAL_H,
  terminalEnabled: false,
  terminalMode: "full",
  selectedModelId: null,
  threeEnabled: true,
  openrouterApiKey: null,
};

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function safeTheme(value: unknown): ThemeId {
  return typeof value === "string" && (THEME_IDS as string[]).includes(value)
    ? (value as ThemeId)
    : DEFAULT_THEME;
}

function safeTerminalMode(value: unknown): TerminalMode {
  return typeof value === "string" && (TERMINAL_MODES as string[]).includes(value)
    ? (value as TerminalMode)
    : "full";
}

/**
 * Migrate a parsed JSON blob (of unknown shape / age) to the current schema.
 * Only known fields are copied; everything else falls back to defaults, so a
 * corrupt or partial blob can never crash the app.
 */
export function migrateBlob(raw: unknown): Settings {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    schemaVersion: SCHEMA_VERSION,
    theme: safeTheme(obj.theme),
    sidebarWidth: clamp(
      typeof obj.sidebarWidth === "number" ? obj.sidebarWidth : DEFAULT_SETTINGS.sidebarWidth,
      SIDEBAR_MIN,
      SIDEBAR_MAX,
    ),
    chatWidth: clamp(
      typeof obj.chatWidth === "number" ? obj.chatWidth : DEFAULT_SETTINGS.chatWidth,
      CHAT_MIN,
      CHAT_MAX,
    ),
    terminalHeight: clamp(
      typeof obj.terminalHeight === "number" ? obj.terminalHeight : DEFAULT_SETTINGS.terminalHeight,
      TERMINAL_MIN,
      TERMINAL_MAX,
    ),
    terminalEnabled:
      typeof obj.terminalEnabled === "boolean" ? obj.terminalEnabled : DEFAULT_SETTINGS.terminalEnabled,
    terminalMode: safeTerminalMode(obj.terminalMode),
    selectedModelId:
      typeof obj.selectedModelId === "string"
        ? obj.selectedModelId
        : obj.selectedModelId === null
          ? null
          : DEFAULT_SETTINGS.selectedModelId,
    threeEnabled:
      typeof obj.threeEnabled === "boolean" ? obj.threeEnabled : DEFAULT_SETTINGS.threeEnabled,
    openrouterApiKey:
      typeof obj.openrouterApiKey === "string"
        ? obj.openrouterApiKey
        : obj.openrouterApiKey === null
          ? null
          : DEFAULT_SETTINGS.openrouterApiKey,
  };
}

/**
 * Read the legacy per-feature localStorage keys and fold them into a partial
 * Settings object. Used once on first load if no unified blob exists yet, so
 * users upgrading don't lose their theme / layout.
 *
 * `read` is injected so this stays pure and testable.
 */
export function migrateLegacy(read: (key: string) => string | null): Partial<Settings> {
  const out: Partial<Settings> = {};
  const themeRaw = read(LEGACY_KEYS[0]);
  if (themeRaw && (THEME_IDS as string[]).includes(themeRaw)) {
    out.theme = themeRaw as ThemeId;
  }
  const swRaw = read(LEGACY_KEYS[1]);
  if (swRaw) {
    const sw = Number(swRaw);
    if (Number.isFinite(sw)) out.sidebarWidth = clamp(sw, SIDEBAR_MIN, SIDEBAR_MAX);
  }
  const cwRaw = read(LEGACY_KEYS[2]);
  if (cwRaw) {
    const cw = Number(cwRaw);
    if (Number.isFinite(cw)) out.chatWidth = clamp(cw, CHAT_MIN, CHAT_MAX);
  }
  return out;
}
