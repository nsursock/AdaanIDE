import type { ModelRegistry, RegistryEntry } from "../registry/index.js";
import type { ModelTier } from "../registry/types.js";
import type { LearnedModelStats } from "./model-stats.js";
import { bayesianSmooth, applyDecay, expectedRequests, expectedRequestsEscalation } from "./model-stats.js";
import type { TaskClassification, TaskCategory } from "../router/classifier.js";
import type { RouterSettings, RouteResult } from "../router/router.js";
import type { DailyRollup } from "../telemetry/types.js";

/**
 * Phase 4: Learning policy — replaces Phase 3's threshold rule inside
 * routeModel when samples >= 3. Uses Thompson sampling for explore/exploit.
 */

export interface DriftAlert {
  model: string;
  category: string;
  severity: number;  // sigma drop
  recentRate: number;
  posteriorRate: number;
}

export interface LearnReport {
  autoRoutedTasks: number;
  manualTasks: number;
  autoSuccessRate: number;
  manualSuccessRate: number;
  expectedVsActual: { expected: number; actual: number };
  topCorrections: string[];
  modelsAdded: string[];
  driftedModels: DriftAlert[];
  topModelsByCategory: Array<{ category: string; model: string; successRate: number; samples: number }>;
}

// --- Thompson sampling -------------------------------------------------------

/**
 * Sample from a Beta(α, β) distribution using a seeded RNG.
 * Uses the gamma-function-based approach: Beta(a,b) = Gamma(a) / (Gamma(a) + Gamma(b)).
 */
function sampleBeta(rng: () => number, alpha: number, beta: number): number {
  // For numerical stability with small α/β, use the rejection method.
  // Simple approximation: use two gamma samples.
  const x = sampleGamma(rng, alpha);
  const y = sampleGamma(rng, beta);
  return x / (x + y);
}

/**
 * Sample from Gamma(shape, 1) using Marsaglia-Tsang method.
 */
function sampleGamma(rng: () => number, shape: number): number {
  if (shape < 1) {
    // Boost: Gamma(shape) = Gamma(shape+1) * U^(1/shape)
    const u = rng();
    return sampleGamma(rng, shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x = sampleNormal(rng);
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * Math.log(v) - d + d) return d * v;
  }
}

/**
 * Box-Muller normal distribution.
 */
