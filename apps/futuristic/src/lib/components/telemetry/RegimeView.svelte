<script lang="ts">
  import { IconBolt, IconTrendingUp, IconDatabase, IconClock } from "@tabler/icons-svelte";
  import type { RegimeMetrics } from "@adaan/core/server";

  let {
    metrics,
    regime,
  }: {
    metrics: RegimeMetrics | null;
    regime: "paid" | "free" | "local";
  } = $props();

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

  // KPI configs per regime — same component, different emphasis.
  const regimeLabel = { paid: "Paid", free: "Free / OpenRouter", local: "Local" };
</script>

{#if metrics && metrics.tasks > 0}
  <!-- Free regime: giant hero number = tasks / 1,000 requests -->
  {#if regime === "free"}
    <section class="tel-section killer-section">
      <div class="killer-label">
        <IconBolt size={14} />
        <span>Successful tasks / 1,000 requests</span>
      </div>
      <div class="killer-value">{metrics.tasksPer1000Requests.toFixed(1)}</div>
      <div class="killer-hint">
        Optimizes directly against OpenRouter's {`1,000`} req/day cap.
        Higher = more coding done per request.
      </div>
    </section>

    <!-- Quota bar -->
    <section class="tel-section">
      <div class="tel-section-title">
        <IconDatabase size={14} class="text-[var(--color-accent)]" />
        <span>Daily quota</span>
      </div>
      <div class="quota-bar-container">
        <div class="quota-bar-track">
          <div
            class="quota-bar-fill {metrics.quotaUsedPct >= 0.9 ? "quota-critical" : metrics.quotaUsedPct >= 0.7 ? "quota-warning" : ""}"
            style="width: {Math.max(2, metrics.quotaUsedPct * 100)}%"
          ></div>
        </div>
        <div class="quota-bar-text">
          {metrics.quotaConsumed} / {metrics.quotaConsumed + metrics.quotaRemaining} used
          ({pct(metrics.quotaUsedPct)})
        </div>
      </div>
    </section>
  {/if}

  <!-- Headline stats (shared across regimes) -->
  <section class="tel-section">
    <div class="tel-section-title">
      <IconTrendingUp size={14} class="text-[var(--color-accent)]" />
      <span>{regimeLabel[regime]} — overview</span>
    </div>
    <div class="stat-grid">
      <div class="stat-cell">
        <div class="stat-value">{metrics.tasks}</div>
        <div class="stat-label">Tasks</div>
        <div class="stat-sub success">{metrics.successfulTasks} ok · {metrics.erroredTasks} err · {metrics.cancelledTasks} cancel</div>
      </div>
      <div class="stat-cell">
        <div class="stat-value">{pct(metrics.successRate)}</div>
        <div class="stat-label">Success rate</div>
        <div class="stat-sub">n={metrics.tasks}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-value">{metrics.requests}</div>
        <div class="stat-label">LLM requests</div>
        <div class="stat-sub">{metrics.requestsPerTask.toFixed(1)} / task</div>
      </div>
      <div class="stat-cell">
        <div class="stat-value">{fmtTokens(metrics.tokensPerTask)}</div>
        <div class="stat-label">Tokens / task</div>
        <div class="stat-sub">{fmtTokens(metrics.tokensPerRequest)} / req</div>
      </div>
      <div class="stat-cell">
        <div class="stat-value">{fmtDuration(metrics.p50DurationMs)}</div>
        <div class="stat-label">P50 task time</div>
        <div class="stat-sub">P95: {fmtDuration(metrics.p95DurationMs)}</div>
      </div>
      <div class="stat-cell">
        <div class="stat-value">{fmtDuration(metrics.p50LatencyMs)}</div>
        <div class="stat-label">P50 latency</div>
        <div class="stat-sub">P95: {fmtDuration(metrics.p95LatencyMs)}</div>
      </div>
    </div>
  </section>

  <!-- Regime-specific KPIs -->
  {#if regime === "paid"}
    <section class="tel-section">
      <div class="tel-section-title">
        <IconDatabase size={14} class="text-[var(--color-accent)]" />
        <span>Paid economics</span>
      </div>
      <div class="stat-grid">
        <div class="stat-cell">
          <div class="stat-value">{fmtCost(metrics.cost)}</div>
          <div class="stat-label">Total cost</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">{fmtCost(metrics.costPerTask)}</div>
          <div class="stat-label">Cost / task</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">{fmtCost(metrics.costPerSuccessfulTask)}</div>
          <div class="stat-label">Cost / successful task</div>
        </div>
      </div>
    </section>
  {:else if regime === "free"}
    <section class="tel-section">
      <div class="tel-section-title">
        <IconDatabase size={14} class="text-[var(--color-accent)]" />
        <span>Free efficiency</span>
      </div>
      <div class="stat-grid">
        <div class="stat-cell">
          <div class="stat-value">{metrics.tasksPer100Requests.toFixed(1)}</div>
          <div class="stat-label">Tasks / 100 req</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">{metrics.requestsPerSuccessfulTask.toFixed(1)}</div>
          <div class="stat-label">Reqs / successful task</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">{pct(metrics.retryRate)}</div>
          <div class="stat-label">Retry rate</div>
          <div class="stat-sub">{pct(metrics.fallbackRate)} fallback</div>
        </div>
      </div>
    </section>
  {:else if regime === "local"}
    <section class="tel-section">
      <div class="tel-section-title">
        <IconClock size={14} class="text-[var(--color-accent)]" />
        <span>Local compute</span>
      </div>
      <div class="stat-grid">
        <div class="stat-cell">
          <div class="stat-value">{metrics.tasksPerHour.toFixed(1)}</div>
          <div class="stat-label">Tasks / hour</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">{metrics.tokensPerSecond.toFixed(0)}</div>
          <div class="stat-label">Est. tok/s</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">{fmtDuration(metrics.timePerSuccessfulTaskMs)}</div>
          <div class="stat-label">Time / successful task</div>
        </div>
      </div>
    </section>
  {/if}

  <!-- Reliability (shared) -->
  <section class="tel-section">
    <div class="tel-section-title">
      <IconBolt size={14} class="text-[var(--color-accent)]" />
      <span>Reliability</span>
    </div>
    <div class="stat-grid">
      <div class="stat-cell">
        <div class="stat-value">{pct(metrics.escalationRate)}</div>
        <div class="stat-label">Escalation rate</div>
      </div>
      <div class="stat-cell">
        <div class="stat-value">{pct(metrics.retryRate)}</div>
        <div class="stat-label">Retry rate</div>
      </div>
      <div class="stat-cell">
        <div class="stat-value">{pct(metrics.fallbackRate)}</div>
        <div class="stat-label">Fallback rate</div>
      </div>
      <div class="stat-cell">
        <div class="stat-value">{metrics.toolCallsPerTask.toFixed(1)}</div>
        <div class="stat-label">Tool calls / task</div>
        <div class="stat-sub">{pct(metrics.cacheHitRate)} cache hit</div>
      </div>
    </div>
  </section>
{:else}
  <div class="empty-state">
    <IconTrendingUp size={28} class="opacity-40 mb-2" />
    <div>No {regimeLabel[regime]} tasks in this window.</div>
  </div>
{/if}

<style>
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
    font-size: 0.6875rem;
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
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .killer-value {
    font-family: var(--font-mono, monospace);
    font-size: 2.5rem;
    font-weight: 900;
    color: var(--color-accent);
    line-height: 1.1;
    margin: 0.2rem 0;
    text-shadow: 0 0 24px rgba(var(--accent-rgb), 0.5);
  }
  .killer-hint {
    font-size: 0.6875rem;
    color: var(--color-muted);
    opacity: 0.7;
    max-width: 340px;
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
    font-size: 1.15rem;
    font-weight: 800;
    color: var(--color-text);
    line-height: 1.1;
  }
  .stat-label {
    font-size: 0.6875rem;
    color: var(--color-muted);
    margin-top: 0.15rem;
  }
  .stat-sub {
    font-size: 0.6875rem;
    color: var(--color-muted);
    opacity: 0.7;
    margin-top: 0.2rem;
  }
  .stat-sub.success {
    color: var(--color-success, #4ade80);
    opacity: 0.85;
  }
  .quota-bar-container {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .quota-bar-track {
    height: 0.5rem;
    border-radius: 4px;
    background: rgba(var(--color-border), 0.5);
    overflow: hidden;
  }
  .quota-bar-fill {
    height: 100%;
    border-radius: 4px;
    background: linear-gradient(to right, rgba(var(--accent-rgb), 0.4), var(--color-accent));
    transition: width 0.3s;
  }
  .quota-bar-fill.quota-warning {
    background: linear-gradient(to right, rgba(251, 191, 36, 0.4), var(--color-warning, #fbbf24));
  }
  .quota-bar-fill.quota-critical {
    background: linear-gradient(to right, rgba(248, 113, 113, 0.4), var(--color-error, #f87171));
  }
  .quota-bar-text {
    font-size: 0.6875rem;
    color: var(--color-muted);
    font-family: var(--font-mono, monospace);
  }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 3rem 1rem;
    color: var(--color-muted);
    font-size: 0.875rem;
    min-height: 200px;
  }
</style>
