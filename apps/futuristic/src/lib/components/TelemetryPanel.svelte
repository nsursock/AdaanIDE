<script lang="ts">
  import {
    IconActivity,
    IconX,
    IconRefresh,
    IconTrash,
    IconChartBar,
    IconCpu,
    IconGrid3x3,
    IconFlask,
  } from "@tabler/icons-svelte";
  import type { TelemetrySummary, RegimeMetrics, ModelMatrix } from "@adaan/core/server";
  import RegimeView from "./telemetry/RegimeView.svelte";
  import ModelsView from "./telemetry/ModelsView.svelte";
  import MatrixView from "./telemetry/MatrixView.svelte";
  import ExperimentsView from "./telemetry/ExperimentsView.svelte";

  let { onClose = () => {} } = $props<{
    onClose?: () => void;
  }>();

  type Tab = "free" | "paid" | "local" | "models" | "matrix" | "experiments";
  let activeTab = $state<Tab>("free");

  let summary = $state<TelemetrySummary | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let regimes = $state<{ paid: RegimeMetrics; free: RegimeMetrics; local: RegimeMetrics } | null>(null);
  let models = $state<any[]>([]);
  let organicMatrix = $state<ModelMatrix | null>(null);
  let experiments = $state<any[]>([]);
  let resetting = $state(false);

  // Experiment tag input state.
  let expName = $state("");
  let expArm = $state("");

  $effect(() => {
    refreshAll();
  });

  async function refreshAll() {
    loading = true;
    error = null;
    try {
      await Promise.all([
        loadSummary(),
        loadRegimes(),
        loadModels(),
        loadCapability(),
        loadExperiments(),
      ]);
    } finally {
      loading = false;
    }
  }

  async function loadSummary() {
    try {
      const res = await fetch("/api/telemetry/summary");
      if (res.ok) summary = (await res.json()) as TelemetrySummary;
    } catch {
      // best-effort
    }
  }

  async function loadRegimes() {
    try {
      const res = await fetch("/api/telemetry/regimes?days=7");
      if (res.ok) {
        const data = await res.json();
        regimes = { paid: data.paid, free: data.free, local: data.local };
      }
    } catch {
      // best-effort
    }
  }

  async function loadModels() {
    try {
      const res = await fetch("/api/telemetry/models");
      if (res.ok) {
        const data = await res.json();
        models = data.models ?? [];
      }
    } catch {
      // best-effort
    }
  }

  async function loadCapability() {
    try {
      const res = await fetch("/api/capability");
      if (res.ok) {
        const data = await res.json();
        organicMatrix = data.organic ?? null;
      }
    } catch {
      // best-effort
    }
  }

  async function loadExperiments() {
    try {
      const res = await fetch("/api/telemetry/experiments");
      if (res.ok) {
        const data = await res.json();
        experiments = data.experiments ?? [];
      }
    } catch {
      // best-effort
    }
  }

  async function resetStats() {
    if (resetting) return;
    if (!confirm("Reset all telemetry stats? This permanently deletes every task, request, and rollup record. This cannot be undone.")) {
      return;
    }
    resetting = true;
    try {
      const res = await fetch("/api/telemetry/reset", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        error = data.error ?? "Failed to reset telemetry";
        return;
      }
      summary = null;
      regimes = null;
      models = [];
      organicMatrix = null;
      experiments = [];
      await refreshAll();
    } catch (e) {
      error = e instanceof Error ? e.message : "Network error";
    } finally {
      resetting = false;
    }
  }

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

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: "free", label: "Free", icon: IconChartBar },
    { id: "paid", label: "Paid", icon: IconChartBar },
    { id: "local", label: "Local", icon: IconChartBar },
    { id: "models", label: "Models", icon: IconCpu },
    { id: "matrix", label: "Matrix", icon: IconGrid3x3 },
    { id: "experiments", label: "Experiments", icon: IconFlask },
  ];
</script>

