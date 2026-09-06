import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ReviewStore, migrateReviewConfig } from "../src/server/review/store.js";
import type { ReviewConfig } from "../src/server/review/types.js";

const LEGACY_CONFIG = {
  id: "",
  name: "General Software Committee",
  lenses: [
    {
      id: "architecture",
      emoji: "🏛️",
      label: "Software Architect",
      prompt: "You're a top 1% software architect. Criticise this project.",
    },
    {
      id: "security",
      emoji: "🔐",
      label: "Security Engineer",
      prompt: "You're a top 0.1% application security engineer. Criticise this project.",
    },
  ],
  model: "auto",
  aggregatorModel: "auto",
  intervalHours: 12,
  workspaceRoot: "/tmp/ws",
  createGitHubIssues: false,
  enabled: false,
};

test("migrateReviewConfig: assigns an id to a legacy config with an empty id", () => {
  const cfg = migrateReviewConfig(LEGACY_CONFIG);
  assert.ok(cfg.id.startsWith("cfg-"));
  assert.equal(cfg.name, "General Software Committee");
});

test("migrateReviewConfig: maps legacy fields onto the current schema", () => {
  const cfg = migrateReviewConfig(LEGACY_CONFIG);
  assert.equal(cfg.intervalValue, 12);
  assert.equal(cfg.intervalUnit, "hours");
  assert.equal(cfg.expertise, "top-1%");
  assert.equal(cfg.modelTier, "free");
  assert.deepEqual(cfg.reviewerModels, []);
  assert.equal(cfg.aggregatorModel, "auto");
  assert.equal(cfg.workspaceRoot, "/tmp/ws");
});

test("migrateReviewConfig: derives lens role from legacy prompt", () => {
  const cfg = migrateReviewConfig(LEGACY_CONFIG);
  assert.equal(cfg.lenses[0].role, "software architect");
  assert.equal(cfg.lenses[1].role, "application security engineer");
  assert.equal(cfg.lenses[0].label, "Software Architect");
  assert.equal(cfg.lenses[0].emoji, "🏛️");
});

test("migrateReviewConfig: lens without recoverable role falls back to label", () => {
  const cfg = migrateReviewConfig({
    id: "x",
    name: "n",
    lenses: [{ id: "a", emoji: "🧪", label: "QA Engineer", prompt: "do a review" }],
  });
  assert.equal(cfg.lenses[0].role, "qa engineer");
});

test("migrateReviewConfig: valid config passes through unchanged", () => {
  const valid: ReviewConfig = {
    id: "cfg-abc",
    name: "Valid",
    lenses: [{ id: "l1", emoji: "🔍", label: "Lens", role: "engineer" }],
    expertise: "top-10%",
    modelTier: "paid",
    reviewerModels: ["openai/gpt-4o"],
    aggregatorModel: "openrouter/auto",
    intervalValue: 1,
    intervalUnit: "days",
    createGitHubIssues: true,
    writeTasksFile: true,
    enabled: true,
    lastRunAt: "2026-09-01T00:00:00.000Z",
  };
  const cfg = migrateReviewConfig(valid as unknown as Record<string, unknown>);
  assert.deepEqual(cfg, valid);
});

test("migrateReviewConfig: duplicate ids are regenerated", () => {
  const seen = new Set<string>();
  const a = migrateReviewConfig({ ...LEGACY_CONFIG, id: "cfg-dup" }, seen);
  const b = migrateReviewConfig({ ...LEGACY_CONFIG, id: "cfg-dup" }, seen);
  assert.equal(a.id, "cfg-dup");
  assert.notEqual(b.id, "cfg-dup");
});

async function withStore(data: unknown, fn: (store: ReviewStore, file: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-store-"));
  const file = path.join(dir, "reviews.json");
  await fs.writeFile(file, JSON.stringify(data), "utf-8");
  const store = new ReviewStore();
  store._configure({ filePath: file });
  try {
    await fn(store, file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("ReviewStore.load: migrates legacy configs and persists them", () => {
  return withStore({ version: 1, configs: [LEGACY_CONFIG], results: [], taskLists: {} }, async (store, file) => {
    await store.load();
    const configs = store.getConfigs();
    assert.equal(configs.length, 1);
    assert.ok(configs[0].id.startsWith("cfg-"));
    assert.equal(configs[0].intervalValue, 12);

    const onDisk = JSON.parse(await fs.readFile(file, "utf-8"));
    assert.equal(onDisk.configs[0].id, configs[0].id);
    assert.equal(onDisk.configs[0].intervalValue, 12);
  });
});

test("ReviewStore.load: re-links results and task lists when a config id changes", () => {
  return withStore(
    {
      version: 1,
      configs: [LEGACY_CONFIG],
      results: [
        { id: "res-1", configId: "", configName: "General Software Committee", startedAt: "2026-09-01T00:00:00.000Z", tasks: [], rawOutputs: {}, status: "complete", triggeredBy: "manual" },
      ],
      taskLists: { "": { configId: "", tasks: [], updatedAt: "2026-09-01T00:00:00.000Z" } },
    },
    async (store) => {
      await store.load();
      const newId = store.getConfigs()[0].id;
      assert.ok(newId);
      assert.equal(store.getResults()[0].configId, newId);
      assert.ok(store.getTaskList(newId));
      assert.equal(store.getTaskList(newId)!.configId, newId);
      assert.equal(store.getTaskList(""), undefined);
    },
  );
});

test("ReviewStore: delete and edit work after migration", () => {
  return withStore({ version: 1, configs: [LEGACY_CONFIG], results: [], taskLists: {} }, async (store) => {
    await store.load();
    const id = store.getConfigs()[0].id;

    const edited = { ...store.getConfigs()[0], name: "Renamed" };
    await store.saveConfig(edited);
    assert.equal(store.getConfigs().length, 1);
    assert.equal(store.getConfig(id)?.name, "Renamed");

    await store.deleteConfig(id);
    assert.equal(store.getConfigs().length, 0);
  });
});

test("ReviewStore.saveConfig: assigns an id when given an empty one", () => {
  return withStore({ version: 1, configs: [], results: [], taskLists: {} }, async (store) => {
    await store.load();
    const cfg = migrateReviewConfig({ ...LEGACY_CONFIG, id: "" });
    cfg.id = "";
    const saved = await store.saveConfig(cfg);
    assert.ok(saved.id.startsWith("cfg-"));
    assert.equal(store.getConfigs().length, 1);
  });
});
