<script lang="ts">
  import {
    workspaceStore,
    settingsStore,
    projectsStore,
    SIDEBAR_MIN,
    SIDEBAR_MAX,
    CHAT_MIN,
    CHAT_MAX,
    TERMINAL_MIN,
    TERMINAL_MAX,
  } from "@adaan/core";
  import { fly } from "svelte/transition";
  import { cubicInOut } from "svelte/easing";
  import { gsap } from "gsap";
  import WorkspacePicker from "$lib/components/WorkspacePicker.svelte";
  import ProjectSwitcher from "$lib/components/ProjectSwitcher.svelte";
  import FileTree from "$lib/components/FileTree.svelte";
  import HistoryPanel from "$lib/components/HistoryPanel.svelte";
  import Editor from "$lib/components/Editor.svelte";
  import Tabs from "$lib/components/Tabs.svelte";
  import ChatPanel from "$lib/components/ChatPanel.svelte";
  import TerminalPane from "$lib/components/TerminalPane.svelte";
  import ThemeSwitcher from "$lib/components/ThemeSwitcher.svelte";
  import SettingsPanel from "$lib/components/SettingsPanel.svelte";
  import TelemetryPanel from "$lib/components/TelemetryPanel.svelte";
  import {
    IconCode,
    IconMessage,
    IconFolder,
    IconCube,
    IconHome,
    IconTerminal2,
    IconSparkles,
    IconSettings,
    IconChartBar,
  } from "@tabler/icons-svelte";

  // The active project's root path (null when the launcher is showing).
  // Backed by the projectsStore so multi-project switching is reflected here.
  let workspaceRoot = $derived(projectsStore.activeRoot);
  let showSidebar = $state(true);
  let showChat = $state(true);
  let threeEnabled = $state(true);
  let showSettings = $state(false);
  let showTelemetry = $state(false);
  let showTerminal = $state(settingsStore.settings.terminalEnabled);

  // --- Resizable sidebars ---------------------------------------------------
  // Widths are seeded from the unified settings store and written back on
  // drag-end. Local state holds the live value during a drag.
  let sidebarWidth = $state(settingsStore.settings.sidebarWidth);
  let chatWidth = $state(settingsStore.settings.chatWidth);
  let terminalHeight = $state(settingsStore.settings.terminalHeight);

  // --- Drag handling --------------------------------------------------------
  type DragState =
    | { which: "sidebar" | "chat"; startX: number; startW: number }
    | { which: "terminal"; startY: number; startH: number }
    | null;
  let drag: DragState = $state(null);

  function startResize(which: "sidebar" | "chat", e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    drag = { which, startX: e.clientX, startW: which === "sidebar" ? sidebarWidth : chatWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function startTerminalResize(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    drag = { which: "terminal", startY: e.clientY, startH: terminalHeight };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }

  function onMove(e: MouseEvent) {
    if (!drag) return;
    if (drag.which === "terminal") {
      // Terminal is at the bottom — dragging up increases height.
      const delta = drag.startY - e.clientY;
      terminalHeight = Math.min(TERMINAL_MAX, Math.max(TERMINAL_MIN, drag.startH + delta));
      return;
    }
    const delta = e.clientX - drag.startX;
    if (drag.which === "sidebar") {
      // Sidebar is on the left — dragging right increases width.
      sidebarWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, drag.startW + delta));
    } else {
      // Chat is on the right — dragging left increases width.
      chatWidth = Math.min(CHAT_MAX, Math.max(CHAT_MIN, drag.startW - delta));
    }
  }

  function endResize() {
    if (!drag) return;
    if (drag.which === "sidebar") settingsStore.setSidebarWidth(sidebarWidth);
    else if (drag.which === "chat") settingsStore.setChatWidth(chatWidth);
    else settingsStore.setTerminalHeight(terminalHeight);
    drag = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  function toggleTerminal() {
    showTerminal = !showTerminal;
    settingsStore.setTerminalEnabled(showTerminal);
  }

  // Attach global listeners while dragging
  $effect(() => {
    if (!drag) return;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", endResize);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", endResize);
    };
  });

  async function openWorkspace(root: string) {
    const name = root.split("/").pop() || root;
    projectsStore.openProject(root, name);
    await loadTree();
    requestAnimationFrame(() => {
      gsap.from(".panel-enter", { y: 15, opacity: 0, duration: 0.5, stagger: 0.08, ease: "power3.out" });
      gsap.from(".app-bar", { y: -20, opacity: 0, duration: 0.5, ease: "power3.out" });
    });
  }

  /** Switch to an already-open project. If the project's tree is stale
   *  (a background agent modified files), reload the tree and refresh open
   *  tabs from disk so the user sees the latest state. */
  function switchToProject(id: string) {
    const entry = projectsStore.switchTo(id);
    if (entry?.treeStale) {
      loadTree();
      refreshOpenTabs();
      projectsStore.clearTreeStale(entry.rootPath);
    }
    requestAnimationFrame(() => {
      gsap.from(".panel-enter", { y: 12, opacity: 0, duration: 0.4, stagger: 0.06, ease: "power3.out" });
    });
  }

  /** Re-fetch content for all non-dirty open tabs so they reflect on-disk
   *  changes made by a background agent while the user was viewing another
   *  project. Dirty tabs (user has unsaved edits) are left alone. */
  async function refreshOpenTabs() {
    if (!workspaceRoot) return;
    for (const tab of workspaceStore.openTabs) {
      if (tab.dirty) continue;
      try {
        const res = await fetch(`/api/files/read?root=${encodeURIComponent(workspaceRoot)}&path=${encodeURIComponent(tab.path)}`);
        if (res.ok) {
          const data = await res.json();
          tab.content = data.content;
          tab.hash = data.hash;
          tab.dirty = false;
        }
      } catch {
        // file may have been deleted — ignore
      }
    }
  }

  function backToPicker() {
    projectsStore.showPicker();
  }

  async function loadTree() {
    if (!workspaceRoot) return;
    const showHidden = workspaceStore.showHidden ? "1" : "0";
    const res = await fetch(`/api/files/list?root=${encodeURIComponent(workspaceRoot)}&showHidden=${showHidden}`);
    if (res.ok) {
      const tree = await res.json();
      workspaceStore.setTree(tree);
    }
  }

  async function openFile(path: string) {
    if (!workspaceRoot) return;
    const res = await fetch(`/api/files/read?root=${encodeURIComponent(workspaceRoot)}&path=${encodeURIComponent(path)}`);
    if (res.ok) {
      const data = await res.json();
      workspaceStore.openFile(path, data.content, data.hash);
    }
  }

  async function saveFile(path: string, content: string, hash: string) {
    if (!workspaceRoot) return;
    const res = await fetch("/api/files/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: workspaceRoot, path, content, expectedHash: hash }),
    });
    if (res.ok) {
      const data = await res.json();
      workspaceStore.markClean(path);
      const tab = workspaceStore.openTabs.find((t) => t.path === path);
      if (tab) tab.hash = data.hash;
    }
  }

  // --- Electron desktop integration ---------------------------------------
  // When running inside the Electron wrapper, native menu accelerators
  // (Cmd/Ctrl+S, Cmd/Ctrl+O) arrive as IPC events on window.adaan.
  // In a plain browser these are no-ops (window.adaan is undefined).
  $effect(() => {
    const api = window.adaan;
    if (!api) return;

    // File → Save (Cmd/Ctrl+S from native menu)
    const unsave = api.onSave(() => {
      const tab = workspaceStore.activeTab;
      if (tab && tab.dirty) {
        saveFile(tab.path, tab.content, tab.hash);
      }
    });

    // File → Open Workspace (Cmd/Ctrl+O from native menu)
    const unopen = api.onOpenWorkspace(() => {
      api.openWorkspaceDialog().then((p) => {
        if (p) openWorkspace(p);
      });
    });

    // Workspace path from native open dialog (triggered by main process)
    const unws = api.onWorkspaceOpened((p) => {
      openWorkspace(p);
    });

    // File → New File (Cmd/Ctrl+N from native menu)
    const unnew = api.onNewFile(() => {
      // Dispatch a custom event the FileTree can listen for, or just
      // focus the editor for now — full new-file flow is handled in-app.
      window.dispatchEvent(new CustomEvent("adaan:new-file"));
    });

    return () => {
      unsave();
      unopen();
      unws();
      unnew();
    };
  });