<div class="telemetry-view flex-1 flex flex-col overflow-hidden">
  <!-- Tab bar header -->
  <div class="tab-bar">
    <div class="tab active">
      <span class="ext-badge ext-tel">TEL</span>
      <span class="font-medium text-xs truncate max-w-[150px]">Telemetry</span>
    </div>
    <div class="flex-1"></div>
    <button class="icon-btn" onclick={refreshAll} title="Refresh all telemetry" aria-label="Refresh telemetry" disabled={loading}>
      <IconRefresh size={14} class={loading ? "animate-spin" : ""} />
    </button>
    <button class="icon-btn icon-btn-danger" onclick={resetStats} title="Reset all stats (start fresh)" aria-label="Reset telemetry stats" disabled={resetting || loading}>
      <IconTrash size={14} />
    </button>
    <button class="tab-close" onclick={onClose} title="Close telemetry view" aria-label="Close telemetry view">
      <IconX size={12} />
    </button>
  </div>

  <!-- Sub-tab navigation -->
  <div class="sub-tabs">
    {#each tabs as tab (tab.id)}
      <button
        class="sub-tab {activeTab === tab.id ? "sub-tab-active" : ""}"
        onclick={() => (activeTab = tab.id)}
      >
        <tab.icon size={12} />
        <span>{tab.label}</span>
      </button>
    {/each}
  </div>

  <!-- Scrollable body -->
  <div class="telemetry-body flex-1 overflow-y-auto">
    {#if error}
      <div class="empty-state text-[var(--color-error)]">{error}</div>
    {:else if loading && !summary && !regimes}
      <div class="empty-state">Loading telemetry…</div>
    {:else}
      {#if activeTab === "free"}
        <RegimeView metrics={regimes?.free ?? null} regime="free" />
      {:else if activeTab === "paid"}
        <RegimeView metrics={regimes?.paid ?? null} regime="paid" />
      {:else if activeTab === "local"}
        <RegimeView metrics={regimes?.local ?? null} regime="local" />
      {:else if activeTab === "models"}
        <ModelsView models={models} />
      {:else if activeTab === "matrix"}
        <MatrixView matrix={organicMatrix} />
      {:else if activeTab === "experiments"}
        <ExperimentsView experiments={experiments} />
      {/if}

      <!-- Recent tasks (shown on all tabs for context) -->
      {#if summary && summary.recentTasks.length > 0 && (activeTab === "free" || activeTab === "paid" || activeTab === "local")}
        <section class="tel-section">
          <div class="tel-section-title">
            <IconActivity size={14} class="text-[var(--color-accent)]" />
            <span>Recent tasks</span>
          </div>
          <div class="recent-list">
            {#each summary.recentTasks as task (task.taskId)}
              <div class="recent-row">
                <span class="recent-status status-{task.status}">●</span>
                <span class="recent-prompt" title={task.prompt}>{task.prompt || "(empty)"}</span>
                {#if task.requestedModel && task.requestedModel !== task.model}
                  <span class="recent-model-shift" title={`requested: ${task.requestedModel} → effective: ${task.model}`}>
                    {task.requestedModel.split("/").pop()} → {task.model.split("/").pop()}
                  </span>
                {/if}
                <span class="recent-meta">{task.requestCount}r</span>
                <span class="recent-meta">{fmtTokens(task.inputTokens + task.outputTokens)}</span>
                <span class="recent-meta">{fmtCost(task.cost)}</span>
                <span class="recent-meta">{fmtDuration(task.durationMs)}</span>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    {/if}
  </div>
</div>

<style>
  .telemetry-view {
    width: 100%;
    height: 100%;
  }

  .tab-bar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0 0.4rem;
    border-bottom: 1px solid var(--color-border);
    background: rgba(var(--bg-deep-rgb), 0.5);
    flex-shrink: 0;
    min-height: 2.1rem;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.6rem;
    border-radius: 6px 6px 0 0;
    cursor: default;
  }
  .tab.active {
    background: rgba(var(--accent-rgb), 0.1);
    border-bottom: 2px solid var(--color-accent);
    color: var(--color-text);
  }
  .ext-badge {
    font-size: 0.6875rem;
    font-weight: 700;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    letter-spacing: 0.03em;
  }
  .ext-tel {
    background: rgba(var(--accent-rgb), 0.2);
    color: var(--color-accent);
  }
  .tab-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 5px;
    color: var(--color-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .tab-close:hover {
    background: rgba(var(--accent-rgb), 0.12);
    color: var(--color-text);
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 5px;
    color: var(--color-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .icon-btn:hover:not(:disabled) {
    background: rgba(var(--accent-rgb), 0.12);
    color: var(--color-text);
  }
  .icon-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .icon-btn-danger:hover:not(:disabled) {
    background: rgba(248, 113, 113, 0.15);
    color: var(--color-error, #f87171);
  }
  .animate-spin {
    animation: tel-spin 0.8s linear infinite;
  }
  @keyframes tel-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .sub-tabs {
    display: flex;
    gap: 0.15rem;
    padding: 0 0.5rem;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
    overflow-x: auto;
  }
  .sub-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.6rem;
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--color-muted);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    white-space: nowrap;
    transition: color 0.15s, border-color 0.15s;
  }
  .sub-tab:hover {
    color: var(--color-text);
  }
  .sub-tab-active {
    color: var(--color-accent);
    border-bottom-color: var(--color-accent);
  }

  .telemetry-body {
    padding: 0.75rem 1rem 1.5rem;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: safe center;
  }
  .telemetry-body > :global(*) {
    width: 100%;
    max-width: 640px;
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
    max-width: 640px;
  }

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

  .recent-list {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-family: var(--font-mono, monospace);
    font-size: 0.6875rem;
  }
  .recent-row {
    display: grid;
    grid-template-columns: auto 1fr auto repeat(4, auto);
    gap: 0.5rem;
    padding: 0.25rem 0.3rem;
    border-radius: 5px;
    align-items: center;
  }
  .recent-row:hover {
    background: rgba(var(--accent-rgb), 0.06);
  }
  .recent-status {
    font-size: 0.5rem;
  }
  .recent-status.status-success {
    color: var(--color-success, #4ade80);
  }
  .recent-status.status-error {
    color: var(--color-error, #f87171);
  }
  .recent-status.status-cancelled {
    color: var(--color-warning, #fbbf24);
  }
  .recent-prompt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
    min-width: 0;
  }
  .recent-model-shift {
    color: var(--color-warning, #fbbf24);
    font-size: 0.625rem;
    white-space: nowrap;
  }
  .recent-meta {
    color: var(--color-muted);
    text-align: right;
  }
</style>
