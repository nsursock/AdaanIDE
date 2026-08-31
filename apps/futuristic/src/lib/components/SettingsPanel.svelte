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
    DEFAULT_SIDEBAR_W,
    DEFAULT_CHAT_W,
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
  } from "@tabler/icons-svelte";

  let { open = $bindable(false) } = $props();

  let apiKeyInput = $state("");
  let showKey = $state(false);
  let keySaved = $state(false);
  let keyError = $state<string | null>(null);

  // Seed the input from persisted settings when the panel opens.
  $effect(() => {
    if (open) {
      apiKeyInput = settingsStore.settings.openrouterApiKey ?? "";
      keySaved = false;
      keyError = null;
    }
  });

  function close() {
    open = false;
  }

  function selectTheme(id: typeof THEME_IDS[number]) {
    themeStore.set(id);
  }

  function resetLayout() {
    settingsStore.setSidebarWidth(DEFAULT_SIDEBAR_W);
    settingsStore.setChatWidth(DEFAULT_CHAT_W);
  }

  function clearModel() {
    chatStore.setModel(null);
  }

  async function saveApiKey() {
    keyError = null;
    const trimmed = apiKeyInput.trim();
    try {
      const res = await fetch("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        keyError = data.error ?? "Failed to save API key";
        return;
      }
      settingsStore.setOpenrouterApiKey(trimmed || null);
      keySaved = true;
      setTimeout(() => (keySaved = false), 2000);
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
        body: JSON.stringify({ apiKey: "" }),
      });
    } catch {
      // best-effort
    }
    settingsStore.setOpenrouterApiKey(null);
  }

  function resetAll() {
    settingsStore.reset();
    apiKeyInput = "";
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

    <div class="settings-body">
      <!-- Appearance -->
      <section class="settings-section">
        <div class="settings-section-title">
          <IconPalette size={14} class="text-[var(--color-accent)]" />
          <span>Appearance</span>
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
        <div class="text-[0.625rem] text-[var(--color-muted)] opacity-70 leading-relaxed">
          The chosen model is remembered across reloads. If it becomes unavailable, the agent falls back to the first free tools-capable model.
        </div>
      </section>

      <!-- API Key -->
      <section class="settings-section">
        <div class="settings-section-title">
          <IconKey size={14} class="text-[var(--color-accent)]" />
          <span>OpenRouter API Key</span>
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
        <div class="flex items-center gap-2 mt-2">
          <button class="settings-link-btn" onclick={saveApiKey} disabled={!apiKeyInput.trim()}>
            {#if keySaved}<IconCheck size={12} /> Saved{:else}Save key{/if}
          </button>
          {#if settingsStore.settings.openrouterApiKey || apiKeyInput}
            <button class="settings-link-btn" onclick={clearApiKey}>Clear</button>
          {/if}
          {#if keyError}
            <span class="text-[0.6875rem] text-[var(--color-error)]">{keyError}</span>
          {/if}
        </div>
        <div class="text-[0.625rem] text-[var(--color-muted)] opacity-70 leading-relaxed mt-2">
          Stored locally in your browser and sent to the server on save. Falls back to the <code class="font-mono">OPENROUTER_API_KEY</code> env var when empty. Get a key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener" class="text-[var(--color-accent)] underline">openrouter.ai/keys</a>.
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
    font-size: 0.625rem;
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