function sampleNormal(rng: () => number): number {
  let u1 = rng();
  let u2 = rng();
  while (u1 === 0) u1 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Seeded PRNG (mulberry32) — deterministic for tests.
 */
export function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Thompson sampling: sample from each model's Beta posterior, pick the best draw.
 * Restricted to enabled tiers. Exploration is free when the sampled model is free;
 * paid exploration requires the exploration budget setting to be on.
 */
export function thompsonSelect(
  cls: TaskClassification,
  registry: ModelRegistry,
  settings: RouterSettings,
  learnedStats: LearnedModelStats,
  rng: () => number,
  opts?: { explorationPaidEnabled?: boolean },
): RouteResult | null {
  const all = registry.all();
  if (all.length === 0) return null;

  const needsTools = cls.coding > 0.2 || cls.toolUse > 0.2;
  let candidates = all.filter(
    (e) => settings.allowedTiers.includes(e.tier) && (!needsTools || e.toolsCapable),
  );
  if (candidates.length === 0) {
    candidates = all.filter((e) => settings.allowedTiers.includes(e.tier));
  }
  if (candidates.length === 0) return null;

  const category = cls.category;
  const prior = learnedStats.categoryPrior(category);
  const explorationPaidEnabled = opts?.explorationPaidEnabled ?? false;

  // Sample from each candidate's Beta posterior.
  const draws = candidates.map((entry) => {
    const post = learnedStats.posterior(category, entry.id);
    const alpha = 5 * post.successRate + 0.01;
    const beta = 5 * (1 - post.successRate) + 0.01;
    const draw = sampleBeta(rng, alpha, beta);
    return { entry, draw, samples: post.samples };
  });

  // Filter: if paid exploration is disabled, only allow paid models with >= 3 samples.
  const eligible = draws.filter((d) => {
    if (d.entry.free) return true;  // free exploration is always allowed
    if (explorationPaidEnabled) return true;
    return d.samples >= 3;  // paid models need data to be selected
  });

  if (eligible.length === 0) return null;

  // Pick the best draw.
  eligible.sort((a, b) => b.draw - a.draw);
  const best = eligible[0];
  const post = learnedStats.posterior(category, best.entry.id);

  return {
    model: best.entry.id,
    reason: `learned: ${best.entry.id} ${(post.successRate * 100).toFixed(0)}% on ${category} (n=${post.samples})`,
    category: cls.category,
    classification: cls,
  };
}

/**
 * Route with learning — uses Thompson sampling when samples >= 3,
 * falls back to Phase 3's threshold rule when < 3 samples.
 */
export function routeWithLearning(
  cls: TaskClassification,
  registry: ModelRegistry,
  settings: RouterSettings,
  learnedStats: LearnedModelStats,
  rng?: () => number,
  opts?: { explorationPaidEnabled?: boolean },
): RouteResult | null {
  if (settings.mode === "manual") return null;

  const category = cls.category;
  const ranking = learnedStats.rank(category);
  const hasEnoughData = ranking.some((r) => r.samples >= 3);

  if (hasEnoughData) {
    const result = thompsonSelect(
      cls, registry, settings, learnedStats,
      rng ?? Math.random,
      opts,
    );
    if (result) return result;
  }

  // Fall back to Phase 3 rule (import dynamically to avoid circular dep).
  return null;  // caller falls back to routeModel
}

// --- Drift detection ---------------------------------------------------------

/**
 * Detect drift: compare each model's last-7-day outcome weight against
 * its posterior. A drop > 2σ with ≥ 5 samples flags a drift alert.
 */
export function detectDrift(
  learnedStats: LearnedModelStats,
  rollups: Record<string, DailyRollup>,
  currentDay: string,
): DriftAlert[] {
  const alerts: DriftAlert[] = [];
  const cells = learnedStats.allCells();

  // Compute last-7-day per-model outcome weights per category.
  const recentStats: Record<string, { weighted: number; attempts: number }> = {};
  const sevenDaysAgo = new Date(currentDay);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const cutoff = sevenDaysAgo.toISOString().slice(0, 10);

  for (const [day, rollup] of Object.entries(rollups)) {
    if (day < cutoff) continue;
    for (const [model, ms] of Object.entries(rollup.perModel)) {
      const key = `:${model}`;  // we'll match by model id
      if (!recentStats[key]) recentStats[key] = { weighted: 0, attempts: 0 };
      recentStats[key].attempts += ms.tasks;
      recentStats[key].weighted += ms.taskSuccesses;
    }
  }

  for (const cell of cells) {
    if (cell.attempts < 5) continue;
    const post = learnedStats.posterior(cell.category, cell.model);
    const recent = recentStats[`:${cell.model}`];
    if (!recent || recent.attempts < 3) continue;

    const recentRate = recent.weighted / recent.attempts;
    const drop = post.successRate - recentRate;
    // Rough σ estimate: for a Beta posterior, σ ≈ sqrt(αβ / ((α+β)²(α+β+1)))
    const alpha = 5 * post.successRate;
    const beta = 5 * (1 - post.successRate);
    const sigma = Math.sqrt((alpha * beta) / (Math.pow(alpha + beta, 2) * (alpha + beta + 1)));

    if (drop > 2 * sigma && sigma > 0) {
      alerts.push({
        model: cell.model,
        category: cell.category,
        severity: drop / sigma,
        recentRate,
        posteriorRate: post.successRate,
      });
    }
  }

  return alerts;
}

// --- Weekly report -----------------------------------------------------------

/**
 * Build the weekly self-report — the audit trail proving the learning works.
 */
export function buildReport(
  rollups: Record<string, DailyRollup>,
  learnedStats: LearnedModelStats,
  recentTasks: Array<{ routedBy: string; status: string; outcome: string; prompt: string; requestCount: number; category?: string | null }>,
  currentDay: string,
): LearnReport {
  // Last 7 days.
  const sevenDaysAgo = new Date(currentDay);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const cutoff = sevenDaysAgo.toISOString().slice(0, 10);

  let autoRouted = 0, manual = 0;
  let autoSuccess = 0, manualSuccess = 0;
  let totalExpected = 0, totalActual = 0;
  const corrections: string[] = [];

  for (const task of recentTasks) {
    if (task.routedBy === "auto") {
      autoRouted++;
      if (task.status === "success") autoSuccess++;
    } else {
      manual++;
      if (task.status === "success") manualSuccess++;
    }
    totalActual += task.requestCount;
    if (task.outcome === "corrected" && task.prompt) {
      corrections.push(task.prompt);
    }
  }

  // Expected requests: sum of 1/P(success) per category for auto-routed tasks.
  for (const task of recentTasks) {
    if (task.routedBy === "auto" && task.category) {
      // Use the best model's posterior for this category.
      const ranking = learnedStats.rank(task.category);
      if (ranking.length > 0) {
        totalExpected += expectedRequests(ranking[0].successRate);
      }
    }
  }

  // Top models by category.
  const topModels: Array<{ category: string; model: string; successRate: number; samples: number }> = [];
  const categories = new Set(learnedStats.allCells().map((c) => c.category));
  for (const cat of categories) {
    const ranking = learnedStats.rank(cat);
    if (ranking.length > 0) {
      topModels.push({ category: cat, ...ranking[0] });
    }
  }

  // Drift detection.
  const drifted = detectDrift(learnedStats, rollups, currentDay);

  return {
    autoRoutedTasks: autoRouted,
    manualTasks: manual,
    autoSuccessRate: autoRouted > 0 ? autoSuccess / autoRouted : 0,
    manualSuccessRate: manual > 0 ? manualSuccess / manual : 0,
    expectedVsActual: { expected: totalExpected, actual: totalActual },
    topCorrections: corrections.slice(0, 5),
    modelsAdded: [],  // populated by registry diff
    driftedModels: drifted,
    topModelsByCategory: topModels,
  };
}
