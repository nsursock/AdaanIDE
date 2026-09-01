import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { LLMProvider } from "../agent/provider.js";
import type { DailyRollup } from "../telemetry/types.js";
import { telemetryStore } from "../telemetry/index.js";
import {
  type RegistryEntry,
  type RegistryData,
  type ModelTier,
  mergeEmpirical,
  assignTiers,
} from "./types.js";

const REGISTRY_FILE = path.join(os.homedir(), ".adaan", "model-registry.json");
const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Model registry — persists the OpenRouter catalog locally with a 24h TTL
 * so cold start needs no network. Merges empirical per-model stats from
 * telemetry rollups on every access.
 */
export class ModelRegistry {
  private data: RegistryData = { version: 1, entries: [], refreshedAt: 0 };
  private loaded = false;
  private filePath = REGISTRY_FILE;
  private provider: LLMProvider | null = null;

  /** Test hook — inject a provider and file path. */
  _configure(opts?: { provider?: LLMProvider; filePath?: string }): void {
    if (opts?.provider) this.provider = opts.provider;
    if (opts?.filePath) this.filePath = opts.filePath;
  }

  /** Set the provider (called from routes.ts init). */
  setProvider(provider: LLMProvider): void {
    this.provider = provider;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as RegistryData;
      if (parsed && parsed.version === 1) {
        this.data = parsed;
      }
    } catch {
      // missing / corrupt — start fresh
    }
  }

  /** Pull the live catalog from the provider and persist. */
  async refresh(force = false): Promise<void> {
    await this.load();
    if (!force && Date.now() - this.data.refreshedAt < REGISTRY_TTL_MS) return;
    if (!this.provider) return;

    const groups = await this.provider.listModels();
    const all = [...groups.free, ...groups.paid];
    const baseEntries: Omit<RegistryEntry, "empirical" | "tier">[] = all.map((m) => ({
      id: m.id,
      name: m.name,
      free: m.free,
      pricing: m.pricing,
      contextLength: m.contextLength,
      toolsCapable: m.toolsCapable,
      modalities: [],
      reasoning: false,
    }));

    // Merge empirical + assign tiers.
    const rollups = (telemetryStore as any)._data?.()?.rollups ?? {};
    const merged = mergeEmpirical(baseEntries, rollups);
    const tiered = assignTiers(merged);

    this.data = { version: 1, entries: tiered, refreshedAt: Date.now() };
    await this.persist();
  }

  /** Get all entries (with fresh empirical merge). */
  all(): RegistryEntry[] {
    const rollups = (telemetryStore as any)._data?.()?.rollups ?? {};
    const baseEntries: Omit<RegistryEntry, "empirical" | "tier">[] = this.data.entries.map(
      ({ empirical: _emp, tier: _tier, ...rest }) => rest,
    );
    const merged = mergeEmpirical(baseEntries, rollups);
    return assignTiers(merged);
  }

  /** Get the tier of a model by id. */
  tierOf(id: string): ModelTier {
    const entry = this.all().find((e) => e.id === id);
    return entry?.tier ?? "free";
  }

  /** Get entries filtered by tier. */
  byTier(tier: ModelTier): RegistryEntry[] {
    return this.all().filter((e) => e.tier === tier);
  }

  /** Get a single entry by id. */
  get(id: string): RegistryEntry | undefined {
    return this.all().find((e) => e.id === id);
  }

  /** Whether the cache is stale (older than TTL). */
  get stale(): boolean {
    return Date.now() - this.data.refreshedAt >= REGISTRY_TTL_MS;
  }

  get refreshedAt(): number {
    return this.data.refreshedAt;
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch {
      // best-effort persistence
    }
  }

  /** Expose raw data for tests. */
  _data(): RegistryData {
    return this.data;
  }
}

/** Singleton. */
export const modelRegistry = new ModelRegistry();
