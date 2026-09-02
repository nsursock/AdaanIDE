<script lang="ts">
  import type { ModelInfo, LocalModelInfo } from "@adaan/core";
  import { chatStore, settingsStore, modelAliasKey } from "@adaan/core";
  import { IconChevronDown, IconCpu, IconCheck, IconSearch } from "@tabler/icons-svelte";

  let { models, onSelectLocal, onSelect } = $props<{
    models: { free: ModelInfo[]; paid: ModelInfo[]; local?: LocalModelInfo[] };
    onSelectLocal?: (model: LocalModelInfo) => void;
    onSelect?: (model: ModelInfo) => void;
  }>();
  let open = $state(false);
  let query = $state("");
  let menuEl = $state<HTMLDivElement | null>(null);
  let searchEl = $state<HTMLDivElement | null>(null);
  let freeLabelEl = $state<HTMLDivElement | null>(null);
  let paidLabelEl = $state<HTMLDivElement | null>(null);
  /** True once the paid group label reaches the sticky slot — drives the
   *  free-bar fade-out animation. */
  let freeBarGone = $state(false);

  function select(model: ModelInfo) {
    if (onSelect) {
      onSelect(model);
    } else {
      chatStore.setModel(model);
    }
    open = false;
  }

  function selectLocal(model: LocalModelInfo) {
    if (onSelectLocal) {
      onSelectLocal(model);
    } else {
      chatStore.setModel(model);
    }
    open = false;
  }

  function formatCtx(ctx?: number): string {
    if (!ctx) return "";
    if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
    return `${ctx}`;
  }

  function isLocal(m: ModelInfo): m is LocalModelInfo {
    return typeof (m as LocalModelInfo).providerId === "string";
  }

  /** Live alias for a model, read straight from settings so the picker
   *  reacts the moment an alias is added or removed. Only local models have
   *  user-defined aliases. */
  function aliasOf(m: ModelInfo): string | undefined {
    if (isLocal(m)) {
      return settingsStore.settings.modelAliases[modelAliasKey(m.providerId, m.id)];
    }
    return m.alias;
  }

  /** Display name — user-defined alias wins over the raw model name. */
  function displayName(m: ModelInfo): string {
    return aliasOf(m) || m.name;
  }

  function matches(m: ModelInfo): boolean {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      displayName(m).toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q)
    );
  }

  const filteredFree = $derived(models.free.filter(matches));
  const filteredPaid = $derived(models.paid.filter(matches));
  // Only local models the user has given an alias appear in the picker —
  // reading the alias map inside the derivation makes the list react the
  // instant an alias is set in Settings.
  const filteredLocal = $derived(
    (models.local ?? []).filter((m: LocalModelInfo) => Boolean(aliasOf(m)) && matches(m)),
  );

  // Keep the search bar pinned, the group labels pinned just below it, and
  // fade the free label out (with a slide) the moment the paid label arrives
  // at the sticky slot — i.e. when the user has scrolled past every free model.
  $effect(() => {
    const menu = menuEl;
    const search = searchEl;
    const paid = paidLabelEl;
    if (!menu || !search) return;

    const update = () => {
      // Pin the group labels right beneath the search bar regardless of its
      // rendered height (font scaling, etc.).
      menu.style.setProperty("--search-h", `${search.offsetHeight}px`);
      if (!paid) {
        freeBarGone = false;
        return;
      }
      const threshold = search.getBoundingClientRect().bottom;
      // The paid label is sticky at top: var(--search-h). When its top reaches
      // the search bar's bottom, it has taken the slot — free is done.
      freeBarGone = paid.getBoundingClientRect().top - threshold < 1;
    };

    update();
    menu.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(menu);
    return () => {
      menu.removeEventListener("scroll", update);
      ro.disconnect();
    };
  });
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
        <span class="truncate font-semibold text-xs">{displayName(chatStore.selectedModel)}</span>
        {#if chatStore.selectedModel.contextLength}
          <span class="text-[0.6875rem] px-1 py-0.2 rounded bg-[rgba(var(--accent-rgb),0.12)] text-[var(--color-accent)] font-mono border border-[rgba(var(--accent-rgb),0.25)] flex-shrink-0">
            {formatCtx(chatStore.selectedModel.contextLength)}
          </span>
        {/if}
        {#if !chatStore.selectedModel.toolsCapable}
          <span class="text-[0.6875rem] text-[var(--color-warning)] opacity-80 flex-shrink-0">(chat)</span>
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
    <div class="model-picker-menu absolute left-2.5 right-2.5 top-full mt-1 z-50 max-h-80 overflow-y-auto shadow-2xl" bind:this={menuEl}>
      <div class="model-search" bind:this={searchEl}>
        <IconSearch size={12} class="text-[var(--color-muted)] flex-shrink-0" />
        <input
          type="text"
          placeholder="Search models…"
          bind:value={query}
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => e.stopPropagation()}
          aria-label="Search models"
        />
        <span class="model-search-count">{filteredLocal.length + filteredFree.length + filteredPaid.length}</span>
      </div>

      {#if filteredLocal.length > 0}
        <div class="group-label local-label">
          <span>⟨ Local Models ⟩</span>
          <span class="text-[0.6875rem] font-bold text-[var(--color-accent)]">ON THIS MAC</span>
        </div>
        {#each filteredLocal as model (model.id)}
          {@const isSelected = chatStore.selectedModel?.id === model.id}
          <button
            class="model-item {isSelected ? 'selected' : ''}"
            onclick={() => selectLocal(model)}
          >
            <div class="flex items-center gap-2 min-w-0 truncate">
              {#if isSelected}
                <IconCheck size={12} class="text-[var(--color-accent)] flex-shrink-0" />
              {:else}
                <span class="w-3"></span>
              {/if}
              <span class="truncate">{displayName(model)}</span>
              <span class="text-[0.625rem] text-[var(--color-muted)] flex-shrink-0 opacity-70">{model.providerName}</span>
            </div>
            <div class="flex items-center gap-1.5 flex-shrink-0">
              {#if model.size}
                <span class="text-[0.6875rem] text-[var(--color-muted)] font-mono">{model.size}</span>
              {/if}
              {#if model.running}
                <span class="tool-badge tools">running</span>
              {:else}
                <span class="tool-badge warn">tap to serve</span>
              {/if}
            </div>
          </button>
        {/each}
      {/if}

      {#if filteredFree.length > 0}
        <div class="group-label free-label {freeBarGone ? 'gone' : ''}" bind:this={freeLabelEl}>
          <span>⟨ Free Tier Models ⟩</span>
          <span class="text-[0.6875rem] font-bold text-[var(--color-success)]">AUTOROTATION</span>
        </div>
        {#each filteredFree as model (model.id)}
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
              <span class="truncate">{displayName(model)}</span>
            </div>
            <div class="flex items-center gap-1.5 flex-shrink-0">
              {#if model.contextLength}
                <span class="text-[0.6875rem] text-[var(--color-muted)] font-mono">{formatCtx(model.contextLength)}</span>
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

      {#if filteredPaid.length > 0}
        <div class="group-label paid-label {freeBarGone ? 'active' : ''}" bind:this={paidLabelEl}>⟨ Paid Tier Models ⟩</div>
        {#each filteredPaid as model (model.id)}
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
              <span class="truncate">{displayName(model)}</span>
            </div>
            <div class="flex items-center gap-1.5 flex-shrink-0">
              {#if model.contextLength}
                <span class="text-[0.6875rem] text-[var(--color-muted)] font-mono">{formatCtx(model.contextLength)}</span>
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

      {#if filteredLocal.length === 0 && filteredFree.length === 0 && filteredPaid.length === 0}
        <div class="model-empty">No models match “{query}”.</div>
      {/if}
    </div>
  {/if}
</div>
