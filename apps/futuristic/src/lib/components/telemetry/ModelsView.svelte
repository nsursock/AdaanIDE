<script lang="ts">
  import { IconCpu } from "@tabler/icons-svelte";

  let { models = [] }: { models?: any[] } = $props();

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
</script>

{#if models.length > 0}
  <section class="tel-section">
    <div class="tel-section-title">
      <IconCpu size={14} class="text-[var(--color-accent)]" />
      <span>All models ({models.length})</span>
    </div>
    <div class="model-table">
      <div class="model-row model-header">
        <span>Model</span>
        <span class="num">N</span>
        <span class="num">Success</span>
        <span class="num">Reqs/task</span>
        <span class="num">Tokens/task</span>
        <span class="num">P50</span>
        <span class="num">P95</span>
        <span class="num">Cost</span>
        <span class="num">Esc</span>
        <span class="num">Ret</span>
        <span class="num">Fallback</span>
      </div>
      {#each models as row (row.model)}
        <div class="model-row {row.lowConfidence ? "low-conf" : ""}">
          <span class="model-name" title={row.model}>
            {row.model}
            {#if row.lowConfidence}<span class="low-conf-badge" title="n < 3 — low confidence">?</span>{/if}
          </span>
          <span class="num">{row.n}</span>
          <span class="num {row.successRate >= 0.6 ? "ok" : row.successRate > 0 ? "mid" : "bad"}">{pct(row.successRate)}</span>
          <span class="num">{row.requestsPerTask.toFixed(1)}</span>
          <span class="num">{fmtTokens(row.tokensPerTask)}</span>
          <span class="num">{fmtDuration(row.p50DurationMs)}</span>
          <span class="num">{fmtDuration(row.p95DurationMs)}</span>
          <span class="num">{fmtCost(row.cost)}</span>
          <span class="num">{row.escalations}</span>
          <span class="num">{row.retries}</span>
          <span class="num">{row.fallbacks}</span>
        </div>
      {/each}
    </div>
  </section>
{:else}
  <div class="empty-state">
    <IconCpu size={28} class="opacity-40 mb-2" />
    <div>No model data yet.</div>
  </div>
{/if}

<style>
  .tel-section {
    padding: 0.75rem 0;
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
  .model-table {
    display: flex;
    flex-direction: column;
    font-family: var(--font-mono, monospace);
    font-size: 0.6875rem;
  }
  .model-row {
    display: grid;
    grid-template-columns: 1fr repeat(10, auto);
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
  .ok { color: var(--color-success, #4ade80); }
  .mid { color: var(--color-warning, #fbbf24); }
  .bad { color: var(--color-error, #f87171); }
  .low-conf {
    opacity: 0.55;
  }
  .low-conf-badge {
    color: var(--color-warning, #fbbf24);
    font-weight: 700;
    margin-left: 0.2rem;
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
