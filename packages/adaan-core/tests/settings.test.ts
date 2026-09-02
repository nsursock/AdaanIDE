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
