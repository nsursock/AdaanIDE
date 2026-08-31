<script lang="ts">
  import { IconFileDiff } from "@tabler/icons-svelte";

  let { oldContent, newContent, path } = $props<{ oldContent: string; newContent: string; path: string }>();

  let newLines = $derived(newContent.split("\n"));
</script>

<div class="rounded-lg border border-[var(--color-border)] text-xs overflow-hidden bg-[rgba(var(--bg-deep-rgb),0.6)] font-mono">
  <div class="px-3 py-1.5 border-b border-[var(--color-border)] flex items-center gap-2 bg-[rgba(var(--surface-1-rgb),0.5)]">
    <IconFileDiff size={14} class="text-[var(--color-accent)]" />
    <span class="font-bold text-[var(--color-text)] truncate">{path}</span>
    <span class="ml-auto text-[0.625rem] px-1.5 py-0.2 rounded bg-[rgba(var(--success-rgb),0.15)] text-[var(--color-success)] border border-[rgba(var(--success-rgb),0.3)]">
      DIFF VIEW
    </span>
  </div>
  <div class="max-h-60 overflow-y-auto">
    {#each newLines as line, i}
      <div class="px-3 py-0.5 hover:bg-[rgba(var(--accent-rgb),0.06)] flex items-start gap-3">
        <span class="opacity-40 text-right w-6 select-none flex-shrink-0">{i + 1}</span>
        <span class="whitespace-pre-wrap break-all flex-1">{line}</span>
      </div>
    {/each}
  </div>
</div>