</script>

{#if !workspaceRoot}
  <WorkspacePicker
    on:open={(e) => openWorkspace(e.detail)}
    on:switch={(e) => switchToProject(e.detail)}
  />
{:else}
  <!-- App bar -->
  <header class="app-bar flex items-center justify-between">
    <div class="flex items-center gap-2.5 min-w-0">
      <button class="icon-btn" onclick={backToPicker} title="Return to launcher console" aria-label="Return to launcher console">
        <IconHome size={16} />
      </button>

      <div class="flex items-center gap-1.5 select-none">
        <span class="brand-mark text-base font-black">AdaanIDE</span>
        <span class="text-[0.6875rem] px-1.5 py-0.5 rounded border border-[var(--color-border)] opacity-75 font-semibold text-[var(--color-accent)]">
          ⟨ v1.0 ⟩
        </span>
      </div>

      <span class="opacity-25 text-xs select-none">//</span>

      <!-- Workspace project switcher (top bar) -->
      <ProjectSwitcher on:openpicker={backToPicker} />

      <span class="status-chip hidden md:inline-flex">
        <span class="dot"></span> sys: online
      </span>
    </div>

    <!-- Right HUD controls -->
    <div class="flex items-center gap-1.5">
      <button
        class="icon-btn {showSidebar ? 'active' : ''}"
        onclick={() => showSidebar = !showSidebar}
        title="{showSidebar ? 'Hide' : 'Show'} File Explorer"
        aria-label="Toggle file explorer"
      >
        <IconFolder size={16} />
      </button>
      <button
        class="icon-btn {showChat ? 'active' : ''}"
        onclick={() => showChat = !showChat}
        title="{showChat ? 'Hide' : 'Show'} Neural Agent"
        aria-label="Toggle neural agent"
      >
        <IconMessage size={16} />
      </button>
      <button
        class="icon-btn {showTerminal ? 'active' : ''}"
        onclick={toggleTerminal}
        title="{showTerminal ? 'Hide' : 'Show'} Terminal"
        aria-label="Toggle terminal"
      >
        <IconTerminal2 size={16} />
      </button>
      <a
        href="http://localhost:5173"
        class="icon-btn"
        title="Switch to Classic UI"
        aria-label="Classic version"
      >
        <IconCode size={16} />
      </a>
      <div class="w-px h-4 mx-0.5 bg-[var(--color-border)] opacity-60"></div>
      <ThemeSwitcher />
      <button
        class="icon-btn {showTelemetry ? 'active' : ''}"
        onclick={() => showTelemetry = !showTelemetry}
        title="Telemetry"
        aria-label="Open telemetry console"
      >
        <IconChartBar size={16} />
      </button>
      <button
        class="icon-btn {showSettings ? 'active' : ''}"
        onclick={() => showSettings = !showSettings}
        title="Settings"
        aria-label="Open settings"
      >
        <IconSettings size={16} />
      </button>
    </div>
  </header>

  <!-- Main 3-pane layout -->
  <div class="flex-1 flex overflow-hidden gap-1 p-1" style="background: rgba(var(--bg-deep-rgb), 0.4);">
    {#if showSidebar}
      <div
        class="sidebar-wrap"
        transition:fly={{ x: -sidebarWidth, duration: 280, easing: cubicInOut, opacity: 0 }}
      >
        <aside
          class="panel-enter pane pane-bracketed flex flex-col overflow-hidden rounded-lg"
          style="width: {sidebarWidth}px;"
        >
          <FileTree on:open={(e) => openFile(e.detail)} on:refresh={loadTree} />
          <HistoryPanel {workspaceRoot} />
        </aside>
        <button
          type="button"
          class="resizer"
          onmousedown={(e) => startResize("sidebar", e)}
          tabindex="-1"
          aria-label="Resize sidebar"
        ></button>
      </div>
    {/if}

    <div class="editor-col flex-1 flex flex-col overflow-hidden gap-1 min-w-0">
      <main class="panel-enter pane pane-bracketed flex-1 flex flex-col overflow-hidden rounded-lg">
        {#if showTelemetry}
          <TelemetryPanel onClose={() => (showTelemetry = false)} />
        {:else}
          <Tabs on:close={(e) => workspaceStore.closeTab(e.detail)} />
          <Editor {workspaceRoot} on:save={(e) => saveFile(e.detail.path, e.detail.content, e.detail.hash)} />
        {/if}
      </main>
      {#if showTerminal && settingsStore.settings.terminalMode === "editor"}
        <button
          type="button"
          class="terminal-resizer"
          onmousedown={startTerminalResize}
          tabindex="-1"
          aria-label="Resize terminal"
        ></button>
        <TerminalPane {workspaceRoot} height={terminalHeight} />
      {/if}
    </div>

    {#if showChat}
      <div
        class="chat-wrap"
        transition:fly={{ x: chatWidth, duration: 280, easing: cubicInOut, opacity: 0 }}
      >
        <button
          type="button"
          class="resizer"
          onmousedown={(e) => startResize("chat", e)}
          tabindex="-1"
          aria-label="Resize chat panel"
        ></button>
        <aside
          class="panel-enter pane pane-bracketed flex flex-col overflow-hidden rounded-lg"
          style="width: {chatWidth}px;"
        >
          <ChatPanel {workspaceRoot} onFileChanged={loadTree} />
        </aside>
      </div>
    {/if}
  </div>

  {#if showTerminal && settingsStore.settings.terminalMode === "full"}
    <button
      type="button"
      class="terminal-resizer"
      onmousedown={startTerminalResize}
      tabindex="-1"
      aria-label="Resize terminal"
    ></button>
    <TerminalPane {workspaceRoot} height={terminalHeight} />
  {/if}
{/if}

<SettingsPanel bind:open={showSettings} />
