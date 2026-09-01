<script lang="ts">
  import {
    IconActivity,
    IconBolt,
    IconDatabase,
    IconTrendingUp,
    IconCheck,
    IconClock,
    IconCpu,
    IconX,
  } from "@tabler/icons-svelte";
  import type { TelemetrySummary, DailyRollup } from "@adaan/core/server";

  let { onClose = () => {} } = $props<{
    onClose?: () => void;
  }>();

  let summary = $state<TelemetrySummary | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    loadSummary();
  });

  async function loadSummary() {
    loading = true;
    error = null;
    try {
      const res = await fetch("/api/telemetry/summary");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        error = data.error ?? "Failed to load telemetry";
        return;
      }
      summary = (await res.json()) as TelemetrySummary;
    } catch (e) {
      error = e instanceof Error ? e.message : "Network error";
    } finally {
      loading = false;
    }
  }

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

  function successRate(r: DailyRollup): number {
    return r.tasks > 0 ? r.successfulTasks / r.tasks : 0;
  }

  function per1000(r: DailyRollup): number {
    return r.requests > 0 ? (r.successfulTasks / r.requests) * 1000 : 0;
  }

  // Per-model rows for today, sorted by request count desc.
  let modelRows = $derived(
    summary
      ? Object.values(summary.today.perModel)
          .map((m) => ({
            model: m.model,
            requests: m.requests,
            errors: m.errors,
            tokens: m.inputTokens + m.outputTokens,
            cost: m.cost,
            avgLatencyMs: m.requests > 0 ? m.totalLatencyMs / m.requests : 0,
            taskSuccessRate: m.tasks > 0 ? m.taskSuccesses / m.tasks : 0,
            tasks: m.tasks,
          }))
          .sort((a, b) => b.requests - a.requests)
      : [],
  );

  // Sparkline scale for the 14-day trend (requests per day).
  let trendMax = $derived(
    summary ? Math.max(1, ...summary.trend.map((r) => r.requests)) : 1,
  );
</script>

