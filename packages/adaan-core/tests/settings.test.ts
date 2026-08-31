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

test("migrateBlob: selectedModelId accepts string or null, else default", () => {
  assert.equal(migrateBlob({ selectedModelId: "x" }).selectedModelId, "x");
  assert.equal(migrateBlob({ selectedModelId: null }).selectedModelId, null);
  assert.equal(migrateBlob({ selectedModelId: 42 }).selectedModelId, DEFAULT_SETTINGS.selectedModelId);
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
