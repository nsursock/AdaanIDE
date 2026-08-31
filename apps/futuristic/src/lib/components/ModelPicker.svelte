<script lang="ts">
  import type { ModelInfo } from "@adaan/core";
  import { chatStore } from "@adaan/core";
  import { IconChevronDown, IconCpu, IconSparkles, IconCheck } from "@tabler/icons-svelte";

  let { models } = $props<{ models: { free: ModelInfo[]; paid: ModelInfo[] } }>();
  let open = $state(false);

  function select(model: ModelInfo) {
    chatStore.setModel(model);
    open = false;
  }

  function formatCtx(ctx?: number): string {
    if (!ctx) return "";
    if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
    return `${ctx}`;
  }
</script>

<div class="relative px-2.5 py-1.5 border-b border-[var(--color-border)] bg-[rgba(var(--bg-deep-rgb),0.3)]">
  <button
    class="model-picker-btn"
    onclick={() => open = !open}
    title="Select AI Model"
    aria-label="Select AI Model"
  >
    <div class="truncate flex items-center gap-2 min-w-0">
      <IconCpu size={14} class="text-[var(--color-accent)] flex-shrink-0" />
      {#if chatStore.selectedModel}
        <span class="truncate font-semibold text-xs">{chatStore.selectedModel.name}</span>
        {#if chatStore.selectedModel.contextLength}
          <span class="text-[0.625rem] px-1 py-0.2 rounded bg-[rgba(var(--accent-rgb),0.12)] text-[var(--color-accent)] font-mono border border-[rgba(var(--accent-rgb),0.25)] flex-shrink-0">
            {formatCtx(chatStore.selectedModel.contextLength)}
          </span>
        {/if}
        {#if !chatStore.selectedModel.toolsCapable}
          <span class="text-[0.625rem] text-[var(--color-warning)] opacity-80 flex-shrink-0">(chat)</span>
        {/if}
      {:else}
        <span class="opacity-50 text-xs">Select model…</span>
      {/if}
    </div>
    <IconChevronDown size={14} class="opacity-60 flex-shrink-0 transition-transform duration-200" style="transform: rotate({open ? 180 : 0}deg);" />
  </button>

  {#if open}
    <!-- Click-away backdrop -->
    <div class="fixed inset-0 z-40" onclick={() => open = false} onkeydown={(e) => e.key === "Escape" && (open = false)} role="button" tabindex="-1" aria-label="Close menu"></div>
    <div class="model-picker-menu absolute left-2.5 right-2.5 top-full mt-1 z-50 max-h-72 overflow-y-auto shadow-2xl">
      {#if models.free.length > 0}
        <div class="group-label flex items-center justify-between">
          <span>⟨ Free Tier Models ⟩</span>
          <span class="text-[0.5625rem] font-bold text-[var(--color-success)]">AUTOROTATION</span>
        </div>
        {#each models.free as model (model.id)}
          {@const isSelected = chatStore.selectedModel?.id === model.id}
          <button
            class="model-item {isSelected ? 'selected' : ''}"
            onclick={() => select(model)}
            disabled={!model.toolsCapable}
          >
            <div class="flex items-center gap-2 min-w-0 truncate">
              {#if isSelected}
                <IconCheck size={12} class="text-[var(--color-accent)] flex-shrink-0" />
              {:else}
                <span class="w-3"></span>
              {/if}
              <span class="truncate">{model.name}</span>
            </div>
            <div class="flex items-center gap-1.5 flex-shrink-0">
              {#if model.contextLength}
                <span class="text-[0.5625rem] text-[var(--color-muted)] font-mono">{formatCtx(model.contextLength)}</span>
              {/if}
              {#if model.toolsCapable}
                <span class="tool-badge tools">FSM tools</span>
              {:else}
                <span class="tool-badge warn">chat only</span>
              {/if}
            </div>
          </button>
        {/each}
      {/if}

      {#if models.paid.length > 0}
        <div class="group-label">⟨ Paid Tier Models ⟩</div>
        {#each models.paid.slice(0, 20) as model (model.id)}
          {@const isSelected = chatStore.selectedModel?.id === model.id}
          <button
            class="model-item {isSelected ? 'selected' : ''}"
            onclick={() => select(model)}
            disabled={!model.toolsCapable}
          >
            <div class="flex items-center gap-2 min-w-0 truncate">
              {#if isSelected}
                <IconCheck size={12} class="text-[var(--color-accent)] flex-shrink-0" />
              {:else}
                <span class="w-3"></span>
              {/if}
              <span class="truncate">{model.name}</span>
            </div>
            <div class="flex items-center gap-1.5 flex-shrink-0">
              {#if model.contextLength}
                <span class="text-[0.5625rem] text-[var(--color-muted)] font-mono">{formatCtx(model.contextLength)}</span>
              {/if}
              {#if model.toolsCapable}
                <span class="tool-badge tools">FSM tools</span>
              {:else}
                <span class="tool-badge warn">chat only</span>
              {/if}
            </div>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>
