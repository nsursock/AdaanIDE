import { test } from "node:test";
import assert from "node:assert/strict";
import {
  migrateBlob,
  migrateLegacy,
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  CHAT_MIN,
  CHAT_MAX,
  TERMINAL_MIN,
  TERMINAL_MAX,
  modelAliasKey,
} from "../src/stores/settings.js";

test("migrateBlob: empty / null input yields defaults", () => {
  assert.deepEqual(migrateBlob(null), DEFAULT_SETTINGS);
  assert.deepEqual(migrateBlob({}), DEFAULT_SETTINGS);
  assert.deepEqual(migrateBlob("garbage"), DEFAULT_SETTINGS);
});

test("migrateBlob: known fields are preserved, unknown ones dropped", () => {
  const out = migrateBlob({
    theme: "ghibli",
    sidebarWidth: 300,
    chatWidth: 400,
    selectedModelId: "deepseek/deepseek-r1:free",
    threeEnabled: false,
    unknownField: "ignored",
    schemaVersion: 0, // ignored — always rewritten to current
  });
  assert.equal(out.theme, "ghibli");
  assert.equal(out.sidebarWidth, 300);
  assert.equal(out.chatWidth, 400);
  assert.equal(out.selectedModelId, "deepseek/deepseek-r1:free");
  assert.equal(out.threeEnabled, false);
  assert.equal(out.schemaVersion, SCHEMA_VERSION);
  assert.equal("unknownField" in out, false);
});

test("migrateBlob: invalid theme falls back to default", () => {
  assert.equal(migrateBlob({ theme: "nonexistent" }).theme, DEFAULT_SETTINGS.theme);
  assert.equal(migrateBlob({ theme: 123 }).theme, DEFAULT_SETTINGS.theme);
});

test("migrateBlob: out-of-range widths are clamped", () => {
  assert.equal(migrateBlob({ sidebarWidth: 10 }).sidebarWidth, SIDEBAR_MIN);
  assert.equal(migrateBlob({ sidebarWidth: 9999 }).sidebarWidth, SIDEBAR_MAX);
  assert.equal(migrateBlob({ chatWidth: 10 }).chatWidth, CHAT_MIN);
  assert.equal(migrateBlob({ chatWidth: 9999 }).chatWidth, CHAT_MAX);
});

test("migrateBlob: NaN width falls back to min, non-number to default", () => {
  assert.equal(migrateBlob({ sidebarWidth: NaN }).sidebarWidth, SIDEBAR_MIN);
  assert.equal(migrateBlob({ sidebarWidth: "wide" }).sidebarWidth, DEFAULT_SETTINGS.sidebarWidth);
});

test("migrateBlob: terminalHeight is clamped, terminalEnabled coerced to bool", () => {
  assert.equal(migrateBlob({ terminalHeight: 10 }).terminalHeight, TERMINAL_MIN);
  assert.equal(migrateBlob({ terminalHeight: 9999 }).terminalHeight, TERMINAL_MAX);
  assert.equal(migrateBlob({ terminalHeight: 250 }).terminalHeight, 250);
  assert.equal(migrateBlob({ terminalHeight: "tall" }).terminalHeight, DEFAULT_SETTINGS.terminalHeight);
  assert.equal(migrateBlob({ terminalEnabled: true }).terminalEnabled, true);
  assert.equal(migrateBlob({}).terminalEnabled, DEFAULT_SETTINGS.terminalEnabled);
  assert.equal(migrateBlob({ terminalEnabled: "yes" }).terminalEnabled, DEFAULT_SETTINGS.terminalEnabled);
});

test("migrateBlob: terminalMode accepts 'full'/'editor', else defaults to full", () => {
  assert.equal(migrateBlob({ terminalMode: "editor" }).terminalMode, "editor");
  assert.equal(migrateBlob({ terminalMode: "full" }).terminalMode, "full");
  assert.equal(migrateBlob({}).terminalMode, "full");
  assert.equal(migrateBlob({ terminalMode: "wide" }).terminalMode, "full");
  assert.equal(migrateBlob({ terminalMode: 123 }).terminalMode, "full");
});

test("migrateBlob: selectedModelId accepts string or null, else default", () => {
  assert.equal(migrateBlob({ selectedModelId: "x" }).selectedModelId, "x");
  assert.equal(migrateBlob({ selectedModelId: null }).selectedModelId, null);
  assert.equal(migrateBlob({ selectedModelId: 42 }).selectedModelId, DEFAULT_SETTINGS.selectedModelId);
});

test("migrateBlob: openrouterApiKey accepts string or null, else default", () => {
  assert.equal(migrateBlob({ openrouterApiKey: "sk-or-v1-abc" }).openrouterApiKey, "sk-or-v1-abc");
  assert.equal(migrateBlob({ openrouterApiKey: null }).openrouterApiKey, null);
  assert.equal(migrateBlob({ openrouterApiKey: 123 }).openrouterApiKey, DEFAULT_SETTINGS.openrouterApiKey);
  assert.equal(migrateBlob({}).openrouterApiKey, null);
});

