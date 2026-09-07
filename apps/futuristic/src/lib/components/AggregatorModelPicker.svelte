<script lang="ts">
  import { IconChevronDown, IconCpu, IconCheck, IconSearch } from "@tabler/icons-svelte";

  let {
    value = "openrouter/auto",
    freeModels = [],
    paidModels = [],
    localModels = [],
    onSelect,
  }: {
    value: string;
    freeModels: { id: string; name: string; contextLength?: number }[];
    paidModels: { id: string; name: string; contextLength?: number }[];
    localModels: { id: string; name: string; providerName?: string; running?: boolean }[];
    onSelect: (id: string) => void;
  } = $props();

  let open = $state(false);
  let query = $state("");
  let btnEl = $state<HTMLButtonElement | null>(null);
  let menuEl = $state<HTMLDivElement | null>(null);
  let searchEl = $state<HTMLDivElement | null>(null);
  let freeLabelEl = $state<HTMLDivElement | null>(null);
  let paidLabelEl = $state<HTMLDivElement | null>(null);
  let freeBarGone = $state(false);
  /** Menu position relative to viewport — set on open, updated on scroll/resize. */
  let menuPos = $state({ top: 0, left: 0, width: 0 });

  function select(id: string) {
    onSelect(id);
    open = false;
  }

  function formatCtx(ctx?: number): string {
    if (!ctx) return "";
    if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
    return `${ctx}`;
  }

  function matches(m: { id: string; name: string }): boolean {
    if (!query) return true;
    const q = query.toLowerCase();
    return m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
  }

  const filteredFree = $derived(freeModels.filter(matches));
  const filteredPaid = $derived(paidModels.filter(matches));
  const filteredLocal = $derived(localModels.filter(matches));

  /** Display name for the currently-selected value. */
  const selectedLabel = $derived.by(() => {
    if (value === "openrouter/auto") return "Auto (openrouter/auto)";
    const all = [...localModels, ...freeModels, ...paidModels];
    const m = all.find((m) => m.id === value);
    return m?.name ?? value;
  });

  /** Compute the menu position from the button's bounding rect. */
  function updatePos() {
    if (!btnEl) return;
    const rect = btnEl.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const menuH = Math.min(360, spaceBelow);
    menuPos = {
      top: menuH < 200 ? Math.max(8, rect.top - 360 - 4) : rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    };
  }

  /** Open the menu and position it. */
  function openMenu() {
    open = !open;
    if (open) {
      query = "";
      // Compute position synchronously so the menu appears in the right spot
      // immediately — no flash at (0,0).
      updatePos();
      requestAnimationFrame(() => {
        searchEl?.querySelector("input")?.focus();
      });
    }
  }

  /** Svelte action: teleport the element to document.body on mount, restore
   *  on destroy. This escapes any ancestor with backdrop-filter/transform
   *  that would turn position:fixed into position:absolute relative to that
   *  ancestor (the config modal has backdrop-filter). */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  // Reposition on scroll/resize while open. Also handle the sticky label effect.
  $effect(() => {
    if (!open) return;
    const menu = menuEl;
    const search = searchEl;
    const paid = paidLabelEl;
    if (!menu || !search) return;

    const update = () => {
      updatePos();
      menu.style.setProperty("--search-h", `${search.offsetHeight}px`);
      if (!paid) {
        freeBarGone = false;
        return;
      }
      const threshold = search.getBoundingClientRect().bottom;
      freeBarGone = paid.getBoundingClientRect().top - threshold < 1;
    };

    update();
    menu.addEventListener("scroll", update, { passive: true });
    window.addEventListener("scroll", update, { passive: true, capture: true });
    window.addEventListener("resize", update);
    const ro = new ResizeObserver(update);
    ro.observe(menu);
    return () => {
      menu.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update, { capture: true } as any);
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  });
</script>

<div class="agg-picker-wrap">
  <button
    class="model-picker-btn"
    bind:this={btnEl}
    onclick={openMenu}
    title="Select judge / aggregator model"
    aria-label="Select judge / aggregator model"
  >
    <div class="truncate flex items-center gap-2 min-w-0">
      <IconCpu size={14} class="text-[var(--color-accent)] flex-shrink-0" />
      <span class="truncate font-semibold text-xs">{selectedLabel}</span>
    </div>
    <IconChevronDown size={14} class="opacity-60 flex-shrink-0 transition-transform duration-200" style="transform: rotate({open ? 180 : 0}deg);" />
  </button>
