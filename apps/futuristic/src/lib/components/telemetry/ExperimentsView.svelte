<script lang="ts">
  import { IconFlask } from "@tabler/icons-svelte";

  let { experiments = [] }: { experiments?: any[] } = $props();

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

  function delta(a: number, b: number): string {
    const d = b - a;
    const sign = d > 0 ? "+" : "";
    return `${sign}${d.toFixed(1)}`;
  }

  function deltaPct(a: number, b: number): string {
    const d = b - a;
    const sign = d > 0 ? "+" : "";
    return `${sign}${(d * 100).toFixed(0)}%`;
  }
</script>

{#if experiments.length > 0}
  {#each experiments as exp (exp.name)}
    <section class="tel-section">
      <div class="tel-section-title">
        <IconFlask size={14} class="text-[var(--color-accent)]" />
        <span>{exp.name}</span>
      </div>
      {#if exp.arms.length >= 2}
        {@const a = exp.arms[0]}
        {@const b = exp.arms[1]}
        <div class="ab-table">
          <div class="ab-row ab-header">
            <span>Metric</span>
            <span class="num">Arm {a.arm}</span>
            <span class="num">Arm {b.arm}</span>
            <span class="num">Δ</span>
          </div>
          <div class="ab-row">
            <span>N</span>
            <span class="num">{a.n}</span>
            <span class="num">{b.n}</span>
            <span class="num dim">{b.n - a.n}</span>
          </div>
          <div class="ab-row">
            <span>Success rate</span>
            <span class="num">{pct(a.successRate)}</span>
            <span class="num">{pct(b.successRate)}</span>
            <span class="num {b.successRate > a.successRate ? "good" : b.successRate < a.successRate ? "bad" : "dim"}">{deltaPct(a.successRate, b.successRate)}</span>
          </div>
          <div class="ab-row">
            <span>Reqs / task</span>
            <span class="num">{a.avgReqs.toFixed(1)}</span>
            <span class="num">{b.avgReqs.toFixed(1)}</span>
            <span class="num {b.avgReqs < a.avgReqs ? "good" : b.avgReqs > a.avgReqs ? "bad" : "dim"}">{delta(a.avgReqs, b.avgReqs)}</span>
          </div>
          <div class="ab-row">
            <span>Tokens / task</span>
            <span class="num">{fmtTokens(a.avgTokens)}</span>
            <span class="num">{fmtTokens(b.avgTokens)}</span>
            <span class="num {b.avgTokens < a.avgTokens ? "good" : b.avgTokens > a.avgTokens ? "bad" : "dim"}">{fmtTokens(b.avgTokens - a.avgTokens)}</span>
          </div>
          <div class="ab-row">
            <span>Latency</span>
            <span class="num">{fmtDuration(a.avgLatencyMs)}</span>
            <span class="num">{fmtDuration(b.avgLatencyMs)}</span>
            <span class="num {b.avgLatencyMs < a.avgLatencyMs ? "good" : b.avgLatencyMs > a.avgLatencyMs ? "bad" : "dim"}">{fmtDuration(b.avgLatencyMs - a.avgLatencyMs)}</span>
          </div>
          <div class="ab-row">
            <span>Cost / task</span>
            <span class="num">{fmtCost(a.avgCost)}</span>
            <span class="num">{fmtCost(b.avgCost)}</span>
            <span class="num {b.avgCost < a.avgCost ? "good" : b.avgCost > a.avgCost ? "bad" : "dim"}">{fmtCost(b.avgCost - a.avgCost)}</span>
          </div>
        </div>
      {:else}
        <!-- Single-arm experiment — just show the one arm. -->
        <div class="ab-table">
          <div class="ab-row ab-header">
            <span>Metric</span>
            <span class="num">Arm {exp.arms[0].arm}</span>
          </div>
          <div class="ab-row"><span>N</span><span class="num">{exp.arms[0].n}</span></div>
          <div class="ab-row"><span>Success rate</span><span class="num">{pct(exp.arms[0].successRate)}</span></div>
          <div class="ab-row"><span>Reqs / task</span><span class="num">{exp.arms[0].avgReqs.toFixed(1)}</span></div>
          <div class="ab-row"><span>Tokens / task</span><span class="num">{fmtTokens(exp.arms[0].avgTokens)}</span></div>
          <div class="ab-row"><span>Latency</span><span class="num">{fmtDuration(exp.arms[0].avgLatencyMs)}</span></div>
        </div>
        <div class="single-arm-hint">Add a second arm to see Δ comparison.</div>
      {/if}
    </section>
  {/each}
{:else}
  <div class="empty-state">
    <IconFlask size={28} class="opacity-40 mb-2" />
    <div>No experiments yet.</div>
    <div class="text-[0.6875rem] opacity-60 mt-1">
      Tag tasks with an experiment name + arm to compare configurations.
    </div>
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
  .ab-table {
    display: flex;
    flex-direction: column;
    font-family: var(--font-mono, monospace);
    font-size: 0.6875rem;
  }
  .ab-row {
    display: grid;
    grid-template-columns: 1fr repeat(3, auto);
    gap: 0.5rem;
    padding: 0.25rem 0.4rem;
    border-bottom: 1px solid rgba(var(--color-border), 0.3);
    align-items: center;
  }
  .ab-row:last-child {
    border-bottom: none;
  }
  .ab-header {
    font-weight: 700;
    color: var(--color-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .num {
    text-align: right;
    color: var(--color-text);
  }
  .dim {
    color: var(--color-muted);
    opacity: 0.6;
  }
  .good {
    color: var(--color-success, #4ade80);
  }
  .bad {
    color: var(--color-error, #f87171);
  }
  .single-arm-hint {
    font-size: 0.6875rem;
    color: var(--color-muted);
    opacity: 0.6;
    margin-top: 0.4rem;
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
