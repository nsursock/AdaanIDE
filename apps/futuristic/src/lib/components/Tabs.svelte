<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { workspaceStore } from "@adaan/core";
  import { IconX, IconCode } from "@tabler/icons-svelte";

  const dispatch = createEventDispatcher();

  function close(path: string) {
    dispatch("close", path);
  }

  function select(path: string) {
    workspaceStore.activeTabPath = path;
  }

  function getExtBadge(name: string) {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    if (ext === "ts" || ext === "tsx") return { label: "TS", class: "ext-ts" };
    if (ext === "js" || ext === "jsx" || ext === "mjs") return { label: "JS", class: "ext-js" };
    if (ext === "svelte") return { label: "SV", class: "ext-svelte" };
    if (ext === "py") return { label: "PY", class: "ext-py" };
    if (ext === "json" || ext === "yaml" || ext === "yml") return { label: ext.slice(0, 3).toUpperCase(), class: "ext-json" };
    if (ext === "css" || ext === "html") return { label: ext.toUpperCase(), class: "ext-css" };
    if (ext === "md" || ext === "txt") return { label: "MD", class: "ext-md" };
    return { label: ext.slice(0, 3).toUpperCase() || "DOC", class: "ext-md" };
  }
</script>

<div class="tab-bar">
  {#if workspaceStore.openTabs.length === 0}
    <div class="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--color-muted)] opacity-60 select-none">
      <IconCode size={14} class="text-[var(--color-accent)] opacity-60" />
      <span>⟨ no buffer loaded ⟩</span>
    </div>
  {:else}
    {#each workspaceStore.openTabs as tab (tab.path)}
      {@const ext = getExtBadge(tab.name)}
      <div
        class="tab {workspaceStore.activeTabPath === tab.path ? 'active' : ''}"
        role="tab"
        tabindex="0"
        aria-selected={workspaceStore.activeTabPath === tab.path}
        onclick={() => select(tab.path)}
        onkeydown={(e) => e.key === "Enter" && select(tab.path)}
      >
        <span class="ext-badge {ext.class}">{ext.label}</span>
        <span class="font-medium text-xs truncate max-w-[150px]">{tab.name}</span>
        {#if tab.dirty}
          <span class="dirty-dot" title="Unsaved changes (⌘S to write)"></span>
        {/if}
        <button
          type="button"
          class="tab-close"
          onclick={(e) => { e.stopPropagation(); close(tab.path); }}
          title="Close tab"
          aria-label="Close tab"
        >
          <IconX size={12} />
        </button>
      </div>
    {/each}
  {/if}
</div>