test("migrateBlob: singleShotMode accepts auto/always/never, else default", () => {
  assert.equal(migrateBlob({ singleShotMode: "always" }).singleShotMode, "always");
  assert.equal(migrateBlob({ singleShotMode: "never" }).singleShotMode, "never");
  assert.equal(migrateBlob({ singleShotMode: "auto" }).singleShotMode, "auto");
  assert.equal(migrateBlob({ singleShotMode: "invalid" }).singleShotMode, DEFAULT_SETTINGS.singleShotMode);
  assert.equal(migrateBlob({}).singleShotMode, "auto");
});

test("migrateBlob: schema version is 9", () => {
  assert.equal(SCHEMA_VERSION, 9);
  assert.equal(migrateBlob({}).schemaVersion, 9);
  assert.equal(migrateBlob({ schemaVersion: 3 }).schemaVersion, 9);
});

test("migrateBlob: mode accepts editor/agent/stats/monitoring, else defaults to editor", () => {
  assert.equal(migrateBlob({ mode: "stats" }).mode, "stats");
  assert.equal(migrateBlob({ mode: "agent" }).mode, "agent");
  assert.equal(migrateBlob({ mode: "monitoring" }).mode, "monitoring");
  assert.equal(migrateBlob({ mode: "editor" }).mode, "editor");
  assert.equal(migrateBlob({}).mode, "editor");
  assert.equal(migrateBlob({ mode: "invalid" }).mode, "editor");
  assert.equal(migrateBlob({ mode: 123 }).mode, "editor");
});

test("migrateLegacy: folds legacy per-feature keys into a partial", () => {
  const store: Record<string, string> = {
    "adaan-theme": "fiesta",
    "adaan.sidebarWidth": "320",
    "adaan.chatWidth": "420",
  };
  const out = migrateLegacy((k) => store[k] ?? null);
  assert.equal(out.theme, "fiesta");
  assert.equal(out.sidebarWidth, 320);
  assert.equal(out.chatWidth, 420);
});

test("migrateLegacy: missing keys are simply omitted", () => {
  const out = migrateLegacy(() => null);
  assert.equal("theme" in out, false);
  assert.equal("sidebarWidth" in out, false);
  assert.equal("chatWidth" in out, false);
});

test("migrateLegacy: invalid legacy theme is dropped, bad widths clamped", () => {
  const out = migrateLegacy((k) => {
    if (k === "adaan-theme") return "nope";
    if (k === "adaan.sidebarWidth") return "5";
    if (k === "adaan.chatWidth") return "99999";
    return null;
  });
  assert.equal("theme" in out, false);
  assert.equal(out.sidebarWidth, SIDEBAR_MIN);
  assert.equal(out.chatWidth, CHAT_MAX);
});

test("modelAliasKey: builds a stable provider/model key", () => {
  assert.equal(modelAliasKey("ollama", "qwen3:14b"), "ollama/qwen3:14b");
  assert.equal(modelAliasKey("rapid-mlx", "qwen3.5-4b-4bit"), "rapid-mlx/qwen3.5-4b-4bit");
  assert.notEqual(modelAliasKey("ollama", "m"), modelAliasKey("lmstudio", "m"));
});

test("migrateBlob: modelAliases keeps non-empty string values only", () => {
  const out = migrateBlob({
    modelAliases: {
      "ollama/qwen3:14b": "Qwen 14B",
      "rapid-mlx/foo": "  padded  ",
      "lmstudio/empty": "",
      "lmstudio/blank": "   ",
      "ollama/bad": 42,
    },
  });
  assert.equal(out.modelAliases["ollama/qwen3:14b"], "Qwen 14B");
  assert.equal(out.modelAliases["rapid-mlx/foo"], "padded");
  assert.equal("lmstudio/empty" in out.modelAliases, false);
  assert.equal("lmstudio/blank" in out.modelAliases, false);
  assert.equal("ollama/bad" in out.modelAliases, false);
});

test("migrateBlob: modelAliases falls back to empty map on bad input", () => {
  assert.deepEqual(migrateBlob({ modelAliases: null }).modelAliases, {});
  assert.deepEqual(migrateBlob({ modelAliases: "nope" }).modelAliases, {});
  assert.deepEqual(migrateBlob({ modelAliases: ["a", "b"] }).modelAliases, {});
  assert.deepEqual(migrateBlob({}).modelAliases, {});
});

test("migrateBlob: telemetry config defaults when absent", () => {
  const out = migrateBlob({});
  assert.deepEqual(out.telemetry, DEFAULT_SETTINGS.telemetry);
  assert.equal(out.telemetry.enabled, true);
  assert.equal(out.telemetry.maxRecentTasks, 500);
  assert.equal(out.telemetry.maxRecentRequests, 2000);
  assert.equal(out.telemetry.writeDebounceMs, 1500);
  assert.equal(out.telemetry.trendDays, 14);
});