<div class="telemetry-view flex-1 flex flex-col overflow-hidden">
  <!-- Tab-like header so it feels native to the editor pane -->
  <div class="tab-bar">
    <div class="tab active">
      <span class="ext-badge ext-tel">TEL</span>
      <span class="font-medium text-xs truncate max-w-[150px]">Telemetry Console</span>
    </div>
    <div class="flex-1"></div>
    <button class="icon-btn" onclick={loadSummary} title="Refresh" aria-label="Refresh telemetry" disabled={loading}>
      <IconActivity size={14} class={loading ? "animate-spin" : ""} />
    </button>
    <button class="tab-close" onclick={onClose} title="Close telemetry view" aria-label="Close telemetry view">
      <IconX size={12} />
    </button>
  </div>

  <!-- Scrollable body fills the rest of the editor pane -->
  <div class="telemetry-body flex-1 overflow-y-auto">
    {#if loading && !summary}
      <div class="empty-state">Loading telemetry…</div>
    {:else if error}
      <div class="empty-state text-[var(--color-error)]">{error}</div>
    {:else if !summary || (summary.today.tasks === 0 && summary.today.requests === 0)}
      <div class="empty-state">
        <IconActivity size={28} class="opacity-40 mb-2" />
        <div>No telemetry yet.</div>
        <div class="text-[0.625rem] opacity-60 mt-1">Send a message to the agent to start collecting metrics.</div>
      </div>
    {:else}
      {@const t = summary.today}

      <!-- Killer metric: successful tasks per 1,000 requests -->
      <section class="tel-section killer-section">
        <div class="killer-label">
          <IconBolt size={14} />
          <span>Successful tasks / 1,000 requests</span>
        </div>
        <div class="killer-value">{per1000(t).toFixed(1)}</div>
        <div class="killer-hint">
          Optimizes directly against OpenRouter's {`1,000`} req/day cap.
          Higher = more coding done per request.
        </div>
      </section>

      <!-- Today headline stats -->
      <section class="tel-section">
        <div class="tel-section-title">
          <IconTrendingUp size={14} class="text-[var(--color-accent)]" />
          <span>Today</span>
        </div>
        <div class="stat-grid">
          <div class="stat-cell">
            <div class="stat-value">{t.tasks}</div>
            <div class="stat-label">Tasks</div>
            <div class="stat-sub success">{t.successfulTasks} ok · {t.erroredTasks} err · {t.cancelledTasks} cancel</div>
          </div>
          <div class="stat-cell">
            <div class="stat-value">{pct(successRate(t))}</div>
            <div class="stat-label">Success rate</div>
          </div>
          <div class="stat-cell">
            <div class="stat-value">{t.requests}</div>
            <div class="stat-label">LLM requests</div>
            <div class="stat-sub">{summary.requestsPerTask.toFixed(1)} / task</div>
          </div>
          <div class="stat-cell">
            <div class="stat-value">{fmtTokens(t.inputTokens + t.outputTokens)}</div>
            <div class="stat-label">Tokens</div>
            <div class="stat-sub">{summary.tokensPerTask.toFixed(1)} / task</div>
          </div>
          <div class="stat-cell">
            <div class="stat-value">{fmtCost(t.cost)}</div>
            <div class="stat-label">Cost</div>
            <div class="stat-sub">{fmtCost(summary.costPerTask)} / task</div>
          </div>
          <div class="stat-cell">
            <div class="stat-value">{fmtDuration(summary.avgTaskDurationMs)}</div>
            <div class="stat-label">Avg task time</div>
          </div>
        </div>
      </section>

      <!-- Savings -->
      <section class="tel-section">
        <div class="tel-section-title">
          <IconDatabase size={14} class="text-[var(--color-accent)]" />
          <span>Efficiency</span>
        </div>
        <div class="stat-grid">
          <div class="stat-cell">
            <div class="stat-value">{pct(summary.contextSavingsPct)}</div>
            <div class="stat-label">Context pruning savings</div>
            <div class="stat-sub">{fmtTokens(t.rawContextTokens)} → {fmtTokens(t.actualContextTokens)}</div>
          </div>
          <div class="stat-cell">
            <div class="stat-value">{pct(summary.cacheHitRate)}</div>
            <div class="stat-label">Cache hit rate</div>
            <div class="stat-sub">{t.cacheHits} hits / {t.toolCalls + t.cacheHits} ops</div>
          </div>
          <div class="stat-cell">
            <div class="stat-value">{t.toolCalls}</div>
            <div class="stat-label">Tool calls</div>
            <div class="stat-sub">{t.filesRead} read · {t.filesModified} mod</div>
          </div>
        </div>
      </section>

      <!-- Per-model table -->
      {#if modelRows.length > 0}
        <section class="tel-section">
          <div class="tel-section-title">
            <IconCpu size={14} class="text-[var(--color-accent)]" />
            <span>Models today</span>
          </div>
          <div class="model-table">
            <div class="model-row model-header">
              <span>Model</span>
              <span class="num">Reqs</span>
              <span class="num">Tokens</span>
              <span class="num">Cost</span>
              <span class="num">Avg lat</span>
              <span class="num">Task ok</span>
            </div>
            {#each modelRows as row (row.model)}
              <div class="model-row">
                <span class="model-name" title={row.model}>{row.model}</span>
                <span class="num">{row.requests}{#if row.errors > 0}<span class="err"> ·{row.errors}</span>{/if}</span>
                <span class="num">{fmtTokens(row.tokens)}</span>
                <span class="num">{fmtCost(row.cost)}</span>
                <span class="num">{fmtDuration(row.avgLatencyMs)}</span>
                <span class="num">{row.tasks > 0 ? pct(row.taskSuccessRate) : "—"}</span>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- 14-day trend -->
      <section class="tel-section">
        <div class="tel-section-title">
          <IconTrendingUp size={14} class="text-[var(--color-accent)]" />
          <span>14-day trend</span>
        </div>
        <div class="trend-chart">
          {#each summary.trend as r, i (r.day)}
            <div class="trend-bar" title={`${r.day}: ${r.requests} reqs, ${r.tasks} tasks, ${per1000(r).toFixed(1)}/1k`}>
              <div class="trend-bar-fill" style="height: {Math.max(2, (r.requests / trendMax) * 100)}%"></div>
              <div class="trend-day">{r.day.slice(5)}</div>
            </div>
          {/each}
        </div>
      </section>

      <!-- Recent tasks -->
      {#if summary.recentTasks.length > 0}
        <section class="tel-section">
          <div class="tel-section-title">
            <IconClock size={14} class="text-[var(--color-accent)]" />
            <span>Recent tasks</span>
          </div>
          <div class="recent-list">
            {#each summary.recentTasks as task (task.taskId)}
              <div class="recent-row">
                <span class="recent-status status-{task.status}">
                  <IconCheck size={9} />
                </span>
                <span class="recent-prompt" title={task.prompt}>{task.prompt || "(empty)"}</span>
                <span class="recent-meta">{task.requestCount}r</span>
                <span class="recent-meta">{fmtTokens(task.inputTokens + task.outputTokens)}</span>
                <span class="recent-meta">{fmtCost(task.cost)}</span>
                <span class="recent-meta">{fmtDuration(task.durationMs)}</span>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    {/if}
  </div>
</div>

<style>
  .telemetry-view {
    width: 100%;
    height: 100%;
  }

  /* Reuse the editor pane's tab-bar look so the telemetry header feels like
     just another open buffer. */
  .tab-bar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0 0.4rem;
    border-bottom: 1px solid var(--color-border);
    background: rgba(var(--bg-deep-rgb), 0.5);
    flex-shrink: 0;
    min-height: 2.1rem;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.6rem;
    border-radius: 6px 6px 0 0;
    cursor: default;
  }
  .tab.active {
    background: rgba(var(--accent-rgb), 0.1);
    border-bottom: 2px solid var(--color-accent);
    color: var(--color-text);
  }
  .ext-badge {
    font-size: 0.5625rem;
    font-weight: 700;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    letter-spacing: 0.03em;
  }
  .ext-tel {
    background: rgba(var(--accent-rgb), 0.2);
    color: var(--color-accent);
  }
  .tab-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 5px;
    color: var(--color-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .tab-close:hover {
    background: rgba(var(--accent-rgb), 0.12);
    color: var(--color-text);
  }

  .telemetry-body {
    padding: 0.75rem 1rem 1.5rem;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    align-items: center;
    /* Center vertically when content is shorter than the pane; fall back to
       top-alignment when it overflows so the top stays scrollable. */
    justify-content: safe center;
  }
  .telemetry-body > :global(*) {
    width: 100%;
    max-width: 640px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 3rem 1rem;
    color: var(--color-muted);
    font-size: 0.8125rem;
    min-height: 200px;
    max-width: 640px;
  }

  .tel-section {
    padding: 0.75rem 0;
    border-bottom: 1px solid rgba(var(--color-border), 0.5);
  }
  .tel-section:last-child {
    border-bottom: none;
  }

  .tel-section-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin-bottom: 0.6rem;
  }

  .killer-section {
    text-align: center;
    padding: 1.1rem 0.5rem;
    background: rgba(var(--accent-rgb), 0.08);
    border: 1px solid rgba(var(--accent-rgb), 0.25);
    border-radius: 10px;
    margin: 0 0 0.5rem;
  }
  .killer-label {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .killer-value {
    font-family: var(--font-mono, monospace);
    font-size: 2.25rem;
    font-weight: 900;
    color: var(--color-accent);
    line-height: 1.1;
    margin: 0.2rem 0;
    text-shadow: 0 0 24px rgba(var(--accent-rgb), 0.5);
  }
  .killer-hint {
    font-size: 0.625rem;
    color: var(--color-muted);
    opacity: 0.7;
    max-width: 320px;
    margin: 0 auto;
  }

  .stat-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
  }
  .stat-cell {
    padding: 0.55rem 0.6rem;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.4);
  }
  .stat-value {
    font-family: var(--font-mono, monospace);
    font-size: 1.05rem;
    font-weight: 800;
    color: var(--color-text);
    line-height: 1.1;
  }
  .stat-label {
    font-size: 0.625rem;
    color: var(--color-muted);
    margin-top: 0.15rem;
  }
  .stat-sub {
    font-size: 0.5625rem;
    color: var(--color-muted);
    opacity: 0.7;
    margin-top: 0.2rem;
  }
  .stat-sub.success {
    color: var(--color-success, #4ade80);
    opacity: 0.85;
  }

  .model-table {
    display: flex;
    flex-direction: column;
    font-family: var(--font-mono, monospace);
    font-size: 0.625rem;
  }
  .model-row {
    display: grid;
    grid-template-columns: 1fr repeat(5, auto);
    gap: 0.4rem;
    padding: 0.3rem 0.4rem;
    border-bottom: 1px solid rgba(var(--color-border), 0.4);
    align-items: center;
  }
  .model-row:last-child {
    border-bottom: none;
  }
  .model-header {
    font-weight: 700;
    color: var(--color-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.5625rem;
  }
  .model-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
  }
  .num {
    text-align: right;
    color: var(--color-muted);
  }
  .err {
    color: var(--color-error, #f87171);
  }

  .trend-chart {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 60px;
    padding: 0.25rem 0;
  }
  .trend-bar {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    height: 100%;
    min-width: 0;
  }
  .trend-bar-fill {
    width: 100%;
    background: linear-gradient(to top, rgba(var(--accent-rgb), 0.3), var(--color-accent));
    border-radius: 2px 2px 0 0;
    min-height: 2px;
  }
  .trend-day {
    font-size: 0.5rem;
    color: var(--color-muted);
    opacity: 0.5;
    margin-top: 0.15rem;
    font-family: var(--font-mono, monospace);
  }

  .recent-list {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-family: var(--font-mono, monospace);
    font-size: 0.625rem;
  }
  .recent-row {
    display: grid;
    grid-template-columns: auto 1fr repeat(4, auto);
    gap: 0.5rem;
    padding: 0.25rem 0.3rem;
    border-radius: 5px;
    align-items: center;
  }
  .recent-row:hover {
    background: rgba(var(--accent-rgb), 0.06);
  }
  .recent-status {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
  }
  .recent-status.status-success {
    color: var(--color-success, #4ade80);
    background: rgba(74, 222, 128, 0.15);
  }
  .recent-status.status-error {
    color: var(--color-error, #f87171);
    background: rgba(248, 113, 113, 0.15);
  }
  .recent-status.status-cancelled {
    color: var(--color-warning, #fbbf24);
    background: rgba(251, 191, 36, 0.15);
  }
  .recent-prompt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
    min-width: 0;
  }
  .recent-meta {
    color: var(--color-muted);
    text-align: right;
  }
</style>
