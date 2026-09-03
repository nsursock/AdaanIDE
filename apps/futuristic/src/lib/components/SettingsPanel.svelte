<script lang="ts">
  import {
    settingsStore,
    chatStore,
    themeStore,
    THEMES,
    THEME_IDS,
    SIDEBAR_MIN,
    SIDEBAR_MAX,
    CHAT_MIN,
    CHAT_MAX,
    TERMINAL_MIN,
    TERMINAL_MAX,
    DEFAULT_SIDEBAR_W,
    DEFAULT_CHAT_W,
    DEFAULT_TERMINAL_H,
    modelAliasKey,
    type ThemePalette,
  } from "@adaan/core";
  import { fly, fade } from "svelte/transition";
  import { cubicInOut } from "svelte/easing";
  import {
    IconX,
    IconCheck,
    IconRefresh,
    IconPalette,
    IconLayout,
    IconCpu,
    IconBackground,
    IconRestore,
    IconKey,
    IconEye,
    IconEyeOff,
    IconAdjustments,
    IconCopy,
    IconRoute,
    IconBrain,
    IconActivity,
  } from "@tabler/icons-svelte";

  let { open = $bindable(false) } = $props();

  type TabId = "general" | "themes" | "models" | "telemetry";
  let activeTab = $state<TabId>("general");

  let apiKeyInput = $state("");
  let showKey = $state(false);
  let keySaved = $state(false);
  let keyError = $state<string | null>(null);
  let baseUrlInput = $state("");
  let baseUrlSaved = $state(false);
  let copiedHex = $state<string | null>(null);

  // --- Models tab state ---
  interface LocalProviderState {
    id: string;
    name: string;
    installed: boolean;
    models: Array<{ id: string; name: string; size?: string; hfRepo?: string }>;
    serverRunning: boolean;
    endpoint: string;
    port: number;
    servedModel: string | null;
  }
  let localProviders = $state<LocalProviderState[]>([]);
  let providersLoading = $state(false);
  let providersError = $state<string | null>(null);
  let servingModel = $state<string | null>(null);
  let serveModelError = $state<string | null>(null);

  // --- Telemetry tab state ---
  let telemetrySaving = $state(false);
  let telemetrySaved = $state(false);
  let telemetryError = $state<string | null>(null);

  const BASE_LABELS: { key: keyof ThemePalette["base"]; label: string }[] = [
    { key: "bg", label: "Background" },
    { key: "surface", label: "Surface" },
    { key: "accent", label: "Accent" },
    { key: "text", label: "Text" },
    { key: "muted", label: "Muted" },
  ];

  const SYNTAX_LABELS: { key: keyof ThemePalette["syntax"]; label: string }[] = [
    { key: "keyword", label: "Keyword" },
    { key: "string", label: "String" },
    { key: "comment", label: "Comment" },
    { key: "number", label: "Number" },
    { key: "variable", label: "Variable" },
    { key: "function", label: "Function" },
    { key: "type", label: "Type" },
    { key: "operator", label: "Operator" },
  ];

  // Seed the input from persisted settings when the panel opens.
  $effect(() => {
    if (open) {
      apiKeyInput = settingsStore.settings.openrouterApiKey ?? "";
      keySaved = false;
      keyError = null;
      baseUrlInput = settingsStore.settings.providerBaseUrl ?? "";
      baseUrlSaved = false;
    }
  });

  // Load local providers when the Models tab is first opened.
  $effect(() => {
    if (open && activeTab === "models" && localProviders.length === 0 && !providersLoading) {
      loadProviders();
    }
  });

  function close() {
    open = false;
  }

  function selectTheme(id: typeof THEME_IDS[number]) {
    themeStore.set(id);
  }

  async function copyHex(hex: string) {
    try {
      await navigator.clipboard.writeText(hex);
      copiedHex = hex;
      setTimeout(() => (copiedHex = null), 1200);
    } catch {
      // clipboard unavailable — ignore
    }
  }

  function resetLayout() {
    settingsStore.setSidebarWidth(DEFAULT_SIDEBAR_W);
    settingsStore.setChatWidth(DEFAULT_CHAT_W);
    settingsStore.setTerminalHeight(DEFAULT_TERMINAL_H);
  }

  function clearModel() {
    chatStore.setModel(null);
  }

  async function saveApiKey() {
    keyError = null;
    const trimmedKey = apiKeyInput.trim();
    const trimmedUrl = baseUrlInput.trim();
    try {
      const res = await fetch("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmedKey, baseUrl: trimmedUrl }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        keyError = data.error ?? "Failed to save provider settings";
        return;
      }
      settingsStore.setOpenrouterApiKey(trimmedKey || null);
      settingsStore.setProviderBaseUrl(trimmedUrl || null);
      keySaved = true;
      baseUrlSaved = true;
      setTimeout(() => { keySaved = false; baseUrlSaved = false; }, 2000);
    } catch (e) {
      keyError = e instanceof Error ? e.message : "Network error";
    }
  }

  async function clearApiKey() {
    apiKeyInput = "";
    showKey = false;
    keyError = null;
    try {
      await fetch("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "", baseUrl: baseUrlInput.trim() }),
      });
    } catch {
      // best-effort
    }
    settingsStore.setOpenrouterApiKey(null);
  }

  async function resetBaseUrl() {
    baseUrlInput = "";
    keyError = null;
    try {
      await fetch("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKeyInput.trim(), baseUrl: "" }),
      });
    } catch {
      // best-effort
    }
    settingsStore.setProviderBaseUrl(null);
  }

  // --- Models tab functions ---

  async function loadProviders() {
    providersLoading = true;
    providersError = null;
    try {
      const res = await fetch("/api/local/providers");
      if (res.ok) {
        const data = await res.json();
        localProviders = data.providers ?? [];
      } else {
        providersError = "Failed to load local providers";
      }
    } catch {
      providersError = "Network error";
    } finally {
      providersLoading = false;
    }
  }

  async function serveModel(providerId: string, modelId: string) {
    servingModel = `${providerId}/${modelId}`;
    serveModelError = null;
    try {
      const res = await fetch("/api/local/serve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId,
          modelId,
          singleModel: settingsStore.settings.singleLocalModel,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        serveModelError = data.error ?? "Failed to start server";
      } else {
        // The serve endpoint configures the provider's local routing
        // server-side — no need to persist a baseUrl in settings.
        // Refresh provider list to show running status.
        await loadProviders();
      }
    } catch (e) {
      serveModelError = e instanceof Error ? e.message : "Network error";
    } finally {
      servingModel = null;
    }
  }

  async function stopProviderServer(providerId: string) {
    try {
      await fetch("/api/local/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      await loadProviders();
    } catch {
      // best-effort
    }
  }

  // --- Telemetry tab functions ---

  /** Push the current telemetry config (minus `enabled`) to the server so the
   *  TelemetryStore applies it at runtime. `enabled` is client-side only. */
  async function pushTelemetryConfig() {
    telemetrySaving = true;
    telemetryError = null;
    try {
      const { enabled: _enabled, ...params } = settingsStore.settings.telemetry;
      const res = await fetch("/api/telemetry/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        telemetryError = data.error ?? "Failed to apply telemetry config";
        return;
      }
      telemetrySaved = true;
      setTimeout(() => (telemetrySaved = false), 2000);
    } catch (e) {
      telemetryError = e instanceof Error ? e.message : "Network error";
    } finally {
      telemetrySaving = false;
    }
  }

  function resetAll() {
    settingsStore.reset();
    apiKeyInput = "";
    baseUrlInput = "";
    showKey = false;
    // Re-apply the default theme to the DOM immediately.
    themeStore.init();
  }
</script>

{#if open}
  <!-- Click-away backdrop -->
  <div
    class="settings-backdrop"
    transition:fade={{ duration: 160 }}
    onclick={close}
    onkeydown={(e) => e.key === "Escape" && close()}
    role="button"
    tabindex="-1"
    aria-label="Close settings"
  ></div>

  <div class="settings-panel" transition:fly={{ y: 16, duration: 220, easing: cubicInOut, opacity: 0 }}>
    <header class="settings-header">
      <div class="pane-title">
        <span class="pane-title-bar"></span>
        <span class="kicker-tag">⌬ //</span>
        <span>Settings Console</span>
      </div>
      <button class="icon-btn" onclick={close} title="Close" aria-label="Close settings">
        <IconX size={16} />
      </button>
    </header>

    <div class="settings-tabs" role="tablist" aria-label="Settings sections">
      <button
        class="settings-tab {activeTab === 'general' ? 'active' : ''}"
        role="tab"
        aria-selected={activeTab === "general"}
        onclick={() => (activeTab = "general")}
      >
        <IconAdjustments size={13} />
        <span>General</span>
      </button>
      <button
        class="settings-tab {activeTab === 'themes' ? 'active' : ''}"
        role="tab"
        aria-selected={activeTab === "themes"}
        onclick={() => (activeTab = "themes")}
      >
        <IconPalette size={13} />
        <span>Themes</span>
      </button>
      <button
        class="settings-tab {activeTab === 'models' ? 'active' : ''}"
        role="tab"
        aria-selected={activeTab === "models"}
        onclick={() => (activeTab = "models")}
      >
        <IconCpu size={13} />
        <span>Models</span>
      </button>
      <button
        class="settings-tab {activeTab === 'telemetry' ? 'active' : ''}"
        role="tab"
        aria-selected={activeTab === "telemetry"}
        onclick={() => (activeTab = "telemetry")}
      >
        <IconActivity size={13} />
        <span>Telemetry</span>
      </button>
    </div>

    <div class="settings-body">
      {#if activeTab === "themes"}
      <!-- Theme picker -->
      <section class="settings-section">
        <div class="settings-section-title">
          <IconPalette size={14} class="text-[var(--color-accent)]" />
          <span>Theme</span>
        </div>
        <div class="settings-theme-grid">
          {#each THEME_IDS as id (id)}
            {@const isActive = settingsStore.settings.theme === id}
            <button
              class="theme-card {isActive ? 'active' : ''}"
              onclick={() => selectTheme(id)}
            >
              <div class="flex gap-1.5 items-center mb-1.5">
                <div class="w-3.5 h-3.5 rounded-full border border-[var(--color-border)]" style="background: {THEMES[id].base.bg};"></div>
                <div class="w-3.5 h-3.5 rounded-full border border-[var(--color-border)]" style="background: {THEMES[id].base.surface};"></div>
                <div class="w-3.5 h-3.5 rounded-full shadow-[0_0_8px_rgba(var(--accent-rgb),0.4)]" style="background: {THEMES[id].base.accent};"></div>
                {#if isActive}
                  <IconCheck size={14} class="ml-auto text-[var(--color-accent)]" />
                {/if}
              </div>
              <span class="font-medium text-xs">{THEMES[id].name}</span>
            </button>
          {/each}
        </div>
      </section>

      <!-- Palette detail for the active theme -->
      {@const active = THEMES[settingsStore.settings.theme]}
      <section class="settings-section">
        <div class="settings-section-title">
          <span>{active.name} — UI colors</span>
        </div>
        <div class="swatch-list">
          {#each BASE_LABELS as { key, label } (key)}
            {@const hex = active.base[key]}
            <button class="swatch-row" onclick={() => copyHex(hex)} title="Copy {hex}">
              <span class="swatch-chip" style="background: {hex};"></span>
              <span class="swatch-label">{label}</span>
              <span class="swatch-hex">
                {#if copiedHex === hex}<IconCheck size={11} class="text-[var(--color-success)]" />{:else}<IconCopy size={11} />{/if}
                {hex}
              </span>
            </button>
          {/each}
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <span>{active.name} — Syntax colors</span>
        </div>
        <div class="swatch-list">
          {#each SYNTAX_LABELS as { key, label } (key)}
            {@const hex = active.syntax[key]}
            <button class="swatch-row" onclick={() => copyHex(hex)} title="Copy {hex}">
              <span class="swatch-chip" style="background: {hex};"></span>
              <span class="swatch-label">{label}</span>
              <span class="swatch-hex">
                {#if copiedHex === hex}<IconCheck size={11} class="text-[var(--color-success)]" />{:else}<IconCopy size={11} />{/if}
                {hex}
              </span>
            </button>
          {/each}
        </div>
        <div class="text-[0.6875rem] text-[var(--color-muted)] opacity-70 leading-relaxed mt-2">
          Click a color to copy its hex code.
        </div>
      </section>
      {:else if activeTab === "models"}
      <!-- Models tab: local provider discovery + serve controls -->
      <section class="settings-section">
        <div class="settings-section-title">
          <IconCpu size={14} class="text-[var(--color-accent)]" />
          <span>Local Model Providers</span>
          <button
            class="icon-btn ml-auto"
            onclick={loadProviders}
            disabled={providersLoading}
            title="Refresh"
            aria-label="Refresh providers"
          >
            <IconRefresh size={13} class={providersLoading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div class="text-[0.6875rem] text-[var(--color-muted)] opacity-70 leading-relaxed">
          Detected runtimes on this Mac. Click a model to serve it — the IDE auto-connects to the local endpoint.
        </div>

        <label class="settings-row cursor-pointer mt-2">
          <div>
            <div class="text-xs font-semibold">One model at a time</div>
            <div class="text-[0.6875rem] text-[var(--color-muted)]">Stop other local servers when starting a new model. Disable on machines with enough RAM to hold multiple models simultaneously (each provider uses its own port).</div>
          </div>
          <button
            class="toggle {settingsStore.settings.singleLocalModel ? 'on' : ''}"
            onclick={() => settingsStore.setSingleLocalModel(!settingsStore.settings.singleLocalModel)}
            role="switch"
            aria-checked={settingsStore.settings.singleLocalModel}
            aria-label="Toggle one model at a time"
          >
            <span class="toggle-knob"></span>
          </button>
        </label>

        {#if providersError}
          <div class="text-[0.6875rem] text-[var(--color-error)] mt-2">{providersError}</div>
        {/if}

        {#if providersLoading && localProviders.length === 0}
          <div class="text-[0.75rem] text-[var(--color-muted)] mt-3 opacity-70">Scanning for providers…</div>
        {/if}

        {#if serveModelError}
          <div class="text-[0.6875rem] text-[var(--color-error)] mt-2">{serveModelError}</div>
        {/if}

        {#each localProviders as provider (provider.id)}
          <div class="mt-3 p-3 rounded-lg border border-[var(--color-border)] bg-[rgba(var(--surface-1-rgb),0.3)]">
            <!-- Provider header -->
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <span class="text-xs font-semibold">{provider.name}</span>
                {#if !provider.installed}
                  <span class="text-[0.625rem] text-[var(--color-muted)] opacity-60">not installed</span>
                {:else if provider.serverRunning}
                  <span class="text-[0.625rem] px-1.5 py-0.5 rounded bg-[rgba(var(--success-rgb),0.15)] text-[var(--color-success)] font-mono border border-[rgba(var(--success-rgb),0.25)]">running :{provider.port}</span>
                {:else}
                  <span class="text-[0.625rem] px-1.5 py-0.5 rounded bg-[rgba(var(--muted-rgb),0.1)] text-[var(--color-muted)] font-mono border border-[var(--color-border)]">stopped :{provider.port}</span>
                {/if}
              </div>
              {#if provider.serverRunning && provider.installed}
                <button class="settings-link-btn" onclick={() => stopProviderServer(provider.id)}>Stop</button>
              {/if}
            </div>

            <!-- Model list -->
            {#if provider.installed && provider.models.length > 0}
              <div class="mt-2 space-y-1">
                {#each provider.models as model (model.id)}
                  {@const alias = settingsStore.settings.modelAliases[modelAliasKey(provider.id, model.id)] ?? ""}
                  <div class="py-1.5 px-2 rounded hover:bg-[rgba(var(--accent-rgb),0.06)] transition-colors">
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="text-[0.75rem] truncate">{alias || model.name}</span>
                        {#if alias}
                          <span class="text-[0.625rem] text-[var(--color-muted)] font-mono truncate opacity-60 flex-shrink min-w-0">{model.name}</span>
                        {/if}
                        {#if model.size}
                          <span class="text-[0.625rem] text-[var(--color-muted)] font-mono flex-shrink-0">{model.size}</span>
                        {/if}
                        {#if provider.servedModel === model.id || provider.servedModel === model.name || provider.servedModel === model.hfRepo}
                          <span class="text-[0.625rem] text-[var(--color-accent)] flex-shrink-0">● served</span>
                        {/if}
                      </div>
                      {#if servingModel === `${provider.id}/${model.id}`}
                        <span class="text-[0.625rem] text-[var(--color-accent)] flex items-center gap-1 flex-shrink-0">
                          <span class="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse"></span>
                          starting…
                        </span>
                      {:else}
                        <button
                          class="settings-link-btn text-[0.6875rem] flex-shrink-0"
                          onclick={() => serveModel(provider.id, model.id)}
                        >
                          Serve
                        </button>
                      {/if}
                    </div>
                    <input
                      type="text"
                      class="alias-input mt-1"
                      placeholder="alias — friendly name shown in the model selector"
                      value={alias}
                      onchange={(e) => settingsStore.setModelAlias(provider.id, model.id, e.currentTarget.value)}
                      spellcheck="false"
                      autocomplete="off"
                      aria-label="Alias for {model.name}"
                    />
                  </div>
                {/each}
              </div>
            {:else if provider.installed}
              <div class="text-[0.6875rem] text-[var(--color-muted)] mt-2 opacity-60">No models installed. Use the provider's CLI to download one.</div>
            {/if}
          </div>
        {/each}

        {#if !providersLoading && localProviders.length > 0 && localProviders.every((p) => !p.installed)}
          <div class="text-[0.75rem] text-[var(--color-muted)] mt-3 opacity-70">
            No local providers found. Install <a href="https://ollama.com" target="_blank" rel="noopener" class="text-[var(--color-accent)] underline">Ollama</a>, <a href="https://rapidmlx.com" target="_blank" rel="noopener" class="text-[var(--color-accent)] underline">Rapid-MLX</a>, or <a href="https://lmstudio.ai" target="_blank" rel="noopener" class="text-[var(--color-accent)] underline">LM Studio</a> to use local models.
          </div>
        {/if}
      </section>
      {:else if activeTab === "telemetry"}
      <!-- Telemetry tab: finetune telemetry collection & display -->
      <section class="settings-section">
        <div class="settings-section-title">
          <IconActivity size={14} class="text-[var(--color-accent)]" />
          <span>Collection</span>
        </div>
        <label class="settings-row cursor-pointer">
          <div>
            <div class="text-xs font-semibold">Telemetry enabled</div>
            <div class="text-[0.6875rem] text-[var(--color-muted)]">Record LLM requests, tasks, tokens, cost, and tool usage to the dashboard</div>
          </div>
          <button
            class="toggle {settingsStore.settings.telemetry.enabled ? 'on' : ''}"
            onclick={() => settingsStore.setTelemetryParam('enabled', !settingsStore.settings.telemetry.enabled)}
            role="switch"
            aria-checked={settingsStore.settings.telemetry.enabled}
            aria-label="Toggle telemetry collection"
          >
            <span class="toggle-knob"></span>
          </button>
        </label>
        <div class="text-[0.6875rem] text-[var(--color-muted)] opacity-70 leading-relaxed mt-1">
          When disabled, the dashboard stops updating. Existing records are kept until you reset them.
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <IconActivity size={14} class="text-[var(--color-accent)]" />
          <span>Retention &amp; Persistence</span>
        </div>
        <label class="settings-field">
          <div class="settings-field-label">
            <span>Max recent tasks</span>
            <span class="settings-value">{settingsStore.settings.telemetry.maxRecentTasks}</span>
          </div>
          <input
            type="range"
            min={50}
            max={2000}
            step={50}
            value={settingsStore.settings.telemetry.maxRecentTasks}
            oninput={(e) => settingsStore.setTelemetryParam('maxRecentTasks', Number(e.currentTarget.value))}
          />
        </label>
        <div class="text-[0.6875rem] text-[var(--color-muted)] opacity-70 leading-relaxed mt-1">
          Ring-buffer cap for recent task records. Older tasks are dropped as new ones complete.
        </div>

        <label class="settings-field mt-3">
          <div class="settings-field-label">
            <span>Max recent requests</span>
            <span class="settings-value">{settingsStore.settings.telemetry.maxRecentRequests}</span>
          </div>
          <input
            type="range"
            min={100}
            max={10000}
            step={100}
            value={settingsStore.settings.telemetry.maxRecentRequests}
            oninput={(e) => settingsStore.setTelemetryParam('maxRecentRequests', Number(e.currentTarget.value))}
          />
        </label>
        <div class="text-[0.6875rem] text-[var(--color-muted)] opacity-70 leading-relaxed mt-1">
          Ring-buffer cap for recent LLM request records. Lowering this trims the in-memory buffer immediately.
        </div>

        <label class="settings-field mt-3">
          <div class="settings-field-label">
            <span>Write debounce</span>
            <span class="settings-value">{settingsStore.settings.telemetry.writeDebounceMs}ms</span>
          </div>
          <input
            type="range"
            min={0}
            max={5000}
            step={100}
            value={settingsStore.settings.telemetry.writeDebounceMs}
            oninput={(e) => settingsStore.setTelemetryParam('writeDebounceMs', Number(e.currentTarget.value))}
          />
        </label>
        <div class="text-[0.6875rem] text-[var(--color-muted)] opacity-70 leading-relaxed mt-1">
          Delay before telemetry is flushed to <code class="font-mono">~/.adaan/telemetry.json</code>. 0 = write immediately (more disk I/O). Higher = fewer writes but more data at risk on crash.
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-section-title">
          <IconActivity size={14} class="text-[var(--color-accent)]" />
          <span>Dashboard</span>
        </div>
        <label class="settings-field">
          <div class="settings-field-label">
            <span>Trend window</span>
            <span class="settings-value">{settingsStore.settings.telemetry.trendDays} days</span>
          </div>
          <input
            type="range"
            min={3}
            max={30}
            step={1}
            value={settingsStore.settings.telemetry.trendDays}
            oninput={(e) => settingsStore.setTelemetryParam('trendDays', Number(e.currentTarget.value))}
          />
        </label>
        <div class="text-[0.6875rem] text-[var(--color-muted)] opacity-70 leading-relaxed mt-1">
          Number of days shown in the dashboard's trend chart. Affects the summary API response.
        </div>

        <label class="settings-field mt-3">
          <div class="settings-field-label">
            <span>Daily request quota</span>
            <span class="settings-value">{settingsStore.settings.quotaDailyLimit || 'off'}</span>
          </div>
          <input
            type="range"
            min={0}
            max={2000}
            step={50}
            value={settingsStore.settings.quotaDailyLimit}
            oninput={(e) => settingsStore.setQuotaDailyLimit(Number(e.currentTarget.value))}
          />
        </label>
        <div class="text-[0.6875rem] text-[var(--color-muted)] opacity-70 leading-relaxed mt-1">
          Free-regime daily LLM-request cap for the dashboard quota bar. 0 hides the bar. Set to match your OpenRouter free-tier limit.
        </div>
      </section>

      <section class="settings-section">
        <div class="flex items-center gap-2">
          <button
            class="settings-link-btn"
            onclick={pushTelemetryConfig}
            disabled={telemetrySaving}
          >
            {#if telemetrySaved}<IconCheck size={12} /> Applied{:else if telemetrySaving}Applying…{:else}Apply to server{/if}
          </button>
          {#if telemetryError}
            <span class="text-[0.6875rem] text-[var(--color-error)]">{telemetryError}</span>
          {/if}
        </div>
        <div class="text-[0.6875rem] text-[var(--color-muted)] opacity-70 leading-relaxed mt-2">
          Pushes the retention, debounce, and trend-window parameters to the running server. The <code class="font-mono">enabled</code> toggle and quota bar are client-side only.
        </div>
      </section>
      {:else}
      <!-- Layout -->
      <section class="settings-section">
        <div class="settings-section-title">
          <IconLayout size={14} class="text-[var(--color-accent)]" />
          <span>Layout</span>
          <button class="settings-link-btn" onclick={resetLayout} title="Reset panel widths">
            <IconRestore size={12} /> Reset
          </button>
        </div>
        <label class="settings-field">
          <div class="settings-field-label">
            <span>Sidebar width</span>
            <span class="settings-value">{settingsStore.settings.sidebarWidth}px</span>
          </div>
          <input
            type="range"
            min={SIDEBAR_MIN}
            max={SIDEBAR_MAX}
            value={settingsStore.settings.sidebarWidth}
            oninput={(e) => settingsStore.setSidebarWidth(Number(e.currentTarget.value))}
          />
        </label>
        <label class="settings-field">
          <div class="settings-field-label">
            <span>Agent panel width</span>
            <span class="settings-value">{settingsStore.settings.chatWidth}px</span>
          </div>
          <input
            type="range"
            min={CHAT_MIN}
            max={CHAT_MAX}
            value={settingsStore.settings.chatWidth}
            oninput={(e) => settingsStore.setChatWidth(Number(e.currentTarget.value))}
          />
        </label>
        <label class="settings-field">
          <div class="settings-field-label">
            <span>Terminal pane height</span>
            <span class="settings-value">{settingsStore.settings.terminalHeight}px</span>
          </div>
          <input
            type="range"
            min={TERMINAL_MIN}
            max={TERMINAL_MAX}
            value={settingsStore.settings.terminalHeight}
            oninput={(e) => settingsStore.setTerminalHeight(Number(e.currentTarget.value))}
          />
        </label>
      </section>

      <!-- Agent -->
      <section class="settings-section">
        <div class="settings-section-title">
          <IconCpu size={14} class="text-[var(--color-accent)]" />
          <span>Agent</span>
        </div>
        <div class="settings-row">
          <div class="min-w-0">
            <div class="text-xs font-semibold">Default model</div>
            <div class="text-[0.6875rem] text-[var(--color-muted)] truncate">
              {#if chatStore.selectedModel}
                {chatStore.selectedModel.name}
              {:else}
                Auto-rotated free tier
              {/if}
            </div>
          </div>
          {#if chatStore.selectedModel}
            <button class="settings-link-btn" onclick={clearModel}>Clear</button>
          {/if}
        </div>
        <div class="text-[0.6875rem] text-[var(--color-muted)] opacity-70 leading-relaxed">
          The chosen model is remembered across reloads. If it becomes unavailable, the agent falls back to the first free tools-capable model.
        </div>
      </section>

      <!-- Phase 3: Adaptive routing -->
      <section class="settings-section">
        <div class="settings-section-title">
          <IconRoute size={14} class="text-[var(--color-accent)]" />
          <span>Adaptive routing</span>
        </div>
        <label class="settings-row cursor-pointer">
          <div>
            <div class="text-xs font-semibold">Auto-route by task complexity</div>
            <div class="text-[0.6875rem] text-[var(--color-muted)]">100% local classifier picks the cheapest model likely to succeed</div>
          </div>
          <button
            class="toggle {settingsStore.settings.routingMode === 'auto' ? 'on' : ''}"
            onclick={() => settingsStore.setRoutingMode(settingsStore.settings.routingMode === 'auto' ? 'manual' : 'auto')}
            role="switch"
            aria-checked={settingsStore.settings.routingMode === 'auto'}
            aria-label="Toggle adaptive routing"
          >
            <span class="toggle-knob"></span>
          </button>
        </label>
        {#if settingsStore.settings.routingMode === 'auto'}
          <div class="settings-field mt-2">
            <div class="settings-field-label">
              <span>Success threshold</span>
              <span class="settings-value">{(settingsStore.settings.routingThreshold * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min={0.3}
              max={0.9}
              step={0.05}
              value={settingsStore.settings.routingThreshold}
              oninput={(e) => settingsStore.setRoutingThreshold(Number(e.currentTarget.value))}
            />
          </div>
          <div class="text-[0.6875rem] text-[var(--color-muted)] opacity-70 leading-relaxed mt-1">
            Minimum empirical task success rate required to trust a model. Lower = more aggressive routing to cheap models.
          </div>

          <!-- Phase 4: Learning -->
          <label class="settings-row cursor-pointer mt-2">
            <div>
              <div class="text-xs font-semibold">Learning from outcomes</div>
              <div class="text-[0.6875rem] text-[var(--color-muted)]">Thompson sampling from task results — improves routing over time</div>
            </div>
            <button
              class="toggle {settingsStore.settings.learningEnabled ? 'on' : ''}"
              onclick={() => settingsStore.setLearningEnabled(!settingsStore.settings.learningEnabled)}
              role="switch"
              aria-checked={settingsStore.settings.learningEnabled}
              aria-label="Toggle learning"
            >
              <span class="toggle-knob"></span>
            </button>
          </label>
          <label class="settings-row cursor-pointer">
            <div>
              <div class="text-xs font-semibold">Paid-model exploration</div>
              <div class="text-[0.6875rem] text-[var(--color-muted)]">Allow exploration to spend paid requests (off = free-only exploration)</div>
            </div>
            <button
              class="toggle {settingsStore.settings.explorationPaidEnabled ? 'on' : ''}"
              onclick={() => settingsStore.setExplorationPaidEnabled(!settingsStore.settings.explorationPaidEnabled)}
              role="switch"
              aria-checked={settingsStore.settings.explorationPaidEnabled}
              aria-label="Toggle paid exploration"
            >
              <span class="toggle-knob"></span>
            </button>
          </label>
        {/if}
      </section>

      <!-- API Key -->
      <section class="settings-section">
        <div class="settings-section-title">
          <IconKey size={14} class="text-[var(--color-accent)]" />
          <span>Provider · API Key &amp; Endpoint</span>
        </div>
        <div class="settings-key-row">
          <input
            type={showKey ? "text" : "password"}
            class="settings-key-input"
            placeholder="sk-or-v1-…"
            value={apiKeyInput}
            oninput={(e) => { apiKeyInput = e.currentTarget.value; keySaved = false; keyError = null; }}
            spellcheck="false"
            autocomplete="off"
          />
          <button
            class="icon-btn settings-key-toggle"
            onclick={() => showKey = !showKey}
            title={showKey ? "Hide key" : "Show key"}
            aria-label={showKey ? "Hide API key" : "Show API key"}
          >
            {#if showKey}<IconEyeOff size={14} />{:else}<IconEye size={14} />{/if}
          </button>
        </div>
        <div class="text-[0.6875rem] text-[var(--color-muted)] opacity-70 leading-relaxed mt-1.5">
          API key — stored locally and sent to the server on save. Falls back to the <code class="font-mono">OPENROUTER_API_KEY</code> env var when empty. Get one at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener" class="text-[var(--color-accent)] underline">openrouter.ai/keys</a>. Leave empty for a local endpoint (no key needed).
        </div>
        <div class="settings-key-row mt-3">
          <input
            type="text"
            class="settings-key-input"
            placeholder="https://openrouter.ai/api/v1"
            value={baseUrlInput}
            oninput={(e) => { baseUrlInput = e.currentTarget.value; baseUrlSaved = false; keyError = null; }}
            spellcheck="false"
            autocomplete="off"
          />
        </div>
        <div class="text-[0.6875rem] text-[var(--color-muted)] opacity-70 leading-relaxed mt-1.5">
          Endpoint base URL — point at any OpenAI-compatible server to use a local model. For <a href="https://rapidmlx.com" target="_blank" rel="noopener" class="text-[var(--color-accent)] underline">Rapid-MLX</a> run <code class="font-mono">rapid-mlx serve &lt;model&gt;</code> and set this to <code class="font-mono">http://localhost:8000/v1</code>. Empty = default OpenRouter. Also settable via the <code class="font-mono">OPENROUTER_BASE_URL</code> env var.
        </div>
        <div class="flex items-center gap-2 mt-2">
          <button class="settings-link-btn" onclick={saveApiKey} disabled={!apiKeyInput.trim() && !baseUrlInput.trim()}>
            {#if keySaved || baseUrlSaved}<IconCheck size={12} /> Saved{:else}Save{/if}
          </button>
          {#if settingsStore.settings.openrouterApiKey || apiKeyInput}
            <button class="settings-link-btn" onclick={clearApiKey}>Clear key</button>
          {/if}
          {#if settingsStore.settings.providerBaseUrl || baseUrlInput}
            <button class="settings-link-btn" onclick={resetBaseUrl}>Reset endpoint</button>
          {/if}
          {#if keyError}
            <span class="text-[0.6875rem] text-[var(--color-error)]">{keyError}</span>
          {/if}
        </div>
      </section>

      <!-- Background -->
      <section class="settings-section">
        <div class="settings-section-title">
          <IconBackground size={14} class="text-[var(--color-accent)]" />
          <span>Background</span>
        </div>
        <label class="settings-row cursor-pointer">
          <div>
            <div class="text-xs font-semibold">Three.js particle field</div>
            <div class="text-[0.6875rem] text-[var(--color-muted)]">Animated background behind the UI</div>
          </div>
          <button
            class="toggle {settingsStore.settings.threeEnabled ? 'on' : ''}"
            onclick={() => settingsStore.setThreeEnabled(!settingsStore.settings.threeEnabled)}
            role="switch"
            aria-checked={settingsStore.settings.threeEnabled}
            aria-label="Toggle Three.js background"
          >
            <span class="toggle-knob"></span>
          </button>
        </label>
      </section>
      {/if}
    </div>

    <footer class="settings-footer">
      <button class="settings-reset-btn" onclick={resetAll}>
        <IconRefresh size={13} /> Restore defaults
      </button>
    </footer>
  </div>
{/if}

<style>
  .settings-backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
  }

  .settings-panel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 100;
    width: min(440px, 92vw);
    max-height: min(640px, 88vh);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 14px;
    border: 1px solid var(--color-border-accent);
    background: linear-gradient(165deg, rgba(var(--surface-1-rgb), 0.92), rgba(var(--surface-2-rgb), 0.97));
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    box-shadow: 0 24px 64px -16px rgba(var(--accent-rgb), 0.5), 0 0 0 1px rgba(var(--accent-rgb), 0.08);
  }

  .settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.7rem 0.9rem;
    border-bottom: 1px solid var(--color-border);
    background: rgba(var(--accent-rgb), 0.06);
  }

  .settings-tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.45rem 0.9rem 0;
    border-bottom: 1px solid var(--color-border);
  }
  .settings-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    color: var(--color-muted);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 0.4rem 0.6rem;
    margin-bottom: -1px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .settings-tab:hover { color: var(--color-text); }
  .settings-tab.active {
    color: var(--color-accent);
    border-bottom-color: var(--color-accent);
  }

  .swatch-list {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.15rem 0.75rem;
  }
  .swatch-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.35rem;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    cursor: pointer;
    text-align: left;
    transition: background 0.15s, border-color 0.15s;
  }
  .swatch-row:hover {
    background: rgba(var(--accent-rgb), 0.08);
    border-color: rgba(var(--accent-rgb), 0.25);
  }
  .swatch-chip {
    width: 0.9rem;
    height: 0.9rem;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    flex-shrink: 0;
  }
  .swatch-label {
    font-size: 0.6875rem;
    color: var(--color-text);
    flex: 1;
    min-width: 0;
  }
  .swatch-hex {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-family: var(--font-mono, monospace);
    font-size: 0.6875rem;
    color: var(--color-muted);
  }

  .settings-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0.9rem 0.75rem;
    overscroll-behavior: contain;
  }

  .settings-section {
    padding: 0.85rem 0;
    border-bottom: 1px solid rgba(var(--color-border), 0.6);
  }
  .settings-section:last-child { border-bottom: none; }

  .settings-section-title {
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
  .settings-section-title > span { flex-shrink: 0; }

  .settings-theme-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
  }
  .theme-card {
    display: flex;
    flex-direction: column;
    padding: 0.6rem 0.65rem;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.4);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
  }
  .theme-card:hover { background: rgba(var(--accent-rgb), 0.1); border-color: var(--color-accent); }
  .theme-card.active {
    background: rgba(var(--accent-rgb), 0.15);
    border-color: var(--color-accent);
    box-shadow: var(--glow-accent);
  }

  .settings-field {
    display: block;
    margin-bottom: 0.65rem;
  }
  .settings-field:last-child { margin-bottom: 0; }
  .settings-field-label {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 0.75rem;
    margin-bottom: 0.35rem;
  }
  .settings-value {
    font-family: var(--font-mono, monospace);
    font-size: 0.6875rem;
    color: var(--color-accent);
  }
  .settings-field input[type="range"] {
    width: 100%;
    accent-color: var(--color-accent);
    cursor: pointer;
  }

  .settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.35rem 0;
  }

  .settings-link-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--color-accent);
    background: transparent;
    border: 1px solid rgba(var(--accent-rgb), 0.3);
    border-radius: 6px;
    padding: 0.2rem 0.5rem;
    cursor: pointer;
    transition: background 0.15s;
  }
  .settings-link-btn:hover { background: rgba(var(--accent-rgb), 0.12); }

  .toggle {
    position: relative;
    width: 38px;
    height: 22px;
    border-radius: 999px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.6);
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.18s, border-color 0.18s;
  }
  .toggle.on {
    background: rgba(var(--accent-rgb), 0.35);
    border-color: var(--color-accent);
    box-shadow: var(--glow-accent);
  }
  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--color-text);
    transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .toggle.on .toggle-knob { transform: translateX(16px); }

  .settings-key-row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
  .settings-key-input {
    flex: 1;
    min-width: 0;
    padding: 0.4rem 0.6rem;
    font-size: 0.75rem;
    font-family: var(--font-mono, monospace);
    color: var(--color-text);
    background: rgba(var(--bg-deep-rgb), 0.5);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .settings-key-input:focus {
    border-color: var(--color-accent);
    box-shadow: var(--glow-accent);
  }
  .settings-key-toggle {
    flex-shrink: 0;
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .alias-input {
    width: 100%;
    min-width: 0;
    padding: 0.25rem 0.5rem;
    font-size: 0.6875rem;
    font-family: var(--font-mono, monospace);
    color: var(--color-text);
    background: rgba(var(--bg-deep-rgb), 0.4);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .alias-input::placeholder {
    color: var(--color-muted);
    opacity: 0.55;
    font-family: inherit;
  }
  .alias-input:focus {
    border-color: var(--color-accent);
    box-shadow: var(--glow-accent);
  }

  .settings-footer {
    display: flex;
    justify-content: flex-end;
    padding: 0.6rem 0.9rem;
    border-top: 1px solid var(--color-border);
    background: rgba(var(--bg-deep-rgb), 0.3);
  }
  .settings-reset-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--color-muted);
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .settings-reset-btn:hover { color: var(--color-accent); border-color: var(--color-accent); }
</style>
