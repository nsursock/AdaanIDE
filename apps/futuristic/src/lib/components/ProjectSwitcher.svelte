<script lang="ts">
  import { projectsStore } from "@adaan/core";
  import { createEventDispatcher, onMount, onDestroy } from "svelte";
  import {
    IconFolderCode,
    IconChevronDown,
    IconPlus,
    IconX,
    IconCheck,
  } from "@tabler/icons-svelte";

  const dispatch = createEventDispatcher();

  let open = $state(false);
  let rootEl: HTMLElement | null = $state(null);

  function toggle() {
    open = !open;
  }

  function switchTo(id: string) {
    projectsStore.switchTo(id);
    open = false;
  }

  async function closeProject(id: string, e: Event) {
    e.stopPropagation();
    e.preventDefault();
    const result = projectsStore.closeProject(id);
    // Free all server-side agent sessions for the closed project's chats.
    if (result?.sessionIds) {
      for (const sid of result.sessionIds) {
        try {
          await fetch(`/api/sessions/${sid}`, { method: "DELETE" });
        } catch {
          // best-effort
        }
      }
    }
    if (!projectsStore.hasProjects) open = false;
  }

  function openPicker() {
    projectsStore.showPicker();
    open = false;
    dispatch("openpicker");
  }

  function onDocClick(e: MouseEvent) {
    if (rootEl && !rootEl.contains(e.target as Node)) open = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") open = false;
  }

  onMount(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
  });
  onDestroy(() => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  });

  let active = $derived(projectsStore.active);
</script>

<div bind:this={rootEl} class="project-switcher relative">
  <button
    class="ws-badge project-switcher-btn"
    onclick={toggle}
    title="Switch project"
    aria-haspopup="listbox"
    aria-expanded={open}
  >
    <IconFolderCode size={14} class="text-[var(--color-accent)] flex-shrink-0" />
    <span class="font-bold truncate text-[var(--color-text)] max-w-[10rem] sm:max-w-[16rem]">
      {active?.name ?? "Select project"}
    </span>
    {#if projectsStore.backgroundStreamingCount > 0}
      <span class="pd-bg-streaming-badge" title="{projectsStore.backgroundStreamingCount} project(s) running in background">
        <span class="pd-bg-streaming-pulse"></span>
        {projectsStore.backgroundStreamingCount}
      </span>
    {/if}
    <IconChevronDown size={13} class="opacity-60 flex-shrink-0" style="transform: rotate({open ? 180 : 0}deg); transition: transform 0.2s;" />
  </button>

  {#if open}
    <div class="project-dropdown" role="listbox">
      <div class="pd-header">
        <span class="text-[0.625rem] font-semibold tracking-[0.18em] uppercase" style="color: var(--color-muted);">
          Open projects · {projectsStore.projects.length}
        </span>
      </div>

      <div class="pd-list">
        {#each projectsStore.projects as p (p.id)}
          <button
            class="pd-item"
            class:active={p.id === projectsStore.activeId}
            onclick={() => switchTo(p.id)}
            role="option"
            aria-selected={p.id === projectsStore.activeId}
            title={p.rootPath}
          >
            <IconFolderCode size={15} class="flex-shrink-0" style="color: var(--color-accent);" />
            <span class="min-w-0 flex-1 text-left">
              <span class="block truncate text-sm font-semibold text-[var(--color-text)]">
                {p.name}
                {#if projectsStore.isProjectStreaming(p)}
                  <span class="pd-streaming-dot" title="Agent is running"></span>
                {/if}
              </span>
              <span class="block truncate text-[0.6875rem] font-mono opacity-60">{p.rootPath}</span>
            </span>
            {#if p.id === projectsStore.activeId}
              <IconCheck size={14} class="flex-shrink-0" style="color: var(--color-success);" />
            {/if}
            <span
              class="pd-close"
              role="button"
              tabindex="-1"
              aria-label="Close project"
              onclick={(e) => closeProject(p.id, e)}
              onkeydown={(e) => { if (e.key === "Enter") closeProject(p.id, e); }}
            >
              <IconX size={13} />
            </span>
          </button>
        {/each}
      </div>

      <div class="pd-footer">
        <button class="pd-action" onclick={openPicker}>
          <IconPlus size={14} /> Open another project…
        </button>
      </div>
    </div>
  {/if}
</div>