</div>

{#if open}
  <!-- Both the backdrop and menu are teleported to document.body via the
       `portal` action. This escapes the config modal's backdrop-filter,
       which would otherwise create a containing block that breaks
       position:fixed. -->

  <!-- Click-away backdrop -->
  <div
    use:portal
    class="fixed inset-0"
    style="z-index: 200;"
    onclick={() => (open = false)}
    onkeydown={(e) => e.key === "Escape" && (open = false)}
    role="button"
    tabindex="-1"
    aria-label="Close menu"
  ></div>

  <!-- Menu — fixed positioned, teleported to body -->
  <div
    use:portal
    class="model-picker-menu"
    style="position: fixed; top: {menuPos.top}px; left: {menuPos.left}px; width: {menuPos.width}px; z-index: 201; max-height: 360px; overflow-y: auto; box-shadow: 0 16px 48px -12px rgba(var(--accent-rgb), 0.45);"
    bind:this={menuEl}
  >
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

    <!-- Auto option -->
    {#if matches({ id: "openrouter/auto", name: "Auto" })}
      <button
        class="model-item {value === 'openrouter/auto' ? 'selected' : ''}"
        onclick={() => select("openrouter/auto")}
      >
        <div class="flex items-center gap-2 min-w-0 truncate">
          {#if value === "openrouter/auto"}
            <IconCheck size={12} class="text-[var(--color-accent)] flex-shrink-0" />
          {:else}
            <span class="w-3"></span>
          {/if}
          <span class="truncate">Auto</span>
          <span class="text-[0.625rem] text-[var(--color-muted)] flex-shrink-0 opacity-70">openrouter/auto</span>
        </div>
        <span class="tool-badge tools">auto-route</span>
      </button>
    {/if}

    {#if filteredLocal.length > 0}
      <div class="group-label local-label">
        <span>⟨ Local Models ⟩</span>
        <span class="text-[0.6875rem] font-bold text-[var(--color-accent)]">ON THIS MAC</span>
      </div>
      {#each filteredLocal as model (model.id)}
        {@const isSelected = value === model.id}
        <button
          class="model-item {isSelected ? 'selected' : ''}"
          onclick={() => select(model.id)}
        >
          <div class="flex items-center gap-2 min-w-0 truncate">
            {#if isSelected}
              <IconCheck size={12} class="text-[var(--color-accent)] flex-shrink-0" />
            {:else}
              <span class="w-3"></span>
            {/if}
            <span class="truncate">{model.name}</span>
            {#if model.providerName}
              <span class="text-[0.625rem] text-[var(--color-muted)] flex-shrink-0 opacity-70">{model.providerName}</span>
            {/if}
          </div>
        </button>
      {/each}
    {/if}

    {#if filteredFree.length > 0}
      <div class="group-label free-label {freeBarGone ? 'gone' : ''}" bind:this={freeLabelEl}>
        <span>⟨ Free Tier Models ⟩</span>
        <span class="text-[0.6875rem] font-bold text-[var(--color-success)]">OPENROUTER</span>
      </div>
      {#each filteredFree as model (model.id)}
        {@const isSelected = value === model.id}
        <button
          class="model-item {isSelected ? 'selected' : ''}"
          onclick={() => select(model.id)}
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
              <span class="text-[0.6875rem] text-[var(--color-muted)] font-mono">{formatCtx(model.contextLength)}</span>
            {/if}
          </div>
        </button>
      {/each}
    {/if}

    {#if filteredPaid.length > 0}
      <div class="group-label paid-label {freeBarGone ? 'active' : ''}" bind:this={paidLabelEl}>⟨ Paid Tier Models ⟩</div>
      {#each filteredPaid as model (model.id)}
        {@const isSelected = value === model.id}
        <button
          class="model-item {isSelected ? 'selected' : ''}"
          onclick={() => select(model.id)}
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
              <span class="text-[0.6875rem] text-[var(--color-muted)] font-mono">{formatCtx(model.contextLength)}</span>
            {/if}
          </div>
        </button>
      {/each}
    {/if}

    {#if filteredLocal.length === 0 && filteredFree.length === 0 && filteredPaid.length === 0}
      <div class="model-empty">No models match "{query}".</div>
    {/if}
  </div>
{/if}

<style>
  .agg-picker-wrap {
    position: relative;
    width: 100%;
  }
</style>
