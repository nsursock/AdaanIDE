<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { workspaceStore } from "@adaan/core";
  import type { FileNode } from "@adaan/core";
  import {
    IconFolder,
    IconFolderOpen,
    IconRefresh,
    IconChevronRight,
    IconChevronDown,
    IconFileCode,
    IconFileText,
    IconBrackets,
    IconSearch,
    IconFolderMinus,
    IconFileDescription,
    IconEye,
    IconEyeOff,
    IconTrash,
  } from "@tabler/icons-svelte";

  const dispatch = createEventDispatcher();
  let expanded = $state<Set<string>>(new Set());
  let searchQuery = $state("");
  let pendingDelete = $state<string | null>(null);
  let deleting = $state(false);

  function toggle(path: string) {
    if (expanded.has(path)) {
      expanded.delete(path);
    } else {
      expanded.add(path);
    }
    expanded = new Set(expanded);
  }

  function collapseAll() {
    expanded = new Set();
  }

  function open(path: string) {
    dispatch("open", path);
  }

  function requestDelete(path: string, e: MouseEvent) {
    e.stopPropagation();
    pendingDelete = path;
  }

  function cancelDelete() {
    pendingDelete = null;
  }

  async function confirmDelete() {
    if (!pendingDelete || !workspaceStore.workspace?.rootPath) return;
    deleting = true;
    try {
      const res = await fetch("/api/files/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: workspaceStore.workspace.rootPath, path: pendingDelete }),
      });
      if (res.ok) {
        // Close the tab if it's open
        workspaceStore.closeTab(pendingDelete);
        dispatch("refresh");
      }
    } finally {
      deleting = false;
      pendingDelete = null;
    }
  }

  function getFileMeta(name: string) {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    if (ext === "ts" || ext === "tsx") return { label: "TS", class: "ext-ts", icon: IconFileCode };
    if (ext === "js" || ext === "jsx" || ext === "mjs") return { label: "JS", class: "ext-js", icon: IconFileCode };
    if (ext === "svelte") return { label: "SV", class: "ext-svelte", icon: IconFileCode };
    if (ext === "py") return { label: "PY", class: "ext-py", icon: IconFileCode };
    if (ext === "json" || ext === "yaml" || ext === "yml" || ext === "toml") return { label: ext.slice(0, 3).toUpperCase(), class: "ext-json", icon: IconBrackets };
    if (ext === "css" || ext === "scss" || ext === "html") return { label: ext.toUpperCase(), class: "ext-css", icon: IconFileCode };
    if (ext === "md" || ext === "txt" || ext === "log") return { label: "MD", class: "ext-md", icon: IconFileText };
    return { label: ext.slice(0, 3).toUpperCase() || "DOC", class: "ext-md", icon: IconFileDescription };
  }

  // Filter helper
  function nodeMatches(node: FileNode, q: string): boolean {
    if (!q) return true;
    if (node.name.toLowerCase().includes(q.toLowerCase())) return true;
    if (node.children) {
      return node.children.some((c) => nodeMatches(c, q));
    }
    return false;
  }

  // Count total nodes
  function countFiles(nodes: FileNode[]): number {
    let count = 0;
    for (const n of nodes) {
      if (n.type === "file") count++;
      if (n.children) count += countFiles(n.children);
    }
    return count;
  }
  const totalFiles = $derived(countFiles(workspaceStore.tree));
</script>

