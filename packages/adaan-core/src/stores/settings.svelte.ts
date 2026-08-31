import type { ThemeId } from "../types.js";
import {
  SCHEMA_VERSION,
  STORAGE_KEY,
  LEGACY_KEYS,
  DEFAULT_SETTINGS,
  migrateBlob,
  migrateLegacy,
  type Settings,
} from "./settings.js";

const isBrowser = typeof window !== "undefined";

function readBlob(): { blob: unknown; hasBlob: boolean } {
  if (!isBrowser) return { blob: null, hasBlob: false };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { blob: JSON.parse(raw), hasBlob: true };
  } catch {
    // corrupt or unavailable — fall through to defaults
  }
  return { blob: null, hasBlob: false };
}

function loadSettings(): Settings {
  const { blob, hasBlob } = readBlob();
  if (hasBlob) return migrateBlob(blob);
  // First run after upgrade — adopt legacy per-feature keys.
  const legacy = migrateLegacy((k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  });
  return migrateBlob({ ...DEFAULT_SETTINGS, ...legacy });
}

/**
 * Unified, versioned, persisted user settings. Single source of truth for
 * theme, panel widths, selected model, and the Three.js background toggle.
 * Other stores (theme, chat) read from / write to this one.
 */
class SettingsStore {
  settings = $state<Settings>(loadSettings());

  /** Re-load on the client in case SSR ran first with defaults. */
  init() {
    if (isBrowser) this.settings = loadSettings();
  }

  private persist() {
    if (!isBrowser) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
      // Best-effort cleanup of legacy keys after a successful unified write.
      for (const k of LEGACY_KEYS) {
        try {
          localStorage.removeItem(k);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  update(partial: Partial<Settings>) {
    this.settings = { ...this.settings, ...partial, schemaVersion: SCHEMA_VERSION };
    this.persist();
  }

  setTheme(id: ThemeId) {
    this.update({ theme: id });
  }

  setSidebarWidth(n: number) {
    this.update({ sidebarWidth: n });
  }

  setChatWidth(n: number) {
    this.update({ chatWidth: n });
  }

  setSelectedModelId(id: string | null) {
    this.update({ selectedModelId: id });
  }

  setThreeEnabled(b: boolean) {
    this.update({ threeEnabled: b });
  }

  reset() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.persist();
  }
}

export const settingsStore = new SettingsStore();
