<script lang="ts">
  import { themeStore, THEME_IDS, THEMES } from "@adaan/core";
  import { IconPalette, IconCheck } from "@tabler/icons-svelte";

  let open = $state(false);

  function select(id: typeof THEME_IDS[number]) {
    themeStore.set(id);
    open = false;
  }
</script>

<div class="relative">
  <button
    class="icon-btn {open ? 'active' : ''}"
    onclick={() => open = !open}
    title="Switch Visual Theme"
    aria-label="Switch Theme"
  >
    <IconPalette size={16} />
  </button>

  {#if open}
    <!-- Click-away backdrop -->
    <div class="fixed inset-0 z-40" onclick={() => open = false} onkeydown={(e) => e.key === "Escape" && (open = false)} role="button" tabindex="-1" aria-label="Close menu"></div>
    <div class="theme-menu absolute right-0 top-full mt-1.5 z-50 shadow-2xl">
      <div class="px-3 py-1.5 text-[0.6875rem] font-bold tracking-widest text-[var(--color-muted)] uppercase border-b border-[var(--color-border)] bg-[rgba(var(--accent-rgb),0.06)]">
        ⟨ Palette Engine ⟩
      </div>
      {#each THEME_IDS as id (id)}
        {@const isActive = themeStore.current === id}
        <button
          class="theme-item {isActive ? 'active' : ''}"
          onclick={() => select(id)}
        >
          <div class="flex gap-1.5 items-center">
            <div class="w-3.5 h-3.5 rounded-full border border-[var(--color-border)]" style="background: {THEMES[id].base.bg};"></div>
            <div class="w-3.5 h-3.5 rounded-full border border-[var(--color-border)]" style="background: {THEMES[id].base.surface};"></div>
            <div class="w-3.5 h-3.5 rounded-full shadow-[0_0_8px_rgba(var(--accent-rgb),0.4)]" style="background: {THEMES[id].base.accent};"></div>
          </div>
          <span class="font-medium text-xs ml-1">{THEMES[id].name}</span>
          {#if isActive}
            <IconCheck size={14} class="ml-auto text-[var(--color-accent)]" />
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
