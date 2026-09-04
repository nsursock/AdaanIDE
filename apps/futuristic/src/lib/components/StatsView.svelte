<script lang="ts">
  import { onMount } from "svelte";
  import gsap from "gsap";
  import {
    IconBolt,
    IconDatabase,
    IconTrendingUp,
    IconClock,
    IconCpu,
    IconStack,
    IconChartBar,
    IconActivity,
    IconRobot,
    IconScissors,
    IconRefresh,
    IconTrash,
    IconCircleDot,
    IconFlask,
    IconBrain,
    IconAlertTriangle,
    IconFileCode,
    IconCoins,
  } from "@tabler/icons-svelte";
  import type {
    TelemetrySummary,
    RegimeMetrics,
    ModelMatrix,
  } from "@adaan/core/server";
  import MetricCard from "./MetricCard.svelte";
  import Sparkline from "./Sparkline.svelte";

  // --- State ---
  let summary = $state<TelemetrySummary | null>(null);
  let regimes = $state<{ paid: RegimeMetrics; free: RegimeMetrics; local: RegimeMetrics } | null>(null);
  let models = $state<any[]>([]);
  let matrix = $state<ModelMatrix | null>(null);
  let learnReport = $state<any>(null);
  let experiments = $state<any[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let resetting = $state(false);

  const A = "#ff2e9a";
  const A2 = "#b46bff";
  const A3 = "#2ee6ff";

  onMount(() => {
    refreshAll();
    gsap.from(".stats-header", { y: -20, opacity: 0, duration: 0.5, ease: "power2.out" });
  });

  async function refreshAll() {
    loading = true;
    error = null;
    try {
      await Promise.all([loadSummary(), loadRegimes(), loadModels(), loadMatrix(), loadLearnReport(), loadExperiments()]);
    } finally {
      loading = false;
    }
  }

  async function loadSummary() {
    try {
      const res = await fetch("/api/telemetry/summary");
      if (res.ok) summary = (await res.json()) as TelemetrySummary;
    } catch {}
  }
  async function loadRegimes() {
    try {
      const res = await fetch("/api/telemetry/regimes?days=7");
      if (res.ok) {
        const data = await res.json();
        regimes = { paid: data.paid, free: data.free, local: data.local };
      }
    } catch {}
  }
  async function loadModels() {
    try {
      const res = await fetch("/api/telemetry/models");
      if (res.ok) {
        const data = await res.json();
        models = data.models ?? [];
      }
    } catch {}
  }
  async function loadMatrix() {
    try {
      const res = await fetch("/api/capability");
      if (res.ok) {
        const data = await res.json();
        matrix = data.organic ?? null;
      }
    } catch {}
  }
  async function loadLearnReport() {
    try {
      const res = await fetch("/api/learn/report");
      if (res.ok) learnReport = await res.json();
    } catch {}
  }
  async function loadExperiments() {
    try {
      const res = await fetch("/api/telemetry/experiments");
      if (res.ok) {
        const data = await res.json();
        experiments = data.experiments ?? [];
      }
    } catch {}
  }

  let showResetConfirm = $state(false);

  async function resetStats() {
    if (resetting) return;
    resetting = true;
    try {
      const res = await fetch("/api/telemetry/reset", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        error = data.error ?? "Failed to reset telemetry";
        return;
      }
      summary = null; regimes = null; models = []; matrix = null; learnReport = null; experiments = [];
      await refreshAll();
    } catch (e) {
      error = e instanceof Error ? e.message : "Network error";
    } finally {
      resetting = false;
      showResetConfirm = false;
    }
  }

  // --- Formatters ---
  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }
  function fmtCost(c: number): string {
    if (c === 0) return "$0";
    if (c < 0.01) return `$${c.toFixed(4)}`;
    return `$${c.toFixed(2)}`;
  }
  function fmtDuration(ms: number): string {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(0)}s`;
    const m = Math.floor(s / 60);
    return `${m}m${Math.round(s % 60)}s`;
  }
  function pct(v: number): string {
    return `${(v * 100).toFixed(0)}%`;
  }

  // --- Derived trend data for sparklines ---
  let trendTasks = $derived(summary ? summary.trend.map((d) => d.tasks) : []);
  let trendRequests = $derived(summary ? summary.trend.map((d) => d.requests) : []);
  let trendSuccess = $derived(
    summary
      ? summary.trend.map((d) => (d.tasks > 0 ? d.successfulTasks / d.tasks * 100 : 0))
      : [],
  );
  let trendCost = $derived(summary ? summary.trend.map((d) => d.cost) : []);
  let trendInputTokens = $derived(summary ? summary.trend.map((d) => d.inputTokens) : []);
  let trendOutputTokens = $derived(summary ? summary.trend.map((d) => d.outputTokens) : []);
  let trendToolCalls = $derived(summary ? summary.trend.map((d) => d.toolCalls) : []);
  let trendCacheHits = $derived(summary ? summary.trend.map((d) => d.cacheHits) : []);
  let trendFilesModified = $derived(summary ? summary.trend.map((d) => d.filesModified) : []);
  let trendMaxTasks = $derived(Math.max(1, ...trendTasks));
  let trendMaxReqs = $derived(Math.max(1, ...trendRequests));
  let trendMaxCost = $derived(Math.max(0.01, ...trendCost));
  let trendMaxTokens = $derived(Math.max(1, ...trendInputTokens, ...trendOutputTokens));
  let trendMaxTools = $derived(Math.max(1, ...trendToolCalls, ...trendCacheHits));
  let trendMaxFiles = $derived(Math.max(1, ...trendFilesModified));

  let today = $derived(summary?.today);
  let free = $derived(regimes?.free ?? null);
  let paid = $derived(regimes?.paid ?? null);
  let local = $derived(regimes?.local ?? null);
  let reduction = $derived(summary?.reduction ?? null);
  let optimize = $derived(summary?.optimize ?? null);
  let recentTasks = $derived(summary?.recentTasks ?? []);

  // --- Token breakdown derived ---
  let totalTokens = $derived(today ? today.inputTokens + today.outputTokens + today.cachedTokens + today.reasoningTokens : 0);
  let tokenPct = $derived((n: number) => totalTokens > 0 ? (n / totalTokens) * 100 : 0);

  // --- Outcome distribution derived from recent tasks ---
  let outcomeDist = $derived.by(() => {
    const counts: Record<string, number> = {};
    for (const t of recentTasks) {
      const o = t.outcome || "silent";
      counts[o] = (counts[o] ?? 0) + 1;
    }
    const order = ["verified", "accepted", "silent", "corrected", "rejected", "rolled_back"];
    return order
      .filter((k) => counts[k])
      .map((k) => ({ outcome: k, count: counts[k], pct: recentTasks.length > 0 ? counts[k] / recentTasks.length : 0 }));
  });

  // --- Tool activity derived ---
  let toolActivity = $derived(today ? {
    toolCalls: today.toolCalls,
    cacheHits: today.cacheHits,
    filesRead: today.filesRead,
    filesModified: today.filesModified,
    cacheHitRate: today.toolCalls + today.cacheHits > 0 ? today.cacheHits / (today.cacheHits + today.toolCalls) : 0,
  } : null);

  let displayModels = $derived(matrix ? matrix.models.slice(0, 6) : []);
  let categories = $derived(matrix ? matrix.categories : []);
  function cellFor(cat: string, model: string) {
    return matrix?.byCategory[cat]?.find((c) => c.model === model);
  }

  let topModels = $derived(
    [...models].sort((a, b) => b.n - a.n).slice(0, 6),
  );

  // --- Outcome colors ---
  const outcomeColors: Record<string, string> = {
    verified: "var(--color-success, #4ade80)",
    accepted: "var(--color-success, #4ade80)",
    silent: "var(--color-muted, #94a3b8)",
    corrected: "var(--color-warning, #fbbf24)",
    rejected: "var(--color-error, #f87171)",
    rolled_back: "var(--color-error, #f87171)",
  };
  const outcomeLabels: Record<string, string> = {
    verified: "Verified",
    accepted: "Accepted",
    silent: "Silent",
    corrected: "Corrected",
    rejected: "Rejected",
    rolled_back: "Rolled Back",
  };
</script>

<div class="stats-view">
  <!-- Header -->
  <header class="stats-header">
    <div>
      <div class="stats-title">Telemetry</div>
      <div class="stats-subtitle">
        {#if today}
          {today.tasks} tasks today · {today.requests} requests · {fmtCost(today.cost)}
        {:else}
          Loading…
        {/if}
      </div>
    </div>
    <div class="stats-actions">
      <button class="stats-btn" onclick={refreshAll} disabled={loading} title="Refresh">
        <IconRefresh size={16} class={loading ? "spin" : ""} />
      </button>
      <button class="stats-btn stats-btn-danger" onclick={() => (showResetConfirm = true)} disabled={resetting || loading} title="Reset all stats">
        <IconTrash size={16} />
      </button>
    </div>
  </header>

  {#if error}
    <div class="stats-error">{error}</div>
  {/if}

  <!-- Masonry grid -->
  <div class="card-grid">
    {#if loading && !summary}
      <div class="stats-empty">Loading telemetry…</div>
    {:else if !summary && !regimes}
      <div class="stats-empty">
        <IconChartBar size={32} />
        <div>No telemetry data yet.</div>
        <div class="stats-empty-hint">Run some agent tasks to populate the dashboard.</div>
      </div>
    {:else}
      <!-- Killer metric: tasks / 1k requests -->
      <MetricCard label="Tasks / 1k Requests" index={0}>
        {#snippet icon()}<IconBolt size={26} />{/snippet}
        {#snippet children()}
          <div class="big-metric">
            <span class="big-number" style="color:var(--color-accent);text-shadow:0 0 24px rgba(var(--accent-rgb),0.5);">
              {summary?.successfulTasksPer1000Requests.toFixed(1) ?? "0.0"}
            </span>
          </div>
          <div class="card-hint">Successful tasks per 1,000 LLM requests today — optimizes against OpenRouter's daily cap.</div>
        {/snippet}
      </MetricCard>

      <!-- Daily quota -->
      {#if free && free.tasks > 0}
        <MetricCard label="Daily Quota" index={1}>
          {#snippet icon()}<IconDatabase size={26} />{/snippet}
          {#snippet children()}
            <div class="big-metric">
              <span class="big-number">{free.quotaConsumed}</span>
              <span class="big-side">{free.quotaConsumed + free.quotaRemaining} cap</span>
            </div>
            <div class="usage-bar">
              <div
                class="usage-fill {free.quotaUsedPct >= 0.9 ? 'fill-critical' : free.quotaUsedPct >= 0.7 ? 'fill-warning' : ''}"
                style="width:{Math.max(2, free.quotaUsedPct * 100)}%"
              ></div>
            </div>
            <div class="kv-grid" style="margin-top:0.4rem;">
              <div class="kv"><span class="kv-k">Used</span><span class="kv-v">{pct(free.quotaUsedPct)}</span></div>
              <div class="kv"><span class="kv-k">Remaining</span><span class="kv-v" style="color:var(--color-success);">{free.quotaRemaining}</span></div>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Today overview -->
      {#if today}
        <MetricCard label="Today — Overview" index={2}>
          {#snippet icon()}<IconTrendingUp size={26} />{/snippet}
          {#snippet children()}
            <div class="kv-grid">
              <div class="kv"><span class="kv-k">Tasks</span><span class="kv-v">{today.tasks}</span></div>
              <div class="kv"><span class="kv-k">Success</span><span class="kv-v" style="color:var(--color-success);">{today.successfulTasks}</span></div>
              <div class="kv"><span class="kv-k">Errors</span><span class="kv-v" style="color:var(--color-error);">{today.erroredTasks}</span></div>
              <div class="kv"><span class="kv-k">Cancelled</span><span class="kv-v">{today.cancelledTasks}</span></div>
              <div class="kv"><span class="kv-k">Requests</span><span class="kv-v">{today.requests}</span></div>
              <div class="kv"><span class="kv-k">Reqs/task</span><span class="kv-v">{summary?.requestsPerTask.toFixed(1) ?? "0"}</span></div>
              <div class="kv"><span class="kv-k">Tokens/task</span><span class="kv-v">{fmtTokens(summary?.tokensPerTask ?? 0)}</span></div>
              <div class="kv"><span class="kv-k">Avg time</span><span class="kv-v">{fmtDuration(summary?.avgTaskDurationMs ?? 0)}</span></div>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Success rate -->
      {#if free && free.tasks > 0}
        <MetricCard label="Success Rate" index={3}>
          {#snippet icon()}<IconCircleDot size={26} />{/snippet}
          {#snippet children()}
            <div class="big-metric">
              <span class="big-number" style="color:{free.successRate >= 0.6 ? 'var(--color-success)' : free.successRate >= 0.3 ? 'var(--color-warning)' : 'var(--color-error)'};">
                {pct(free.successRate)}
              </span>
              <span class="big-side">{free.successfulTasks}/{free.tasks}</span>
            </div>
            <div class="kv-grid" style="margin-top:0.4rem;">
              <div class="kv"><span class="kv-k">Tasks/100req</span><span class="kv-v">{free.tasksPer100Requests.toFixed(1)}</span></div>
              <div class="kv"><span class="kv-k">Reqs/ok task</span><span class="kv-v">{free.requestsPerSuccessfulTask.toFixed(1)}</span></div>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Cost economics (paid) -->
      {#if paid && paid.tasks > 0}
        <MetricCard label="Cost Economics" index={4}>
          {#snippet icon()}<IconDatabase size={26} />{/snippet}
          {#snippet children()}
            <div class="big-metric">
              <span class="big-number">{fmtCost(paid.cost)}</span>
              <span class="big-side">total</span>
            </div>
            <div class="kv-grid" style="margin-top:0.4rem;">
              <div class="kv"><span class="kv-k">Cost/task</span><span class="kv-v">{fmtCost(paid.costPerTask)}</span></div>
              <div class="kv"><span class="kv-k">Cost/ok task</span><span class="kv-v">{fmtCost(paid.costPerSuccessfulTask)}</span></div>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Reliability -->
      {#if free && free.tasks > 0}
        <MetricCard label="Reliability" index={5}>
          {#snippet icon()}<IconActivity size={26} />{/snippet}
          {#snippet children()}
            <div class="kv-grid">
              <div class="kv"><span class="kv-k">Escalation</span><span class="kv-v">{pct(free.escalationRate)}</span></div>
              <div class="kv"><span class="kv-k">Retry</span><span class="kv-v">{pct(free.retryRate)}</span></div>
              <div class="kv"><span class="kv-k">Fallback</span><span class="kv-v">{pct(free.fallbackRate)}</span></div>
              <div class="kv"><span class="kv-k">Cache hit</span><span class="kv-v" style="color:var(--color-success);">{pct(free.cacheHitRate)}</span></div>
              <div class="kv"><span class="kv-k">Tool calls/task</span><span class="kv-v">{free.toolCallsPerTask.toFixed(1)}</span></div>
              <div class="kv"><span class="kv-k">P50 latency</span><span class="kv-v">{fmtDuration(free.p50LatencyMs)}</span></div>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Context reduction -->
      {#if reduction}
        <MetricCard label="Context Reduction" index={6}>
          {#snippet icon()}<IconScissors size={26} />{/snippet}
          {#snippet children()}
            <div class="big-metric">
              <span class="big-number" style="color:var(--color-accent-cyan);">{pct(summary?.contextSavingsPct ?? 0)}</span>
              <span class="big-side">saved</span>
            </div>
            <div class="kv-grid" style="margin-top:0.4rem;">
              <div class="kv"><span class="kv-k">Truncation</span><span class="kv-v">{fmtTokens(reduction.truncationTokensSaved)}</span></div>
              <div class="kv"><span class="kv-k">Compaction</span><span class="kv-v">{fmtTokens(reduction.compactionTokensSaved)}</span></div>
              <div class="kv"><span class="kv-k">Redundant blocked</span><span class="kv-v">{reduction.redundantCallsAvoided}</span></div>
              <div class="kv"><span class="kv-k">Snapshot tasks</span><span class="kv-v">{reduction.snapshotTasks}</span></div>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Optimization -->
      {#if optimize}
        <MetricCard label="Optimization" index={7}>
          {#snippet icon()}<IconRobot size={26} />{/snippet}
          {#snippet children()}
            <div class="kv-grid">
              <div class="kv"><span class="kv-k">Auto-routed</span><span class="kv-v">{optimize.autoRoutedTasks}</span></div>
              <div class="kv"><span class="kv-k">Escalations</span><span class="kv-v">{optimize.escalations}</span></div>
              <div class="kv"><span class="kv-k">Esc. success</span><span class="kv-v" style="color:var(--color-success);">{pct(optimize.escalationSuccessRate)}</span></div>
              <div class="kv"><span class="kv-k">Esc. rate</span><span class="kv-v">{pct(optimize.escalationRate)}</span></div>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Local compute -->
      {#if local && local.tasks > 0}
        <MetricCard label="Local Compute" index={8}>
          {#snippet icon()}<IconCpu size={26} />{/snippet}
          {#snippet children()}
            <div class="kv-grid">
              <div class="kv"><span class="kv-k">Tasks/hour</span><span class="kv-v">{local.tasksPerHour.toFixed(1)}</span></div>
              <div class="kv"><span class="kv-k">Est. tok/s</span><span class="kv-v">{local.tokensPerSecond.toFixed(0)}</span></div>
              <div class="kv"><span class="kv-k">Time/ok task</span><span class="kv-v">{fmtDuration(local.timePerSuccessfulTaskMs)}</span></div>
              <div class="kv"><span class="kv-k">Tasks</span><span class="kv-v">{local.tasks}</span></div>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Token Breakdown -->
      {#if today && totalTokens > 0}
        <MetricCard label="Token Breakdown" index={9}>
          {#snippet icon()}<IconCoins size={26} />{/snippet}
          {#snippet children()}
            <div class="big-metric">
              <span class="big-number">{fmtTokens(totalTokens)}</span>
              <span class="big-side">total today</span>
            </div>
            <div class="stacked-bar" style="margin-top:0.3rem;">
              <div class="stacked-seg" style="width:{tokenPct(today.inputTokens)}%;background:var(--color-accent);" title="Input"></div>
              <div class="stacked-seg" style="width:{tokenPct(today.outputTokens)}%;background:var(--color-accent-secondary);" title="Output"></div>
              <div class="stacked-seg" style="width:{tokenPct(today.cachedTokens)}%;background:var(--color-accent-cyan);" title="Cached"></div>
              <div class="stacked-seg" style="width:{tokenPct(today.reasoningTokens)}%;background:rgba(var(--accent-3-rgb),0.4);" title="Reasoning"></div>
            </div>
            <div class="legend-col" style="margin-top:0.4rem;">
              <span><span class="legend-dot" style="background:var(--color-accent);"></span>Input {fmtTokens(today.inputTokens)}</span>
              <span><span class="legend-dot" style="background:var(--color-accent-secondary);"></span>Output {fmtTokens(today.outputTokens)}</span>
              <span><span class="legend-dot" style="background:var(--color-accent-cyan);"></span>Cached {fmtTokens(today.cachedTokens)}</span>
              <span><span class="legend-dot" style="background:rgba(var(--accent-3-rgb),0.5);"></span>Reasoning {fmtTokens(today.reasoningTokens)}</span>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Tool Activity -->
      {#if toolActivity && (toolActivity.toolCalls > 0 || toolActivity.filesModified > 0)}
        <MetricCard label="Tool Activity" index={10}>
          {#snippet icon()}<IconFileCode size={26} />{/snippet}
          {#snippet children()}
            <div class="kv-grid">
              <div class="kv"><span class="kv-k">Tool calls</span><span class="kv-v">{toolActivity.toolCalls}</span></div>
              <div class="kv"><span class="kv-k">Cache hits</span><span class="kv-v" style="color:var(--color-success);">{toolActivity.cacheHits}</span></div>
              <div class="kv"><span class="kv-k">Files read</span><span class="kv-v">{toolActivity.filesRead}</span></div>
              <div class="kv"><span class="kv-k">Files modified</span><span class="kv-v" style="color:var(--color-accent);">{toolActivity.filesModified}</span></div>
            </div>
            <div class="card-divider"></div>
            <div style="display:flex;align-items:center;justify-content:space-between;">
              <span class="card-section-label" style="margin:0;">Cache hit rate</span>
              <span style="font-size:1rem;font-weight:700;color:var(--color-success);">{pct(toolActivity.cacheHitRate)}</span>
            </div>
            <div class="usage-bar" style="margin-top:0.3rem;">
              <div class="usage-fill" style="width:{toolActivity.cacheHitRate * 100}%;background:linear-gradient(90deg,var(--color-success),var(--color-accent-cyan));"></div>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Outcome Distribution -->
      {#if outcomeDist.length > 0}
        <MetricCard label="Task Outcomes" index={11}>
          {#snippet icon()}<IconCircleDot size={26} />{/snippet}
          {#snippet children()}
            <div class="outcome-list">
              {#each outcomeDist as o (o.outcome)}
                <div class="outcome-row">
                  <span class="outcome-dot" style="background:{outcomeColors[o.outcome]};"></span>
                  <span class="outcome-label">{outcomeLabels[o.outcome] ?? o.outcome}</span>
                  <div class="outcome-bar-track">
                    <div class="outcome-bar-fill" style="width:{o.pct * 100}%;background:{outcomeColors[o.outcome]};"></div>
                  </div>
                  <span class="outcome-count">{o.count}</span>
                  <span class="outcome-pct">{pct(o.pct)}</span>
                </div>
              {/each}
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- 14-day task trend -->
      {#if trendTasks.length > 2}
        <MetricCard label="14-Day Task Trend" index={12}>
          {#snippet icon()}<IconChartBar size={26} />{/snippet}
          {#snippet children()}
            <Sparkline series={[{ data: trendTasks, color: A, fill: true }]} max={trendMaxTasks} height={60} />
            <div class="legend-row">
              <span><span class="legend-dot" style="background:{A};"></span>Tasks/day</span>
              <span style="margin-left:auto;color:var(--color-muted);">{trendTasks.length} days</span>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Request + cost trend -->
      {#if trendRequests.length > 2}
        <MetricCard label="Request & Cost Trend" index={13}>
          {#snippet icon()}<IconTrendingUp size={26} />{/snippet}
          {#snippet children()}
            <Sparkline series={[
              { data: trendRequests, color: A3, fill: true },
              { data: trendCost.map((c) => c * trendMaxReqs / trendMaxCost), color: A },
            ]} max={trendMaxReqs} height={60} />
            <div class="legend-row">
              <span><span class="legend-dot" style="background:{A3};"></span>Requests</span>
              <span><span class="legend-dot" style="background:{A};"></span>Cost (scaled)</span>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Success rate trend -->
      {#if trendSuccess.length > 2}
        <MetricCard label="Success Rate Trend" index={14}>
          {#snippet icon()}<IconCircleDot size={26} />{/snippet}
          {#snippet children()}
            <Sparkline series={[{ data: trendSuccess, color: A2, fill: true }]} max={100} height={50} />
            <div class="legend-row">
              <span><span class="legend-dot" style="background:{A2};"></span>Success %</span>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Token trend (input vs output) -->
      {#if trendInputTokens.length > 2}
        <MetricCard label="14-Day Token Trend" index={15}>
          {#snippet icon()}<IconCoins size={26} />{/snippet}
          {#snippet children()}
            <Sparkline series={[
              { data: trendInputTokens, color: A, fill: true },
              { data: trendOutputTokens, color: A3 },
            ]} max={trendMaxTokens} height={60} />
            <div class="legend-row">
              <span><span class="legend-dot" style="background:{A};"></span>Input</span>
              <span><span class="legend-dot" style="background:{A3};"></span>Output</span>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Tool activity trend -->
      {#if trendToolCalls.length > 2}
        <MetricCard label="14-Day Tool Activity" index={16}>
          {#snippet icon()}<IconActivity size={26} />{/snippet}
          {#snippet children()}
            <Sparkline series={[
              { data: trendToolCalls, color: A, fill: true },
              { data: trendCacheHits, color: A3 },
            ]} max={trendMaxTools} height={50} />
            <div class="legend-row">
              <span><span class="legend-dot" style="background:{A};"></span>Tool calls</span>
              <span><span class="legend-dot" style="background:{A3};"></span>Cache hits</span>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Files modified trend -->
      {#if trendFilesModified.length > 2}
        <MetricCard label="14-Day Files Modified" index={17}>
          {#snippet icon()}<IconFileCode size={26} />{/snippet}
          {#snippet children()}
            <Sparkline series={[{ data: trendFilesModified, color: A2, fill: true }]} max={trendMaxFiles} height={50} />
            <div class="legend-row">
              <span><span class="legend-dot" style="background:{A2};"></span>Files modified/day</span>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Top models -->
      {#if topModels.length > 0}
        <MetricCard label="Top Models" index={18}>
          {#snippet icon()}<IconCpu size={26} />{/snippet}
          {#snippet children()}
            <div class="mini-table">
              {#each topModels as row (row.model)}
                <div class="mini-row">
                  <span class="mini-name" title={row.model}>{row.model.split("/").pop()}</span>
                  <span class="mini-num">{row.n}</span>
                  <span class="mini-num {row.successRate >= 0.6 ? 'ok' : row.successRate > 0 ? 'mid' : 'bad'}">{pct(row.successRate)}</span>
                  <span class="mini-num">{row.requestsPerTask.toFixed(1)}</span>
                  <span class="mini-num">{fmtCost(row.cost)}</span>
                </div>
              {/each}
            </div>
            <div class="legend-row" style="font-size:0.5625rem;">
              <span>Model</span><span>N</span><span>Success</span><span>Reqs</span><span>Cost</span>
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Capability matrix -->
      {#if matrix && matrix.cells.length > 0}
        <MetricCard label="Capability Matrix" index={19}>
          {#snippet icon()}<IconStack size={26} />{/snippet}
          {#snippet children()}
            <div class="matrix-grid">
              <div class="matrix-header-row" style="grid-template-columns: 1fr repeat({displayModels.length}, auto);">
                <span class="matrix-cat-label">Category</span>
                {#each displayModels as model}
                  <span class="matrix-model" title={model}>{model.split("/").pop()}</span>
                {/each}
              </div>
              {#each categories as cat}
                <div class="matrix-row" style="grid-template-columns: 1fr repeat({displayModels.length}, auto);">
                  <span class="matrix-cat-label">{cat}</span>
                  {#each displayModels as model}
                    {@const cell = cellFor(cat, model)}
                    {#if cell}
                      <span
                        class="matrix-cell {cell.lowConfidence ? 'low-conf' : ''} {cell.rate >= 0.6 ? 'cell-good' : cell.rate > 0 ? 'cell-mid' : 'cell-bad'}"
                        title={`${model} · ${cat}: ${pct(cell.rate)} (N=${cell.n})`}
                      >{pct(cell.rate)}<span class="cell-n">({cell.n})</span></span>
                    {:else}
                      <span class="matrix-cell cell-empty">—</span>
                    {/if}
                  {/each}
                </div>
              {/each}
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Recent tasks -->
      {#if recentTasks.length > 0}
        <MetricCard label="Recent Tasks" index={20}>
          {#snippet icon()}<IconClock size={26} />{/snippet}
          {#snippet children()}
            <div class="events-list">
              {#each recentTasks.slice(0, 12) as task (task.taskId)}
                <div class="event-row">
                  <span class="event-status status-{task.status}">●</span>
                  <span class="event-prompt" title={task.prompt}>{task.prompt || "(empty)"}</span>
                  <span class="event-meta">{task.requestCount}r</span>
                  <span class="event-meta">{fmtTokens(task.inputTokens + task.outputTokens)}</span>
                  <span class="event-meta">{fmtCost(task.cost)}</span>
                </div>
              {/each}
            </div>
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Learning Report -->
      {#if learnReport}
        <MetricCard label="Learning Report" index={21}>
          {#snippet icon()}<IconBrain size={26} />{/snippet}
          {#snippet children()}
            <div class="kv-grid">
              <div class="kv"><span class="kv-k">Auto-routed</span><span class="kv-v">{learnReport.autoRoutedTasks}</span></div>
              <div class="kv"><span class="kv-k">Manual</span><span class="kv-v">{learnReport.manualTasks}</span></div>
              <div class="kv"><span class="kv-k">Auto success</span><span class="kv-v" style="color:var(--color-success);">{pct(learnReport.autoSuccessRate)}</span></div>
              <div class="kv"><span class="kv-k">Manual success</span><span class="kv-v">{pct(learnReport.manualSuccessRate)}</span></div>
              <div class="kv"><span class="kv-k">Expected reqs</span><span class="kv-v">{learnReport.expectedVsActual?.expected.toFixed(1) ?? "—"}</span></div>
              <div class="kv"><span class="kv-k">Actual reqs</span><span class="kv-v">{learnReport.expectedVsActual?.actual.toFixed(1) ?? "—"}</span></div>
            </div>
            {#if learnReport.topModelsByCategory?.length > 0}
              <div class="card-divider"></div>
              <div class="card-section-label">Top Models by Category</div>
              <div class="mini-table" style="margin-top:0.2rem;">
                {#each learnReport.topModelsByCategory.slice(0, 6) as entry}
                  <div class="mini-row" style="grid-template-columns: 1fr 1fr auto auto;">
                    <span class="mini-name" style="text-transform:capitalize;">{entry.category}</span>
                    <span class="mini-name" title={entry.model}>{entry.model.split("/").pop()}</span>
                    <span class="mini-num {entry.successRate >= 0.6 ? 'ok' : entry.successRate > 0 ? 'mid' : 'bad'}">{pct(entry.successRate)}</span>
                    <span class="mini-num">n={entry.samples}</span>
                  </div>
                {/each}
              </div>
            {/if}
            {#if learnReport.driftedModels?.length > 0}
              <div class="card-divider"></div>
              <div class="card-section-label" style="color:var(--color-error);">Drift Alerts</div>
              <div class="drift-list" style="margin-top:0.2rem;">
                {#each learnReport.driftedModels as drift}
                  <div class="drift-row">
                    <IconAlertTriangle size={12} style="color:var(--color-error);" />
                    <span class="drift-model" title={drift.model}>{drift.model.split("/").pop()}</span>
                    <span class="drift-cat" style="text-transform:capitalize;">{drift.category}</span>
                    <span class="drift-sev">{drift.severity.toFixed(1)}σ</span>
                    <span class="drift-rate">{pct(drift.recentRate)} → {pct(drift.posteriorRate)}</span>
                  </div>
                {/each}
              </div>
            {/if}
          {/snippet}
        </MetricCard>
      {/if}

      <!-- Experiments A/B -->
      {#if experiments.length > 0}
        {#each experiments as exp (exp.name)}
          <MetricCard label="Experiment: {exp.name}" index={22}>
            {#snippet icon()}<IconFlask size={26} />{/snippet}
            {#snippet children()}
              {#if exp.arms.length >= 2}
                {@const a = exp.arms[0]}
                {@const b = exp.arms[1]}
                <div class="mini-table">
                  <div class="mini-row ab-header" style="grid-template-columns: 1fr repeat(4, auto);">
                    <span>Metric</span>
                    <span class="mini-num">Arm {a.arm}</span>
                    <span class="mini-num">Arm {b.arm}</span>
                    <span class="mini-num">Δ</span>
                    <span></span>
                  </div>
                  <div class="mini-row" style="grid-template-columns: 1fr repeat(4, auto);">
                    <span>N</span>
                    <span class="mini-num">{a.n}</span>
                    <span class="mini-num">{b.n}</span>
                    <span class="mini-num dim">{b.n - a.n}</span>
                    <span></span>
                  </div>
                  <div class="mini-row" style="grid-template-columns: 1fr repeat(4, auto);">
                    <span>Success</span>
                    <span class="mini-num">{pct(a.successRate)}</span>
                    <span class="mini-num">{pct(b.successRate)}</span>
                    <span class="mini-num {b.successRate > a.successRate ? 'ok' : b.successRate < a.successRate ? 'bad' : 'dim'}">{(b.successRate - a.successRate >= 0 ? "+" : "")}{((b.successRate - a.successRate) * 100).toFixed(0)}%</span>
                    <span></span>
                  </div>
                  <div class="mini-row" style="grid-template-columns: 1fr repeat(4, auto);">
                    <span>W. success</span>
                    <span class="mini-num">{pct(a.weightedSuccessRate)}</span>
                    <span class="mini-num">{pct(b.weightedSuccessRate)}</span>
                    <span class="mini-num {b.weightedSuccessRate > a.weightedSuccessRate ? 'ok' : b.weightedSuccessRate < a.weightedSuccessRate ? 'bad' : 'dim'}">{(b.weightedSuccessRate - a.weightedSuccessRate >= 0 ? "+" : "")}{((b.weightedSuccessRate - a.weightedSuccessRate) * 100).toFixed(0)}%</span>
                    <span></span>
                  </div>
                  <div class="mini-row" style="grid-template-columns: 1fr repeat(4, auto);">
                    <span>Reqs/task</span>
                    <span class="mini-num">{a.avgReqs.toFixed(1)}</span>
                    <span class="mini-num">{b.avgReqs.toFixed(1)}</span>
                    <span class="mini-num {b.avgReqs < a.avgReqs ? 'ok' : b.avgReqs > a.avgReqs ? 'bad' : 'dim'}">{(b.avgReqs - a.avgReqs >= 0 ? "+" : "")}{(b.avgReqs - a.avgReqs).toFixed(1)}</span>
                    <span></span>
                  </div>
                  <div class="mini-row" style="grid-template-columns: 1fr repeat(4, auto);">
                    <span>Cost/task</span>
                    <span class="mini-num">{fmtCost(a.avgCost)}</span>
                    <span class="mini-num">{fmtCost(b.avgCost)}</span>
                    <span class="mini-num {b.avgCost < a.avgCost ? 'ok' : b.avgCost > a.avgCost ? 'bad' : 'dim'}">{fmtCost(b.avgCost - a.avgCost)}</span>
                    <span></span>
                  </div>
                </div>
              {:else}
                <div class="mini-table">
                  {#each exp.arms as arm}
                    <div class="mini-row" style="grid-template-columns: 1fr repeat(3, auto);">
                      <span class="mini-name">Arm {arm.arm}</span>
                      <span class="mini-num">n={arm.n}</span>
                      <span class="mini-num">{pct(arm.successRate)} success</span>
                      <span class="mini-num">{arm.avgReqs.toFixed(1)} reqs</span>
                    </div>
                  {/each}
                </div>
                <div class="card-hint" style="margin-top:0.3rem;">Add a second arm to see Δ comparison.</div>
              {/if}
            {/snippet}
          </MetricCard>
        {/each}
      {/if}
    {/if}
  </div>
</div>

<!-- Reset confirmation modal — matches the FileTree delete-confirm style -->
{#if showResetConfirm}
  <div
    class="delete-confirm-overlay"
    onclick={() => (showResetConfirm = false)}
    onkeydown={(e) => { if (e.key === "Escape") showResetConfirm = false; }}
    role="button"
    tabindex="-1"
    aria-label="Cancel reset"
  >
    <div
      class="delete-confirm-dialog"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Confirm telemetry reset"
      aria-modal="true"
      tabindex="-1"
    >
      <div class="flex items-center gap-2 mb-3">
        <IconTrash size={18} class="text-[var(--color-error)] flex-shrink-0" />
        <span class="font-bold text-sm">Reset all telemetry?</span>
      </div>
      <p class="text-xs opacity-70 mb-1">This action cannot be undone.</p>
      <p class="text-xs opacity-70 mb-4">Every task, request, and rollup record will be permanently deleted.</p>
      <div class="flex items-center justify-end gap-2">
        <button class="btn text-xs px-3 py-1.5" onclick={() => (showResetConfirm = false)} disabled={resetting}>Cancel</button>
        <button class="btn-danger text-xs px-3 py-1.5" onclick={resetStats} disabled={resetting}>
          {resetting ? "Resetting…" : "Reset"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .stats-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .stats-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
  }
  .stats-title {
    font-size: 1.25rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--color-text);
  }
  .stats-subtitle {
    font-size: 0.6875rem;
    color: var(--color-muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-top: 0.15rem;
  }
  .stats-actions {
    display: flex;
    gap: 0.4rem;
  }
  .stats-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 8px;
    color: var(--color-muted);
    background: transparent;
    border: 1px solid var(--color-border);
    cursor: pointer;
    transition: color 0.15s, background 0.15s, border-color 0.15s;
  }
  .stats-btn:hover:not(:disabled) {
    color: var(--color-text);
    background: rgba(var(--accent-rgb), 0.08);
    border-color: var(--color-accent);
  }
  .stats-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .stats-btn-danger:hover:not(:disabled) {
    color: var(--color-error, #f87171);
    background: rgba(248, 113, 113, 0.12);
    border-color: var(--color-error, #f87171);
  }
  .spin { animation: stats-spin 0.8s linear infinite; }
  @keyframes stats-spin { to { transform: rotate(360deg); } }

  .stats-error {
    color: var(--color-error, #f87171);
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
  }
  .stats-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 3rem 1rem;
    color: var(--color-muted);
    gap: 0.5rem;
  }
  .stats-empty-hint {
    font-size: 0.6875rem;
    opacity: 0.6;
  }

  /* Masonry */
  .card-grid {
    columns: 4;
    column-gap: 1rem;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem;
    column-fill: balance;
  }

  /* Big headline metric */
  .big-metric {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.35rem;
  }
  .big-number {
    font-size: 2.2rem;
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    color: var(--color-text);
  }
  .big-side {
    font-size: 0.9rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--color-muted);
  }
  .card-hint {
    font-size: 0.6875rem;
    color: var(--color-muted);
    opacity: 0.75;
    line-height: 1.4;
  }

  /* Key-value grid */
  .kv-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.3rem 0.8rem;
  }
  .kv {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 0.75rem;
  }
  .kv-k {
    color: var(--color-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.6875rem;
  }
  .kv-v {
    color: var(--color-text);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* Usage bar */
  .usage-bar {
    display: flex;
    height: 10px;
    border-radius: 5px;
    overflow: hidden;
    background: rgba(var(--muted-rgb), 0.15);
  }
  .usage-fill {
    height: 100%;
    border-radius: 5px;
    background: linear-gradient(90deg, var(--color-accent), var(--color-accent-secondary));
    box-shadow: 0 0 12px var(--color-accent-glow);
    transition: width 0.5s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .fill-warning { background: linear-gradient(90deg, rgba(251,191,36,0.5), var(--color-warning, #fbbf24)); }
  .fill-critical { background: linear-gradient(90deg, rgba(248,113,113,0.5), var(--color-error, #f87171)); }

  /* Legend */
  .legend-row {
    display: flex;
    gap: 0.8rem;
    font-size: 0.625rem;
    color: var(--color-muted);
    margin-top: 0.3rem;
  }
  .legend-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 0.25rem;
    vertical-align: middle;
  }
  .legend-col {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.6875rem;
    color: var(--color-muted);
  }

  /* Stacked bar (token breakdown) */
  .stacked-bar {
    display: flex;
    height: 12px;
    border-radius: 6px;
    overflow: hidden;
    background: rgba(var(--muted-rgb), 0.15);
  }
  .stacked-seg {
    height: 100%;
    transition: width 0.5s cubic-bezier(0.16, 1, 0.3, 1);
  }

  /* Card divider + section label */
  .card-divider {
    height: 1px;
    background: rgba(var(--color-border), 0.4);
    margin: 0.6rem 0;
  }
  .card-section-label {
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-bottom: 0.2rem;
  }

  /* Outcome distribution */
  .outcome-list {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .outcome-row {
    display: grid;
    grid-template-columns: auto 1fr 2fr auto auto;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.75rem;
  }
  .outcome-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .outcome-label {
    color: var(--color-text);
    font-weight: 600;
  }
  .outcome-bar-track {
    height: 6px;
    border-radius: 3px;
    background: rgba(var(--muted-rgb), 0.15);
    overflow: hidden;
  }
  .outcome-bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.5s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .outcome-count {
    font-family: var(--font-mono, monospace);
    font-size: 0.6875rem;
    color: var(--color-muted);
    text-align: right;
  }
  .outcome-pct {
    font-family: var(--font-mono, monospace);
    font-size: 0.6875rem;
    font-weight: 700;
    color: var(--color-text);
    text-align: right;
    min-width: 2.5rem;
  }

  /* Drift alerts */
  .drift-list {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .drift-row {
    display: grid;
    grid-template-columns: auto 1fr 1fr auto 1fr;
    gap: 0.4rem;
    align-items: center;
    font-family: var(--font-mono, monospace);
    font-size: 0.6875rem;
    padding: 0.2rem 0.3rem;
    border-radius: 5px;
    background: rgba(248, 113, 113, 0.08);
  }
  .drift-model {
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .drift-cat {
    color: var(--color-muted);
  }
  .drift-sev {
    color: var(--color-error, #f87171);
    font-weight: 700;
  }
  .drift-rate {
    color: var(--color-muted);
    text-align: right;
  }

  /* A/B experiment header */
  .ab-header {
    font-weight: 700;
    color: var(--color-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .dim { color: var(--color-muted); opacity: 0.6; }

  /* Mini table (top models) */
  .mini-table {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-family: var(--font-mono, monospace);
    font-size: 0.6875rem;
  }
  .mini-row {
    display: grid;
    grid-template-columns: 1fr repeat(4, auto);
    gap: 0.4rem;
    padding: 0.2rem 0.3rem;
    border-radius: 5px;
    align-items: center;
  }
  .mini-row:hover { background: rgba(var(--accent-rgb), 0.06); }
  .mini-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
  }
  .mini-num {
    text-align: right;
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
  }
  .ok { color: var(--color-success, #4ade80); }
  .mid { color: var(--color-warning, #fbbf24); }
  .bad { color: var(--color-error, #f87171); }

  /* Matrix */
  .matrix-grid {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-family: var(--font-mono, monospace);
    font-size: 0.6875rem;
  }
  .matrix-header-row,
  .matrix-row {
    display: grid;
    gap: 0.3rem;
    padding: 0.2rem 0.3rem;
    align-items: center;
  }
  .matrix-header-row {
    color: var(--color-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .matrix-cat-label {
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .matrix-model {
    color: var(--color-muted);
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 4.5rem;
  }
  .matrix-cell {
    text-align: center;
    padding: 0.15rem 0.3rem;
    border-radius: 4px;
    font-weight: 700;
    white-space: nowrap;
  }
  .cell-n { font-weight: 400; opacity: 0.6; font-size: 0.625rem; }
  .cell-good { color: var(--color-success, #4ade80); background: rgba(74, 222, 128, 0.12); }
  .cell-mid { color: var(--color-warning, #fbbf24); background: rgba(251, 191, 36, 0.12); }
  .cell-bad { color: var(--color-error, #f87171); background: rgba(248, 113, 113, 0.12); }
  .cell-empty { color: var(--color-muted); opacity: 0.3; }
  .low-conf { opacity: 0.4; font-style: italic; }

  /* Events / recent tasks */
  .events-list {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    max-height: 280px;
    overflow-y: auto;
    font-family: var(--font-mono, monospace);
    font-size: 0.6875rem;
  }
  .event-row {
    display: grid;
    grid-template-columns: auto 1fr repeat(3, auto);
    gap: 0.5rem;
    padding: 0.2rem 0.3rem;
    align-items: center;
  }
  .event-row:hover { background: rgba(var(--accent-rgb), 0.06); }
  .event-status { font-size: 0.5rem; }
  .event-status.status-success { color: var(--color-success, #4ade80); }
  .event-status.status-error { color: var(--color-error, #f87171); }
  .event-status.status-cancelled { color: var(--color-warning, #fbbf24); }
  .event-prompt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
    min-width: 0;
  }
  .event-meta {
    color: var(--color-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
