<script lang="ts">
  import { IconCpu } from "@tabler/icons-svelte";
  import type { ModelMatrix, MatrixCell } from "@adaan/core/server";

  let { matrix = null }: { matrix?: ModelMatrix | null } = $props();

  function pct(v: number): string {
    return `${(v * 100).toFixed(0)}%`;
  }

  // Limit columns to the top N models by task count for readability.
  const maxModels = 8;
  let displayModels = $derived(matrix ? matrix.models.slice(0, maxModels) : []);
  let categories = $derived(matrix ? matrix.categories : []);

  function cellFor(category: string, model: string): MatrixCell | undefined {
    return matrix?.byCategory[category]?.find((c) => c.model === model);
  }
</script>

{#if matrix && matrix.cells.length > 0}
  <section class="tel-section">
    <div class="tel-section-title">
      <IconCpu size={14} class="text-[var(--color-accent)]" />
      <span>Model × Category (organic, N per cell)</span>
    </div>
    <div class="matrix-grid">
      <div class="matrix-header-row">
        <span class="matrix-cat-label">Category</span>
        {#each displayModels as model}
          <span class="matrix-model" title={model}>{model.split("/").pop()}</span>
        {/each}
      </div>
      {#each categories as cat}
        <div class="matrix-row">
          <span class="matrix-cat-label">{cat}</span>
          {#each displayModels as model}
            {@const cell = cellFor(cat, model)}
            {#if cell}
              <span
                class="matrix-cell {cell.lowConfidence ? "low-conf" : ""} {cell.rate >= 0.6 ? "cell-good" : cell.rate > 0 ? "cell-mid" : "cell-bad"}"
                title={`${model} · ${cat}: ${pct(cell.rate)} (N=${cell.n}${cell.lowConfidence ? " · low confidence" : ""})`}
              >
                {pct(cell.rate)}
                <span class="cell-n">({cell.n})</span>
              </span>
            {:else}
              <span class="matrix-cell cell-empty" title={`${model} · ${cat}: no data`}>—</span>
            {/if}
          {/each}
        </div>
      {/each}
    </div>
    {#if matrix.models.length > maxModels}
      <div class="matrix-more">+ {matrix.models.length - maxModels} more models</div>
    {/if}
  </section>
{:else}
  <div class="empty-state">
    <IconCpu size={28} class="opacity-40 mb-2" />
    <div>No matrix data yet.</div>
    <div class="text-[0.6875rem] opacity-60 mt-1">Send categorized tasks to the agent to populate the grid.</div>
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
    grid-template-columns: 1fr repeat(var(--cols, 8), auto);
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
    max-width: 5rem;
  }
  .matrix-cell {
    text-align: center;
    padding: 0.15rem 0.3rem;
    border-radius: 4px;
    font-weight: 700;
    white-space: nowrap;
  }
  .cell-n {
    font-weight: 400;
    opacity: 0.6;
    font-size: 0.625rem;
  }
  .cell-good {
    color: var(--color-success, #4ade80);
    background: rgba(74, 222, 128, 0.12);
  }
  .cell-mid {
    color: var(--color-warning, #fbbf24);
    background: rgba(251, 191, 36, 0.12);
  }
  .cell-bad {
    color: var(--color-error, #f87171);
    background: rgba(248, 113, 113, 0.12);
  }
  .cell-empty {
    color: var(--color-muted);
    opacity: 0.3;
  }
  .low-conf {
    opacity: 0.4;
    font-style: italic;
  }
  .matrix-more {
    font-size: 0.6875rem;
    color: var(--color-muted);
    opacity: 0.6;
    margin-top: 0.4rem;
    text-align: center;
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