test("migrateBlob: telemetry config preserves valid values", () => {
  const out = migrateBlob({
    telemetry: {
      enabled: false,
      maxRecentTasks: 1000,
      maxRecentRequests: 5000,
      writeDebounceMs: 3000,
      trendDays: 7,
    },
  });
  assert.equal(out.telemetry.enabled, false);
  assert.equal(out.telemetry.maxRecentTasks, 1000);
  assert.equal(out.telemetry.maxRecentRequests, 5000);
  assert.equal(out.telemetry.writeDebounceMs, 3000);
  assert.equal(out.telemetry.trendDays, 7);
});

test("migrateBlob: telemetry config clamps invalid values to defaults", () => {
  const out = migrateBlob({
    telemetry: {
      enabled: "yes",
      maxRecentTasks: -5,
      maxRecentRequests: 0,
      writeDebounceMs: -100,
      trendDays: 0,
    },
  });
  assert.equal(out.telemetry.enabled, true); // non-boolean → default
  assert.equal(out.telemetry.maxRecentTasks, 500);
  assert.equal(out.telemetry.maxRecentRequests, 2000);
  assert.equal(out.telemetry.writeDebounceMs, 1500);
  assert.equal(out.telemetry.trendDays, 14);
});

// ── Performance settings (schema v9) ──────────────────────────────────────

test("migrateBlob: performance config defaults to performance preset", () => {
  const out = migrateBlob({});
  assert.deepEqual(out.performance, DEFAULT_SETTINGS.performance);
  assert.equal(out.performance.preset, "performance");
  assert.equal(out.performance.threeEnabled, false);
  assert.equal(out.performance.threeQuality, "minimal");
  assert.equal(out.performance.pauseWhenHidden, true);
  assert.equal(out.performance.animationsEnabled, false);
  assert.equal(out.performance.glassEffects, false);
  assert.equal(out.performance.streamingRender, "throttled");
  assert.equal(out.performance.editorLiveSync, false);
  assert.equal(out.performance.fileTreeRefresh, "throttled");
});

test("migrateBlob: performance config preserves valid values", () => {
  const out = migrateBlob({
    performance: {
      preset: "performance",
      threeEnabled: false,
      threeQuality: "low",
      pauseWhenHidden: true,
      animationsEnabled: false,
      glassEffects: false,
      streamingRender: "throttled",
      editorLiveSync: false,
      fileTreeRefresh: "throttled",
    },
  });
  assert.equal(out.performance.preset, "performance");
  assert.equal(out.performance.threeEnabled, false);
  assert.equal(out.performance.threeQuality, "low");
  assert.equal(out.performance.pauseWhenHidden, true);
  assert.equal(out.performance.animationsEnabled, false);
  assert.equal(out.performance.glassEffects, false);
  assert.equal(out.performance.streamingRender, "throttled");
  assert.equal(out.performance.editorLiveSync, false);
  assert.equal(out.performance.fileTreeRefresh, "throttled");
});

test("migrateBlob: performance config sanitizes corrupt values to defaults", () => {
  const out = migrateBlob({
    performance: {
      preset: "ultra",
      threeEnabled: "yes",
      threeQuality: "ultra",
      pauseWhenHidden: 1,
      animationsEnabled: null,
      glassEffects: "true",
      streamingRender: "fast",
      editorLiveSync: 0,
      fileTreeRefresh: "lazy",
    },
  });
  assert.equal(out.performance.preset, "performance");
  assert.equal(out.performance.threeEnabled, false);
  assert.equal(out.performance.threeQuality, "minimal");
  assert.equal(out.performance.pauseWhenHidden, true);
  assert.equal(out.performance.animationsEnabled, false);
  assert.equal(out.performance.glassEffects, false);
  assert.equal(out.performance.streamingRender, "throttled");
  assert.equal(out.performance.editorLiveSync, false);
  assert.equal(out.performance.fileTreeRefresh, "throttled");
});

test("migrateBlob: legacy top-level threeEnabled=false carries into performance", () => {
  // A v8 blob with threeEnabled: false but no performance block.
  const out = migrateBlob({ threeEnabled: false });
  assert.equal(out.threeEnabled, false);
  assert.equal(out.performance.threeEnabled, false);
  // No performance block → defaults (performance preset).
  assert.equal(out.performance.preset, "performance");
});

test("migrateBlob: explicit performance.threeEnabled wins over legacy threeEnabled", () => {
  const out = migrateBlob({
    threeEnabled: false,
    performance: { threeEnabled: true },
  });
  assert.equal(out.performance.threeEnabled, true);
  assert.equal(out.threeEnabled, true); // top-level mirrors performance
});

test("migrateBlob: top-level threeEnabled mirrors performance.threeEnabled", () => {
  const out = migrateBlob({
    threeEnabled: true, // legacy says on
    performance: { threeEnabled: false }, // new block says off
  });
  assert.equal(out.performance.threeEnabled, false);
  assert.equal(out.threeEnabled, false); // top-level mirrors performance, not legacy
});
