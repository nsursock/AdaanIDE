import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EXPERTISE_LEVELS, MODEL_TIERS } from "./types.js";
import type { LivingTaskList, ReviewConfig, ReviewLens, ReviewResult } from "./types.js";

/**
 * Persistent store for monitoring review configs and run results.
 * Lives at `~/.adaan/reviews.json`. Configs are unbounded (user-managed);
 * results are capped to keep the file from growing without limit. Each config
 * also owns a *living task list* that persists across runs (see tasklist.ts).
 */

const STORE_FILE = path.join(os.homedir(), ".adaan", "reviews.json");
const MAX_RESULTS = 100;

export interface ReviewStoreData {
  version: 1;
  configs: ReviewConfig[];
  results: ReviewResult[];
  /** Per-config living task lists, keyed by config id. */
  taskLists: Record<string, LivingTaskList>;
  /** Whether the background scheduler is armed (survives restarts). */
  schedulerEnabled: boolean;
}

const EMPTY: ReviewStoreData = { version: 1, configs: [], results: [], taskLists: {}, schedulerEnabled: false };

/** Generate a short unique id. */
export function reviewId(prefix = ""): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Extract the role from a legacy lens `prompt` field, e.g.
 *  "You're a top 1% software architect. Criticise this project."
 *  → "software architect". Returns null when no role can be recovered. */
