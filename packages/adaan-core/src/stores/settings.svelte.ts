import type { ThemeId } from "../types.js";
import {
  SCHEMA_VERSION,
  STORAGE_KEY,
  LEGACY_KEYS,
  DEFAULT_SETTINGS,
  migrateBlob,
  migrateLegacy,
  modelAliasKey,
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

  setTerminalHeight(n: number) {
    this.update({ terminalHeight: n });
  }

  setTerminalEnabled(b: boolean) {
    this.update({ terminalEnabled: b });
  }

  setTerminalMode(mode: "full" | "editor") {
    this.update({ terminalMode: mode });
  }

  setSelectedModelId(id: string | null) {
    this.update({ selectedModelId: id });
  }

  setThreeEnabled(b: boolean) {
    this.update({ threeEnabled: b });
  }

  setOpenrouterApiKey(key: string | null) {
    this.update({ openrouterApiKey: key });
  }

  setProviderBaseUrl(url: string | null) {
    this.update({ providerBaseUrl: url });
  }

  setRoutingMode(mode: "auto" | "manual") {
    this.update({ routingMode: mode });
  }

  setRoutingThreshold(n: number) {
    this.update({ routingThreshold: n });
  }

  setRoutingTiers(tiers: ("free" | "mid" | "frontier")[]) {
    this.update({ routingTiers: tiers });
  }

  setLearningEnabled(b: boolean) {
    this.update({ learningEnabled: b });
  }

  setExplorationPaidEnabled(b: boolean) {
    this.update({ explorationPaidEnabled: b });
  }

  setQuotaDailyLimit(n: number) {
    this.update({ quotaDailyLimit: Math.max(0, Math.floor(n)) });
  }

  setSingleLocalModel(b: boolean) {
    this.update({ singleLocalModel: b });
  }

  /** Update a single telemetry tuning parameter and push it to the server. */
  setTelemetryParam<K extends keyof Settings["telemetry"]>(
    key: K,
    value: Settings["telemetry"][K],
  ) {
    const telemetry = { ...this.settings.telemetry, [key]: value };
    this.update({ telemetry });
  }

  /** Replace the entire telemetry config block. */
  setTelemetry(telemetry: Settings["telemetry"]) {
    this.update({ telemetry });
  }

  /** Set (or clear, when `alias` is empty) the display alias for a
   *  discovered local model. Aliases are shown in the model selector. */
  setModelAlias(providerId: string, modelId: string, alias: string) {
    const next = { ...this.settings.modelAliases };
    const trimmed = alias.trim();
    const key = modelAliasKey(providerId, modelId);
    if (trimmed) next[key] = trimmed;
    else delete next[key];
    this.update({ modelAliases: next });
  }

  reset() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.persist();
  }
}

export const settingsStore = new SettingsStore();
