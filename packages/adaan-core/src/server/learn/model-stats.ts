import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Phase 4: Learned per-model-per-category statistics.
 *
 * Three statistical choices that matter:
 * 1. Bayesian smoothing — Beta posterior with a prior from the global
 *    per-category average. A model at 1/1 never outranks one at 8/10.
 * 2. Recency decay — half-life 14 days. Models that churn weekly don't
 *    stay ranked high from stale data.
 * 3. Expected requests-to-success — the actual objective the router
 *    minimizes: E[requests] = 1 / P(success).
 */

export interface LearnedCell {
  category: string;
  model: string;
  attempts: number;
  weightedSuccesses: number;  // sum of outcome weights
  lastUsedDay: string;
}

export interface LearnedData {
  version: 1;
  cells: Record<string, LearnedCell>;  // key: `${category}:${model}`
}

export interface Posterior {
  successRate: number;
  samples: number;
}

const STATS_FILE = path.join(os.homedir(), ".adaan", "learned-model-stats.json");
const DECAY_HALF_LIFE_DAYS = 14;
const PRIOR_STRENGTH = 5;  // α + β ≈ 5

/**
 * Compute the Bayesian-smoothed success rate.
 * successRate = (weightedSuccesses + α·prior) / (attempts + α + β)
 * where prior is the global average for the category, and α+β = PRIOR_STRENGTH.
 */
export function bayesianSmooth(
  attempts: number,
  weightedSuccesses: number,
  prior: number,
  strength = PRIOR_STRENGTH,
): number {
  const alpha = strength * prior;
  const beta = strength * (1 - prior);
  return (weightedSuccesses + alpha) / (attempts + alpha + beta);
}

/**
 * Apply recency decay. Pure function, clock-injectable for tests.
 * attempts *= 0.5^(Δdays / halfLife)
 */
export function applyDecay(
  attempts: number,
  weightedSuccesses: number,
  lastUsedDay: string,
  currentDay: string,
  halfLifeDays = DECAY_HALF_LIFE_DAYS,
): { attempts: number; weightedSuccesses: number } {
  const last = new Date(lastUsedDay).getTime();
  const current = new Date(currentDay).getTime();
  const deltaDays = (current - last) / (1000 * 60 * 60 * 24);
  if (deltaDays <= 0) return { attempts, weightedSuccesses };
  const factor = Math.pow(0.5, deltaDays / halfLifeDays);
  return {
    attempts: attempts * factor,
    weightedSuccesses: weightedSuccesses * factor,
  };
}

/**
 * Expected requests to success = 1 / P(success).
 * For escalation chains: E = 1/P(cheap) + (1-P(cheap)) * (1 + 1/P(stronger))
 */
export function expectedRequests(pSuccess: number): number {
  if (pSuccess <= 0) return Infinity;
  return 1 / pSuccess;
}

/**
 * Expected requests for a 2-tier escalation chain.
 */
export function expectedRequestsEscalation(
  pCheap: number,
  pStronger: number,
): number {
  if (pCheap <= 0) return 1 / pStronger;
  if (pStronger <= 0) return Infinity;
  return 1 / pCheap + (1 - pCheap) * (1 + 1 / pStronger);
}

export class LearnedModelStats {
  private data: LearnedData = { version: 1, cells: {} };
  private loaded = false;
  private filePath = STATS_FILE;
  private nowFn: () => number = Date.now;

  /** Test hook — inject file path and clock. */
  _configure(opts?: { filePath?: string; now?: () => number }): void {
    if (opts?.filePath) this.filePath = opts.filePath;
    if (opts?.now) this.nowFn = opts.now;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as LearnedData;
      if (parsed && parsed.version === 1) {
        this.data = parsed;
      }
    } catch {
      // missing / corrupt — start fresh
    }
  }

  private cellKey(category: string, model: string): string {
    return `${category}:${model}`;
  }

  private currentDay(): string {
    return new Date(this.nowFn()).toISOString().slice(0, 10);
  }

  /** Record a task outcome. Applies recency decay to existing cells first. */
  record(category: string, model: string, outcomeWeight: number, day: string): void {
    const key = this.cellKey(category, model);
    const cell = this.data.cells[key];
    if (cell) {
      // Apply decay since last use.
      const decayed = applyDecay(cell.attempts, cell.weightedSuccesses, cell.lastUsedDay, day);
      cell.attempts = decayed.attempts + 1;
      cell.weightedSuccesses = decayed.weightedSuccesses + outcomeWeight;
      cell.lastUsedDay = day;
    } else {
      this.data.cells[key] = {
        category,
        model,
        attempts: 1,
        weightedSuccesses: outcomeWeight,
        lastUsedDay: day,
      };
    }
    this.scheduleWrite();
  }

  /** Get the Bayesian-smoothed posterior for a category+model. */
  posterior(category: string, model: string): Posterior {
    const key = this.cellKey(category, model);
    const cell = this.data.cells[key];
    const prior = this.categoryPrior(category);
    if (!cell) {
      return { successRate: prior, samples: 0 };
    }
    const day = this.currentDay();
    const decayed = applyDecay(cell.attempts, cell.weightedSuccesses, cell.lastUsedDay, day);
    return {
      successRate: bayesianSmooth(decayed.attempts, decayed.weightedSuccesses, prior),
      samples: Math.round(decayed.attempts),
    };
  }

  /** Rank models for a category by posterior success rate (descending). */
  rank(category: string): Array<{ model: string; successRate: number; samples: number }> {
    const prior = this.categoryPrior(category);
    const day = this.currentDay();
    const entries = Object.values(this.data.cells).filter((c) => c.category === category);
    return entries
      .map((cell) => {
        const decayed = applyDecay(cell.attempts, cell.weightedSuccesses, cell.lastUsedDay, day);
        return {
          model: cell.model,
          successRate: bayesianSmooth(decayed.attempts, decayed.weightedSuccesses, prior),
          samples: Math.round(decayed.attempts),
        };
      })
      .sort((a, b) => b.successRate - a.successRate);
  }

  /** Compute the global prior for a category (average success across all models). */
  categoryPrior(category: string): number {
    const day = this.currentDay();
    const entries = Object.values(this.data.cells).filter((c) => c.category === category);
    if (entries.length === 0) return 0.5;  // uninformative prior
    let totalAttempts = 0;
    let totalWeighted = 0;
    for (const cell of entries) {
      const decayed = applyDecay(cell.attempts, cell.weightedSuccesses, cell.lastUsedDay, day);
      totalAttempts += decayed.attempts;
      totalWeighted += decayed.weightedSuccesses;
    }
    if (totalAttempts === 0) return 0.5;
    return totalWeighted / totalAttempts;
  }

  /** Get all cells (for reports / drift detection). */
  allCells(): LearnedCell[] {
    return Object.values(this.data.cells);
  }

  /** Get a specific cell (for drift detection). */
  getCell(category: string, model: string): LearnedCell | null {
    return this.data.cells[this.cellKey(category, model)] ?? null;
  }

  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.persist(), 500);
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
    } catch {
      // best-effort
    }
  }

  /** Expose raw data for tests. */
  _data(): LearnedData {
    return this.data;
  }
}

/** Singleton. */
export const learnedStats = new LearnedModelStats();