function roleFromLegacyPrompt(prompt: string): string | null {
  const m = prompt.match(/you'?re an? (?:top[\s-]*[\d.]+\s*%?\s*)?(.+?)\s*[.!]?\s*critici[sz]e/i);
  return m && m[1].trim() ? m[1].trim() : null;
}

function migrateLens(raw: Record<string, unknown>, index: number): ReviewLens {
  const label = typeof raw.label === "string" && raw.label ? raw.label : `Lens ${index + 1}`;
  let role = typeof raw.role === "string" && raw.role ? raw.role : "";
  if (!role && typeof raw.prompt === "string") role = roleFromLegacyPrompt(raw.prompt) ?? "";
  if (!role) role = label.toLowerCase();
  const lens: ReviewLens = {
    id: typeof raw.id === "string" && raw.id ? raw.id : `lens-${index + 1}`,
    emoji: typeof raw.emoji === "string" && raw.emoji ? raw.emoji : "🔍",
    label,
    role,
  };
  if (typeof raw.code === "string" && raw.code.trim()) lens.code = raw.code.trim().toUpperCase();
  return lens;
}

/** Normalize a raw/legacy config record into a valid ReviewConfig.
 *  Old app versions saved configs without ids (breaking edit/delete, which
 *  both key off the id) and with a different field layout (`intervalHours`,
 *  lens `prompt` instead of `role`). `seenIds` guards against duplicate ids. */
export function migrateReviewConfig(raw: Record<string, unknown>, seenIds?: Set<string>): ReviewConfig {
  let id = typeof raw.id === "string" && raw.id ? raw.id : reviewId("cfg-");
  if (seenIds) {
    while (seenIds.has(id)) id = reviewId("cfg-");
    seenIds.add(id);
  }

  const rawLenses = Array.isArray(raw.lenses) ? raw.lenses : [];
  const expertise = EXPERTISE_LEVELS.includes(raw.expertise as never)
    ? (raw.expertise as ReviewConfig["expertise"])
    : "top-1%";
  const modelTier = MODEL_TIERS.includes(raw.modelTier as never)
    ? (raw.modelTier as ReviewConfig["modelTier"])
    : "free";
  const intervalValue = typeof raw.intervalValue === "number"
    ? raw.intervalValue
    : typeof raw.intervalHours === "number"
      ? raw.intervalHours
      : 0;
  const intervalUnit = raw.intervalUnit === "days" || raw.intervalUnit === "weeks"
    ? raw.intervalUnit
    : "hours";

  const config: ReviewConfig = {
    id,
    name: typeof raw.name === "string" && raw.name ? raw.name : "Untitled Review",
    lenses: rawLenses
      .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
      .map(migrateLens),
    expertise,
    modelTier,
    reviewerModels: Array.isArray(raw.reviewerModels)
      ? raw.reviewerModels.filter((m): m is string => typeof m === "string")
      : [],
    aggregatorModel: typeof raw.aggregatorModel === "string" && raw.aggregatorModel ? raw.aggregatorModel : "auto",
    intervalValue,
    intervalUnit,
    createGitHubIssues: !!raw.createGitHubIssues,
    writeTasksFile: !!raw.writeTasksFile,
    enabled: !!raw.enabled,
  };
  if (typeof raw.targetPath === "string" && raw.targetPath) config.targetPath = raw.targetPath;
  if (typeof raw.workspaceRoot === "string" && raw.workspaceRoot) config.workspaceRoot = raw.workspaceRoot;
  if (typeof raw.lastRunAt === "string") config.lastRunAt = raw.lastRunAt;
  return config;
}

export class ReviewStore {
  private filePath = STORE_FILE;
  private data: ReviewStoreData = { ...EMPTY };
  private loaded = false;

  /** Test hook. */
  _configure(opts?: { filePath?: string }): void {
    if (opts?.filePath) this.filePath = opts.filePath;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ReviewStoreData>;
      // Filter out zombie "running" results — these are from interrupted runs
      // (server restart, browser close, etc.) that never completed. Without
      // this, the UI permanently shows "background review running".
      const rawResults = Array.isArray(parsed.results) ? parsed.results : [];
      const liveResults = rawResults.filter((r) => r.status !== "running");
      const hadZombies = liveResults.length < rawResults.length;

      // Migrate legacy configs (missing/empty ids, old field layout). Track
      // id changes so results and task lists stay linked to their config.
      const rawConfigs: Record<string, unknown>[] = Array.isArray(parsed.configs)
        ? (parsed.configs as unknown as Record<string, unknown>[])
        : [];
      const seenIds = new Set<string>();
      const configs = rawConfigs.map((c) => migrateReviewConfig(c ?? {}, seenIds));
      const idChanges = new Map<string, string>();
      configs.forEach((c, i) => {
        const oldId = typeof rawConfigs[i]?.id === "string" ? rawConfigs[i].id : "";
        if (oldId !== c.id) idChanges.set(oldId, c.id);
      });
      const migrated = idChanges.size > 0 || JSON.stringify(configs) !== JSON.stringify(rawConfigs);

      const results = liveResults.map((r) =>
        idChanges.has(r.configId) ? { ...r, configId: idChanges.get(r.configId)! } : r,
      );
      let taskLists: Record<string, LivingTaskList> =
        parsed.taskLists && typeof parsed.taskLists === "object" ? parsed.taskLists : {};
      for (const [oldId, newId] of idChanges) {
        if (taskLists[oldId] && !taskLists[newId]) {
          taskLists[newId] = { ...taskLists[oldId], configId: newId };
          delete taskLists[oldId];
        }
      }

      this.data = {
        version: 1,
        configs,
        results,
        taskLists,
        schedulerEnabled: parsed.schedulerEnabled === true,
      };
      if (hadZombies || migrated) await this.persist();
    } catch {
      this.data = { ...EMPTY, taskLists: {} };
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  getConfigs(): ReviewConfig[] {
    return this.data.configs;
  }

  getConfig(id: string): ReviewConfig | undefined {
    return this.data.configs.find((c) => c.id === id);
  }

  async saveConfig(config: ReviewConfig): Promise<ReviewConfig> {
    if (!config.id) config = { ...config, id: reviewId("cfg-") };
    const idx = this.data.configs.findIndex((c) => c.id === config.id);
    if (idx >= 0) this.data.configs[idx] = config;
    else this.data.configs.push(config);
    await this.persist();
    return config;
  }

  async deleteConfig(id: string): Promise<void> {
    this.data.configs = this.data.configs.filter((c) => c.id !== id);
    delete this.data.taskLists[id];
    await this.persist();
  }

  /** Update only the `lastRunAt` timestamp on a config (used by scheduler). */
  async touchConfig(id: string, lastRunAt: string): Promise<void> {
    const c = this.data.configs.find((x) => x.id === id);
    if (c) {
      c.lastRunAt = lastRunAt;
      await this.persist();
    }
  }

  getResults(): ReviewResult[] {
    return this.data.results;
  }

  getResult(id: string): ReviewResult | undefined {
    return this.data.results.find((r) => r.id === id);
  }

  async addResult(result: ReviewResult): Promise<void> {
    this.data.results.unshift(result);
    if (this.data.results.length > MAX_RESULTS) {
      this.data.results = this.data.results.slice(0, MAX_RESULTS);
    }
    await this.persist();
  }

  async updateResult(result: ReviewResult): Promise<void> {
    const idx = this.data.results.findIndex((r) => r.id === result.id);
    if (idx >= 0) this.data.results[idx] = result;
    else this.data.results.unshift(result);
    if (this.data.results.length > MAX_RESULTS) {
      this.data.results = this.data.results.slice(0, MAX_RESULTS);
    }
    await this.persist();
  }

  // --- Living task lists -----------------------------------------------------

  getTaskList(configId: string): LivingTaskList | undefined {
    return this.data.taskLists[configId];
  }

  async saveTaskList(list: LivingTaskList): Promise<void> {
    this.data.taskLists[list.configId] = list;
    await this.persist();
  }

  /** Latest result for a config (results are stored newest-first). */
  getLatestResultForConfig(configId: string): ReviewResult | undefined {
    return this.data.results.find((r) => r.configId === configId);
  }

  // --- Scheduler arming state --------------------------------------------------

  getSchedulerEnabled(): boolean {
    return this.data.schedulerEnabled;
  }

  async setSchedulerEnabled(v: boolean): Promise<void> {
    this.data.schedulerEnabled = v;
    await this.persist();
  }
}

/** Shared singleton instance. */
export const reviewStore = new ReviewStore();
