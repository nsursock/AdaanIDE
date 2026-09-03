<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import {
    IconArrowRight,
    IconBolt,
    IconBrain,
    IconCube,
    IconFolder,
    IconClock,
    IconTerminal2,
    IconSparkles,
    IconPlus,
    IconX,
  } from "@tabler/icons-svelte";
  import { gsap } from "gsap";
  import { projectsStore } from "@adaan/core";

  const dispatch = createEventDispatcher();

  let candidates = $state<string[]>([]);
  let recent = $state<string[]>([]);
  let selected = $state("");
  let manualPath = $state("");
  let loading = $state(true);
  let error = $state<string | null>(null);
  let consoleEl: HTMLElement | null = $state(null);

  // New project state
  let defaultProjectDir = $state("");
  let newName = $state("");
  let newParent = $state("");
  let showNew = $state(false);
  let creating = $state(false);

  let hasExisting = $derived(candidates.length > 0 || recent.length > 0);
  const isDesktop = typeof window !== "undefined" && !!window.adaan;

  async function nativeBrowse() {
    if (!window.adaan) return;
    const path = await window.adaan.openWorkspaceDialog();
    if (path) openPath(path);
  }

  // Typewriter tagline
  const tagline = "Code at the speed of thought.";
  let typed = $state("");
  let typingDone = $state(false);

  // Animated stats counters
  let statModels = $state(0);
  let statThemes = $state(0);
  let statTools = $state(0);
  const targetModels = 50;
  const targetThemes = 2;
  const targetTools = 8;

  const features = [
    { icon: IconBrain, label: "Agentic engine" },
    { icon: IconBolt, label: "Streaming SSE" },
    { icon: IconCube, label: "3D workspace" },
    { icon: IconTerminal2, label: "Tool-calling FSM" },
    { icon: IconSparkles, label: "Retrowave + Ghibli" },
  ];

  function basename(p: string) {
    const parts = p.split("/").filter(Boolean);
    return parts[parts.length - 1] || p;
  }
  function dirname(p: string) {
    const parts = p.split("/").filter(Boolean);
    parts.pop();
    return "/" + parts.join("/");
  }

  onMount(async () => {
    // Hero entrance
    gsap.from(".hero-kicker", { y: -20, opacity: 0, duration: 0.6, ease: "power3.out" });
    gsap.from(".hero-title-glitch", { y: 30, opacity: 0, duration: 0.9, ease: "power3.out", delay: 0.1 });
    gsap.from(".hero-tagline", { opacity: 0, duration: 0.6, delay: 0.5 });
    gsap.from(".feature-pill", { y: 14, opacity: 0, duration: 0.5, stagger: 0.06, ease: "power2.out", delay: 0.7 });
    gsap.from(".console-panel", { y: 30, opacity: 0, scale: 0.98, duration: 0.7, ease: "power3.out", delay: 0.9 });
    gsap.from(".stat-tile", { y: 10, opacity: 0, duration: 0.5, stagger: 0.1, ease: "power2.out", delay: 1.2 });

    // Typewriter
    const tl = gsap.timeline({ delay: 0.6 });
    for (let i = 1; i <= tagline.length; i++) {
      tl.to({}, { duration: 0.035, onComplete: () => (typed = tagline.slice(0, i)) });
    }
    tl.call(() => (typingDone = true));

    // Count-up stats
    const counter = gsap.timeline({ delay: 1.3 });
    counter.to({}, {
      duration: 1.2,
      ease: "power2.out",
      onUpdate: function () {
        const p = this.progress();
        statModels = Math.round(targetModels * p);
        statThemes = Math.round(targetThemes * p);
        statTools = Math.round(targetTools * p);
      },
    });

    // Load workspaces
    try {
      const res = await fetch("/api/workspaces");
      if (res.ok) {
        const data = await res.json();
        candidates = data.candidates || [];
        recent = data.recent || [];
        defaultProjectDir = data.defaultProjectDir || "";
        newParent = defaultProjectDir;
        if (recent.length > 0) selected = recent[0];
        else if (candidates.length > 0) selected = candidates[0];
        if (recent.length === 0 && candidates.length === 0) showNew = true;
      }
    } catch (e) {
      error = "Failed to load workspaces";
    } finally {
      loading = false;
    }
  });

  async function openPath(path: string) {
    if (!path) return;
    // Exit flourish before handing off
    if (consoleEl) {
      await gsap.to(consoleEl, { scale: 1.02, boxShadow: "0 0 60px var(--color-accent-glow)", duration: 0.18, ease: "power2.out" });
      gsap.to(consoleEl, { scale: 1, duration: 0.2, ease: "power2.out" });
    }
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath: path }),
    });
    if (res.ok) {
      dispatch("open", path);
    } else {
      error = "Failed to open workspace";
    }
  }

  function handleOpen() {
    const path = manualPath.trim() || selected;
    openPath(path);
  }

  async function createProject() {
    const name = newName.trim();
    if (!name || creating) return;
    creating = true;
    error = null;
    try {
      const res = await fetch("/api/workspaces/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parentPath: newParent.trim() || undefined }),
      });
      const data = await res.json();
      if (res.ok && data.rootPath) {
        dispatch("open", data.rootPath);
      } else {
        error = data.error || "Failed to create project";
      }
    } catch {
      error = "Failed to create project";
    } finally {
      creating = false;
    }
  }

  function switchToProject(id: string) {
    dispatch("switch", id);
  }

  async function closeOpenProject(id: string, e: MouseEvent) {
    e.stopPropagation();
    const result = projectsStore.closeProject(id);
    if (result?.sessionIds) {
      for (const sid of result.sessionIds) {
        try {
          await fetch(`/api/sessions/${sid}`, { method: "DELETE" });
        } catch {
          // best-effort
        }
      }
    }
  }
