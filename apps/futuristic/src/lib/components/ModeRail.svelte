<script lang="ts">
  import { settingsStore, type AppMode } from "@adaan/core";
  import {
    IconCode,
    IconRobot,
    IconChartBar,
    IconEye,
  } from "@tabler/icons-svelte";

  let { workspaceActive = false }: { workspaceActive?: boolean } = $props();

  const modes: { id: AppMode; label: string; icon: any; enabled: boolean }[] = [
    { id: "editor", label: "Editor", icon: IconCode, enabled: true },
    { id: "agent", label: "Agent", icon: IconRobot, enabled: false },
    { id: "stats", label: "Stats", icon: IconChartBar, enabled: true },
    { id: "monitoring", label: "Monitoring", icon: IconEye, enabled: false },
  ];

  let active = $derived(settingsStore.settings.mode);

  function select(mode: AppMode) {
    const def = modes.find((m) => m.id === mode);
    if (!def?.enabled) return;
    settingsStore.setMode(mode);
  }
</script>

<nav class="mode-rail" aria-label="Workspace mode">
  {#each modes as mode (mode.id)}
    <button
      class="mode-btn {active === mode.id ? 'mode-active' : ''} {mode.enabled ? '' : 'mode-disabled'}"
      onclick={() => select(mode.id)}
      title={mode.enabled ? mode.label : `${mode.label} (coming soon)`}
      aria-label={mode.label}
      aria-pressed={active === mode.id}
      disabled={!mode.enabled || !workspaceActive}
    >
      <mode.icon size={20} />
      <span class="mode-tip">{mode.enabled ? mode.label : `${mode.label} · soon`}</span>
    </button>
  {/each}
</nav>

<style>
  .mode-rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.5rem 0.35rem;
    width: 3rem;
    flex-shrink: 0;
    background: rgba(var(--bg-deep-rgb), 0.55);
    border-right: 1px solid var(--color-border);
    z-index: 20;
  }
  .mode-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 8px;
    color: var(--color-muted);
    background: transparent;
    border: 1px solid transparent;
    cursor: pointer;
    transition: color 0.15s, background 0.15s, border-color 0.15s, transform 0.15s;
  }
  .mode-btn:hover:not(:disabled) {
    color: var(--color-text);
    background: rgba(var(--accent-rgb), 0.08);
    border-color: var(--color-border);
    transform: translateY(-1px);
  }
  .mode-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .mode-active {
    color: var(--color-accent);
    background: rgba(var(--accent-rgb), 0.14);
    border-color: rgba(var(--accent-rgb), 0.5);
    box-shadow: 0 0 12px rgba(var(--accent-rgb), 0.25);
  }
  .mode-active:hover {
    color: var(--color-accent);
  }
  .mode-tip {
    position: absolute;
    left: calc(100% + 0.5rem);
    top: 50%;
    transform: translateY(-50%);
    background: rgba(var(--bg-deep-rgb), 0.95);
    border: 1px solid var(--color-border);
    color: var(--color-text);
    font-size: 0.6875rem;
    font-weight: 600;
    padding: 0.2rem 0.5rem;
    border-radius: 5px;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s;
    z-index: 40;
  }
  .mode-btn:hover .mode-tip {
    opacity: 1;
  }
</style>
