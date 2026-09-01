<script lang="ts">
  import { workspaceStore } from "@adaan/core";
  import {
    IconHistory,
    IconRefresh,
    IconRestore,
    IconChevronDown,
    IconChevronRight,
    IconPlus,
    IconMinus,
    IconX,
  } from "@tabler/icons-svelte";

  let {
    workspaceRoot,
    onRestore = () => {},
  } = $props();

  interface HistoryEntry {
    id: string;
    path: string;
    hash: string;
    timestamp: number;
    source: "agent" | "user" | "restore";
    label?: string;
    stats?: { added: number; modified: number; removed: number };
  }

  let entries = $state<HistoryEntry[]>([]);
  let loading = $state(false);
  let expanded = $state(false);
  let restoring = $state<string | null>(null);

  const activePath = $derived(workspaceStore.activeTabPath);

  async function loadHistory() {
    if (!workspaceRoot || !activePath) {
      entries = [];
      return;
    }
    loading = true;
    try {
      const res = await fetch(
        `/api/files/history/list?root=${encodeURIComponent(workspaceRoot)}&path=${encodeURIComponent(activePath)}`,
      );
      if (res.ok) {
        const data = await res.json();
        entries = data.entries ?? [];
      } else {
        entries = [];
      }
    } catch {
      entries = [];
    }
    loading = false;
  }

  // Reload history when the active tab changes or when a patch signal fires.
  $effect(() => {
    const _ = activePath;
    const signal = workspaceStore.patchSignal;
    // signal is read so this effect re-runs when the agent patches a file
    void signal;
    loadHistory();
  });

  async function restore(id: string) {
    if (!workspaceRoot || !activePath) return;
    restoring = id;
    try {
      const res = await fetch("/api/files/history/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: workspaceRoot, path: activePath, id }),
      });
      if (res.ok) {
        const data = await res.json();
        // Refresh the editor tab with the restored content.
        const tab = workspaceStore.openTabs.find((t) => t.path === activePath);
        if (tab) {
          // Re-read from disk to get the actual content.
          const readRes = await fetch(
            `/api/files/read?root=${encodeURIComponent(workspaceRoot)}&path=${encodeURIComponent(activePath)}`,
          );
          if (readRes.ok) {
            const readData = await readRes.json();
            tab.content = readData.content;
            tab.hash = readData.hash;
            tab.dirty = false;
          }
        }
        // Drop any pending change for this file since we restored.
        workspaceStore.acceptChange(activePath);
        onRestore();
        await loadHistory();
      }
    } catch {
      // ignore
    }
    restoring = null;
  }

  function formatTime(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function sourceColor(source: string): string {
    if (source === "agent") return "var(--color-accent)";
    if (source === "restore") return "var(--color-warning)";
    return "var(--color-muted)";
  }
</script>

{#if activePath}
  <div class="history-panel">
    <div class="history-header" onclick={() => (expanded = !expanded)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expanded = !expanded; } }}>
      {#if expanded}
        <IconChevronDown size={12} class="opacity-50 flex-shrink-0" />
      {:else}
        <IconChevronRight size={12} class="opacity-50 flex-shrink-0" />
      {/if}
      <IconHistory size={12} class="flex-shrink-0" style="color: var(--color-accent);" />
      <span class="history-title">
        Timeline
        {#if entries.length > 0}
          <span class="history-count">{entries.length}</span>
        {/if}
      </span>
      <button
        class="history-refresh"
        onclick={(e) => { e.stopPropagation(); loadHistory(); }}
        title="Refresh timeline"
        aria-label="Refresh timeline"
      >
        <IconRefresh size={11} />
      </button>
    </div>

    {#if expanded}
      <div class="history-timeline">
        {#if loading}
          <div class="history-empty">Loading…</div>
        {:else if entries.length === 0}
          <div class="history-empty">No history yet</div>
        {:else}
          {#each entries as entry, idx (entry.id)}
            <div class="history-entry" class:latest={idx === 0}>
              <div class="history-entry-dot" style="background: {sourceColor(entry.source)};"></div>
              <div class="history-entry-body">
                <div class="history-entry-top">
                  <span class="history-entry-source" style="color: {sourceColor(entry.source)};">
                    {entry.source}
                  </span>
                  {#if entry.label}
                    <span class="history-entry-label">{entry.label}</span>
                  {/if}
                  {#if idx > 0}
                    <button
                      class="history-restore-btn"
                      onclick={() => restore(entry.id)}
                      disabled={restoring === entry.id}
                      title="Restore file to this version"
                    >
                      {#if restoring === entry.id}
                        <IconRefresh size={10} class="animate-spin" />
                      {:else}
                        <IconRestore size={10} />
                      {/if}
                      Restore
                    </button>
                  {/if}
                </div>
                <div class="history-entry-bottom">
                  <span class="history-entry-time">{formatTime(entry.timestamp)}</span>
                  {#if entry.stats}
                    <span class="history-entry-stats">
                      {#if entry.stats.added > 0}<span class="hs-add">+{entry.stats.added}</span>{/if}
                      {#if entry.stats.modified > 0}<span class="hs-mod">~{entry.stats.modified}</span>{/if}
                      {#if entry.stats.removed > 0}<span class="hs-rem">−{entry.stats.removed}</span>{/if}
                    </span>
                  {/if}
                </div>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .history-panel {
    border-top: 1px solid rgba(var(--muted-rgb), 0.15);
    background: rgba(var(--bg-deep-rgb), 0.3);
    z-index: 10;
    flex-shrink: 0;
  }

  .history-header {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    padding: 0.3rem 0.85rem;
    font-size: 0.6875rem;
    color: var(--color-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
  }
  .history-header:hover {
    background: rgba(var(--muted-rgb), 0.05);
  }

  .history-title {
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex: 1;
  }
  .history-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.1rem;
    height: 1.1rem;
    padding: 0 0.3rem;
    border-radius: 999px;
    background: rgba(var(--accent-rgb), 0.15);
    color: var(--color-accent);
    font-size: 0.625rem;
    font-weight: 700;
    margin-left: 0.3rem;
  }

  .history-refresh {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.15rem;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--color-muted);
    cursor: pointer;
    opacity: 0.6;
  }
  .history-refresh:hover {
    opacity: 1;
    background: rgba(var(--muted-rgb), 0.1);
  }

  .history-timeline {
    max-height: 240px;
    overflow-y: auto;
    padding: 0.25rem 0.85rem 0.5rem;
  }

  .history-empty {
    padding: 0.5rem 0;
    font-size: 0.625rem;
    color: var(--color-muted);
    opacity: 0.6;
    text-align: center;
  }

  .history-entry {
    display: flex;
    gap: 0.5rem;
    padding: 0.3rem 0;
    position: relative;
  }
  .history-entry:not(:last-child)::after {
    content: "";
    position: absolute;
    left: 4px;
    top: 1.4rem;
    bottom: -0.1rem;
    width: 1px;
    background: rgba(var(--muted-rgb), 0.15);
  }

  .history-entry-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 0.15rem;
    box-shadow: 0 0 6px currentColor;
    z-index: 1;
  }

  .history-entry-body {
    flex: 1;
    min-width: 0;
  }

  .history-entry-top {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .history-entry-source {
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .history-entry-label {
    font-size: 0.625rem;
    color: var(--color-muted);
    opacity: 0.7;
    font-family: "JetBrains Mono", monospace;
  }

  .history-restore-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    margin-left: auto;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    border: 1px solid rgba(var(--muted-rgb), 0.2);
    background: rgba(var(--muted-rgb), 0.05);
    color: var(--color-muted);
    font-size: 0.5625rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .history-restore-btn:hover:not(:disabled) {
    background: rgba(var(--accent-rgb), 0.1);
    color: var(--color-accent);
    border-color: rgba(var(--accent-rgb), 0.3);
  }
  .history-restore-btn:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  .history-entry-bottom {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.1rem;
  }

  .history-entry-time {
    font-size: 0.5625rem;
    color: var(--color-muted);
    opacity: 0.6;
    font-family: "JetBrains Mono", monospace;
  }

  .history-entry-stats {
    display: inline-flex;
    gap: 0.25rem;
    font-size: 0.5625rem;
    font-weight: 700;
  }
  .hs-add { color: rgb(120, 220, 150); }
  .hs-mod { color: rgb(255, 200, 130); }
  .hs-rem { color: rgb(255, 130, 130); }
</style>
