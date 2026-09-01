import type { DailyRollup } from "../telemetry/types.js";
import type { TaskCategory } from "../router/classifier.js";

export interface BenchmarkResult {
  taskId: string;
  model: string;
  day: string;
  success: boolean;
  requests: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  latencyMs: number;
  verifyDetail: string;
}

export interface CapabilityCell {
  successRate: number;
  samples: number;
  avgCost: number;
  avgLatencyMs: number;
  source: "benchmark" | "organic";
}

export type CapabilityMatrix = Record<TaskCategory, Record<string, CapabilityCell>>;

/**
 * Build a capability matrix from benchmark results + organic telemetry.
 * Pure computation — no storage, no side effects.
 *
 * Benchmark results give per-category scores; organic telemetry fills gaps
 * via the task-type classifier (task prompts already stored in TaskRecord).
 */
export function buildCapabilityMatrix(
  results: BenchmarkResult[],
  rollups: Record<string, DailyRollup>,
  taskRecords?: Array<{ prompt: string; model: string; status: string; category?: string | null }>,
): CapabilityMatrix {
  const categories: TaskCategory[] = [
    "fix", "test", "refactor", "greenfield", "exploration", "chat", "workflow",
  ];

  // Initialize empty matrix.
  const matrix: CapabilityMatrix = {} as CapabilityMatrix;
  for (const cat of categories) {
    matrix[cat] = {};
  }

  // --- Benchmark data ---
  // Group by (taskId-as-category, model).
  const benchGroups: Record<string, Record<string, { successes: number; total: number; cost: number; latency: number }>> = {};
  for (const r of results) {
    const cat = r.taskId as TaskCategory;
    if (!categories.includes(cat)) continue;
    if (!benchGroups[cat]) benchGroups[cat] = {};
    const g = benchGroups[cat];
    if (!g[r.model]) g[r.model] = { successes: 0, total: 0, cost: 0, latency: 0 };
    g[r.model].total++;
    if (r.success) g[r.model].successes++;
    g[r.model].cost += r.cost;
    g[r.model].latency += r.latencyMs;
  }

  for (const [cat, models] of Object.entries(benchGroups)) {
    for (const [model, g] of Object.entries(models)) {
      matrix[cat as TaskCategory][model] = {
        successRate: g.total > 0 ? g.successes / g.total : 0,
        samples: g.total,
        avgCost: g.total > 0 ? g.cost / g.total : 0,
        avgLatencyMs: g.total > 0 ? g.latency / g.total : 0,
        source: "benchmark",
      };
    }
  }

  // --- Organic data from telemetry ---
  // Use perModel stats from rollups as a fallback when no benchmark data.
  // If taskRecords are provided with categories, use those; otherwise, use
  // aggregate per-model task success rates as a rough proxy.
  if (taskRecords && taskRecords.length > 0) {
    // Group organic tasks by (category, model).
    const organicGroups: Record<string, Record<string, { successes: number; total: number }>> = {};
    for (const t of taskRecords) {
      const cat = (t.category as TaskCategory) ?? "chat";
      if (!categories.includes(cat)) continue;
      if (!organicGroups[cat]) organicGroups[cat] = {};
      const g = organicGroups[cat];
      if (!g[t.model]) g[t.model] = { successes: 0, total: 0 };
      g[t.model].total++;
      if (t.status === "success") g[t.model].successes++;
    }

    for (const [cat, models] of Object.entries(organicGroups)) {
      for (const [model, g] of Object.entries(models)) {
        // Only fill if no benchmark data exists for this cell.
        if (!matrix[cat as TaskCategory][model]) {
          matrix[cat as TaskCategory][model] = {
            successRate: g.total > 0 ? g.successes / g.total : 0,
            samples: g.total,
            avgCost: 0,
            avgLatencyMs: 0,
            source: "organic",
          };
        }
      }
    }
  } else {
    // Fallback: use per-model aggregate task success from rollups.
    const perModel: Record<string, { successes: number; total: number }> = {};
    for (const rollup of Object.values(rollups)) {
      for (const [model, ms] of Object.entries(rollup.perModel)) {
        if (!perModel[model]) perModel[model] = { successes: 0, total: 0 };
        perModel[model].successes += ms.taskSuccesses;
        perModel[model].total += ms.tasks;
      }
    }
    // Assign aggregate stats to all categories (rough proxy).
    for (const cat of categories) {
      for (const [model, g] of Object.entries(perModel)) {
        if (!matrix[cat][model]) {
          matrix[cat][model] = {
            successRate: g.total > 0 ? g.successes / g.total : 0,
            samples: g.total,
            avgCost: 0,
            avgLatencyMs: 0,
            source: "organic",
          };
        }
      }
    }
  }

  return matrix;
}