</script>

<section class="relative h-full w-full flex flex-col items-center justify-center px-6 py-10 overflow-hidden" style="background: var(--color-bg);">
  <!-- Perspective grid floor -->
  <div class="grid-floor"></div>
  <!-- Vignette for depth -->
  <div class="vignette"></div>

  <div class="relative z-10 w-full max-w-2xl flex flex-col items-center text-center">
    <!-- Kicker -->
    <div class="hero-kicker neon-flicker text-xs tracking-[0.35em] uppercase mb-4" style="color: var(--color-accent);">
      <span style="opacity:0.5">⟨</span>&nbsp; v1.0 · neural coding environment &nbsp;<span style="opacity:0.5">⟩</span>
    </div>

    <!-- Title with chromatic aberration on hover -->
    <h1 class="hero-title-glitch text-6xl sm:text-7xl font-black tracking-tight mb-4" data-text="AdaanIDE">
      <span class="hero-title">AdaanIDE</span>
    </h1>

    <!-- Typewriter tagline -->
    <p class="hero-tagline text-lg opacity-80 mb-7 h-7" style="color: var(--color-text);">
      <span class={!typingDone ? "caret-blink" : ""}>{typed}</span>
    </p>

    <!-- Feature pills -->
    <div class="flex flex-wrap items-center justify-center gap-2 mb-9 max-w-lg">
      {#each features as f (f.label)}
        <span class="feature-pill">
          <f.icon size={14} style="color: var(--color-accent);" />
          {f.label}
        </span>
      {/each}
    </div>

    <!-- Console panel: workspace picker -->
    <div bind:this={consoleEl} class="console-panel w-full p-6 sm:p-7 text-left">
      <div class="scan-line"></div>

      <!-- Console header -->
      <div class="flex items-center justify-between mb-5">
        <div class="flex items-center gap-2 text-xs tracking-[0.2em] uppercase" style="color: var(--color-muted);">
          <span class="inline-block w-2 h-2 rounded-full" style="background: var(--color-success); box-shadow: 0 0 8px var(--color-success);"></span>
          workspace · terminal
        </div>
        <div class="flex gap-1.5">
          <span class="w-2.5 h-2.5 rounded-full" style="background: var(--color-warning); opacity:0.6;"></span>
          <span class="w-2.5 h-2.5 rounded-full" style="background: var(--color-error); opacity:0.6;"></span>
        </div>
      </div>

      {#if loading}
        <div class="py-10 text-center opacity-60 font-mono text-sm">
          <span class="caret-blink">initializing</span>
        </div>
      {:else}
        {#if projectsStore.projects.length > 0}
          <div class="mb-4">
            <div class="flex items-center gap-2 text-xs font-semibold mb-2 tracking-wider uppercase" style="color: var(--color-muted);">
              <IconFolder size={14} /> Open projects · {projectsStore.projects.length}
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {#each projectsStore.projects as p (p.id)}
                <div class="ws-card group" style="cursor: pointer;" onclick={() => switchToProject(p.id)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter") switchToProject(p.id); }} title={p.rootPath}>
                  <IconFolder size={18} style="color: var(--color-accent); flex-shrink: 0;" />
                  <span class="min-w-0 flex-1 truncate">
                    <span class="ws-name block truncate">{p.name}</span>
                    <span class="ws-path block truncate">{dirname(p.rootPath)}</span>
                  </span>
                  <button
                    class="ws-card-close"
                    title="Close project"
                    aria-label="Close project"
                    onclick={(e) => closeOpenProject(p.id, e)}
                  >
                    <IconX size={13} />
                  </button>
                  <IconArrowRight size={14} style="color: var(--color-muted); flex-shrink: 0;" />
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#if !hasExisting}
        <div class="flex flex-col gap-4">
          <div class="text-sm font-mono opacity-70 py-2 text-center">
            No existing projects detected — initialize a new one to begin.
          </div>

          <div>
            <label for="new-name" class="block text-xs font-semibold mb-2 tracking-wider uppercase" style="color: var(--color-muted);">
              Project name
            </label>
            <input
              id="new-name"
              type="text"
              bind:value={newName}
              placeholder="my-new-project"
              class="console-input"
              onkeydown={(e) => e.key === "Enter" && createProject()}
            />
          </div>

          <div>
            <label for="new-parent" class="block text-xs font-semibold mb-2 tracking-wider uppercase" style="color: var(--color-muted);">
              Create inside
            </label>
            <input
              id="new-parent"
              type="text"
              bind:value={newParent}
              placeholder={defaultProjectDir || "/parent/directory"}
              class="console-input"
            />
          </div>

          <button
            class="cta-primary w-full mt-1"
            onclick={createProject}
            disabled={!newName.trim() || creating}
          >
            {creating ? "Initializing…" : "Initialize project"}
            <IconBolt size={18} />
          </button>
        </div>
      {:else}
        <div class="flex flex-col gap-4">
          <!-- Recent workspaces as cards -->
          {#if recent.length > 0}
            <div>
              <div class="flex items-center gap-2 text-xs font-semibold mb-2 tracking-wider uppercase" style="color: var(--color-muted);">
                <IconClock size={14} /> Recent
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {#each recent.slice(0, 4) as path (path)}
                  <button class="ws-card" onclick={() => openPath(path)}>
                    <IconFolder size={18} style="color: var(--color-accent); flex-shrink: 0;" />
                    <span class="min-w-0 flex-1 truncate">
                      <span class="ws-name block truncate">{basename(path)}</span>
                      <span class="ws-path block truncate">{dirname(path)}</span>
                    </span>
                    <IconArrowRight size={14} style="color: var(--color-muted); flex-shrink: 0;" />
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Dropdown for all candidates -->
          {#if candidates.length > 0 || recent.length > 0}
            <div>
              <label for="workspace-select" class="block text-xs font-semibold mb-2 tracking-wider uppercase" style="color: var(--color-muted);">
                Select workspace
              </label>
              <select id="workspace-select" class="console-select" bind:value={selected}>
                {#if recent.length > 0}
                  <optgroup label="Recent">
                    {#each recent as path (path)}
                      <option value={path}>{path}</option>
                    {/each}
                  </optgroup>
                {/if}
                {#if candidates.length > 0}
                  <optgroup label="Available">
                    {#each candidates as path (path)}
                      <option value={path}>{path}</option>
                    {/each}
                  </optgroup>
                {/if}
              </select>
            </div>
          {/if}

          <!-- Manual path -->
          <div>
            <label for="manual-path" class="block text-xs font-semibold mb-2 tracking-wider uppercase" style="color: var(--color-muted);">
              Or enter path
            </label>
            <div class="flex gap-2">
              <div class="relative flex-1">
                <span class="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm" style="color: var(--color-accent);">$</span>
                <input
                  id="manual-path"
                  type="text"
                  bind:value={manualPath}
                  placeholder="/path/to/your/project"
                  class="console-input"
                  onkeydown={(e) => e.key === "Enter" && handleOpen()}
                />
              </div>
              {#if isDesktop}
                <button
                  class="px-3 py-2 rounded-lg text-xs font-semibold tracking-wider uppercase whitespace-nowrap transition-all"
                  style="background: rgba(var(--accent-rgb), 0.12); border: 1px solid rgba(var(--accent-rgb), 0.3); color: var(--color-accent);"
                  onclick={nativeBrowse}
                  title="Open native file dialog"
                >
                  <IconFolder size={14} class="inline" /> Browse
                </button>
              {/if}
            </div>
          </div>

          <!-- CTA -->
          <button
            class="cta-primary w-full mt-1"
            onclick={handleOpen}
            disabled={!manualPath.trim() && !selected}
          >
            Launch workspace
            <IconArrowRight size={18} />
          </button>

          <!-- New project -->
          <div class="pt-2" style="border-top: 1px solid var(--color-border);">
            {#if !showNew}
              <button
                class="flex items-center gap-2 text-xs font-semibold tracking-wider uppercase opacity-70 hover:opacity-100 transition-opacity"
                style="color: var(--color-accent);"
                onclick={() => (showNew = true)}
              >
                <IconPlus size={14} /> New project
              </button>
            {:else}
              <div class="flex flex-col gap-3">
                <div class="flex items-center gap-2 text-xs font-semibold tracking-wider uppercase" style="color: var(--color-muted);">
                  <IconPlus size={14} /> New project
                </div>
                <input
                  type="text"
                  bind:value={newName}
                  placeholder="my-new-project"
                  class="console-input"
                  onkeydown={(e) => e.key === "Enter" && createProject()}
                />
                <input
                  type="text"
                  bind:value={newParent}
                  placeholder={defaultProjectDir || "/parent/directory"}
                  class="console-input"
                />
                <button
                  class="cta-primary w-full"
                  onclick={createProject}
                  disabled={!newName.trim() || creating}
                >
                  {creating ? "Initializing…" : "Initialize project"}
                  <IconBolt size={18} />
                </button>
              </div>
            {/if}
          </div>
        </div>
      {/if}
      {/if}

      {#if error}
        <div class="mt-4 text-xs font-mono" style="color: var(--color-error);">! {error}</div>
      {/if}
    </div>

    <!-- Stats row -->
    <div class="grid grid-cols-3 gap-6 mt-8 w-full max-w-sm">
      <div class="stat-tile">
        <div class="stat-value">{statModels}+</div>
        <div class="stat-label">Models</div>
      </div>
      <div class="stat-tile">
        <div class="stat-value">{statThemes}</div>
        <div class="stat-label">Themes</div>
      </div>
      <div class="stat-tile">
        <div class="stat-value">{statTools}</div>
        <div class="stat-label">Tools</div>
      </div>
    </div>
  </div>
</section>