<div class="flex-1 flex flex-col overflow-hidden relative">
  <div class="pane-scan"></div>

  <!-- Pane Header -->
  <div class="pane-header">
    <div class="pane-title">
      <span class="pane-title-bar"></span>
      <span class="kicker-tag">01 //</span>
      <span>Explorer</span>
      <span class="text-[0.625rem] px-1.5 py-0.2 rounded bg-[rgba(var(--accent-rgb),0.12)] text-[var(--color-accent)] font-mono border border-[rgba(var(--accent-rgb),0.25)]">
        {totalFiles}
      </span>
    </div>
    <div class="flex items-center gap-1">
      <button
        class="icon-btn"
        style="width:1.6rem;height:1.6rem;"
        onclick={() => { workspaceStore.toggleHidden(); dispatch("refresh"); }}
        title={workspaceStore.showHidden ? "Hide invisible files" : "Show invisible files"}
        aria-label="Toggle hidden files"
        aria-pressed={workspaceStore.showHidden}
      >
        {#if workspaceStore.showHidden}
          <IconEyeOff size={13} />
        {:else}
          <IconEye size={13} />
        {/if}
      </button>
      <button
        class="icon-btn"
        style="width:1.6rem;height:1.6rem;"
        onclick={collapseAll}
        title="Collapse all folders"
        aria-label="Collapse all"
      >
        <IconFolderMinus size={13} />
      </button>
      <button
        class="icon-btn"
        style="width:1.6rem;height:1.6rem;"
        onclick={() => dispatch("refresh")}
        title="Refresh workspace files"
        aria-label="Refresh"
      >
        <IconRefresh size={13} />
      </button>
    </div>
  </div>

  <!-- Quick Filter Box -->
  <div class="px-2 pt-2 pb-1">
    <div class="relative">
      <IconSearch size={13} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)] opacity-60" />
      <input
        type="text"
        bind:value={searchQuery}
        placeholder="Filter files..."
        class="input text-xs pl-7 py-1 h-7 rounded-md bg-[rgba(var(--bg-deep-rgb),0.6)] border-[var(--color-border)] focus:border-[var(--color-accent)] placeholder:text-[var(--color-muted)] placeholder:opacity-50"
      />
      {#if searchQuery}
        <button
          class="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
          onclick={() => searchQuery = ""}
        >
          ✕
        </button>
      {/if}
    </div>
  </div>

  <!-- File Tree View -->
  <div class="flex-1 overflow-y-auto py-1 px-1.5 space-y-0.5">
    {#snippet treeNode(node: FileNode, depth: number)}
      {#if nodeMatches(node, searchQuery)}
        {@const isActive = workspaceStore.activeTabPath === node.path}
        {@const meta = getFileMeta(node.name)}
        {@const zoneOpacity = node.zone === "protected" ? "opacity: 0.5;" : node.zone === "sensitive" ? "opacity: 0.7;" : ""}
        <div
          class="tree-item {node.type === 'file' ? 'is-file' : 'is-dir'} {isActive ? 'is-active' : ''}"
          style="padding-left: {depth * 14 + 6}px; {zoneOpacity}"
          onclick={() => node.type === "dir" ? toggle(node.path) : open(node.path)}
          role="button"
          tabindex="0"
          onkeydown={(e) => e.key === "Enter" && (node.type === "dir" ? toggle(node.path) : open(node.path))}
        >
          {#if node.type === "dir"}
            <span class="opacity-60 flex-shrink-0 mr-0.5">
              {#if expanded.has(node.path) || searchQuery}
                <IconChevronDown size={12} />
              {:else}
                <IconChevronRight size={12} />
              {/if}
            </span>
            {#if expanded.has(node.path) || searchQuery}
              <IconFolderOpen size={15} class="text-[var(--color-accent)] flex-shrink-0" />
            {:else}
              <IconFolder size={15} class="text-[var(--color-accent)] opacity-85 flex-shrink-0" />
            {/if}
          {:else}
            <span class="w-3 flex-shrink-0"></span>
            <span class="ext-badge {meta.class} mr-1">{meta.label}</span>
          {/if}
          <span class="truncate flex-1 {isActive ? 'font-bold' : ''}">{node.name}</span>
          {#if node.type === "file" && node.zone !== "protected"}
            <button
              class="tree-delete-btn"
              onclick={(e) => requestDelete(node.path, e)}
              title="Delete file"
              aria-label="Delete {node.name}"
            >
              <IconTrash size={12} />
            </button>
          {/if}
        </div>

        {#if node.type === "dir" && (expanded.has(node.path) || searchQuery) && node.children}
          {#each node.children as child}
            {@render treeNode(child, depth + 1)}
          {/each}
        {/if}
      {/if}
    {/snippet}

    {#if workspaceStore.tree.length === 0}
      <div class="p-6 text-center text-xs opacity-50 font-mono">
        ⟨ empty workspace ⟩
      </div>
    {:else}
      {#each workspaceStore.tree as root}
        {@render treeNode(root, 0)}
      {/each}
    {/if}
  </div>

  <!-- Delete confirmation modal -->
  {#if pendingDelete}
    <div class="delete-confirm-overlay" onclick={cancelDelete} role="button" tabindex="-1" aria-label="Cancel delete">
      <div class="delete-confirm-dialog" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="Confirm file deletion">
        <div class="flex items-center gap-2 mb-3">
          <IconTrash size={18} class="text-[var(--color-error)] flex-shrink-0" />
          <span class="font-bold text-sm">Delete file?</span>
        </div>
        <p class="text-xs opacity-70 mb-1">This action cannot be undone.</p>
        <p class="text-xs font-mono text-[var(--color-accent)] mb-4 truncate" title={pendingDelete}>{pendingDelete}</p>
        <div class="flex items-center justify-end gap-2">
          <button class="btn text-xs px-3 py-1.5" onclick={cancelDelete} disabled={deleting}>Cancel</button>
          <button class="btn-danger text-xs px-3 py-1.5" onclick={confirmDelete} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>
