<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    IconSearch,
    IconFileCode,
    IconEdit,
    IconTrash,
    IconTerminal,
    IconCheck,
    IconAlertTriangle,
    IconClock,
    IconDatabase,
    IconChevronDown,
    IconChevronRight,
  } from "@tabler/icons-svelte";

  let { toolCall } = $props<{
    toolCall: {
      id: string;
      name: string;
      args: Record<string, unknown>;
      result?: unknown;
      error?: string;
      pending?: boolean;
      approvalRequired?: boolean;
      cached?: boolean;
    };
  }>();

  let expanded = $state(false);
  let autoOpened = $state(false);

  function isShellResult(result: unknown): result is {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    timedOut?: boolean;
  } {
    return !!result && typeof result === "object" && ("stdout" in result || "stderr" in result);
  }

  const shell = $derived(isShellResult(toolCall.result) ? toolCall.result : null);
  const resultWarning = $derived(
    toolCall.result && typeof toolCall.result === "object" && "warning" in (toolCall.result as any)
      ? ((toolCall.result as any).warning as string)
      : null,
  );
  const stdoutPreview = $derived((shell?.stdout ?? "").trim().split("\n")[0]?.slice(0, 80) ?? "");

  $effect(() => {
    if (!autoOpened && shell && ((shell.stdout ?? "").trim() || (shell.stderr ?? "").trim())) {
      expanded = true;
      autoOpened = true;
    }
  });

  // Track how long a tool call has been pending so a stalled/slow model
  // response is visible instead of silently looking "stuck" forever.
  let pendingSeconds = $state(0);
  let pendingTimer: ReturnType<typeof setInterval> | undefined;

  $effect(() => {
    if (toolCall.pending) {
      if (!pendingTimer) {
        const startedAt = Date.now();
        pendingTimer = setInterval(() => {
          pendingSeconds = Math.floor((Date.now() - startedAt) / 1000);
        }, 1000);
      }
    } else if (pendingTimer) {
      clearInterval(pendingTimer);
      pendingTimer = undefined;
      pendingSeconds = 0;
    }
  });

  onDestroy(() => {
    if (pendingTimer) clearInterval(pendingTimer);
  });

  const toolIcons: Record<string, any> = {
    list_files: IconSearch,
    read_file: IconFileCode,
    list_symbols: IconSearch,
    search_files: IconSearch,
    apply_patch: IconEdit,
    write_file: IconEdit,
    create_file: IconFileCode,
    delete_file: IconTrash,
    execute_command: IconTerminal,
    run_tests: IconTerminal,
    git_status: IconSearch,
    git_diff: IconSearch,
    git_checkpoint: IconCheck,
    git_rollback: IconEdit,
  };

  const Icon = $derived(toolIcons[toolCall.name] || IconFileCode);
</script>

<div class="tool-card">
  <button
    type="button"
    class="tool-head w-full"
    onclick={() => expanded = !expanded}
  >
    <span class="opacity-60 flex-shrink-0">
      {#if expanded}
        <IconChevronDown size={12} />
      {:else}
        <IconChevronRight size={12} />
      {/if}
    </span>
    <Icon size={14} class="text-[var(--color-accent)] flex-shrink-0" />
    <span class="font-bold truncate text-[var(--color-text)]">{toolCall.name}</span>
    {#if !expanded && stdoutPreview}
      <span class="truncate opacity-50 text-[0.6875rem] flex-1 min-w-0">{stdoutPreview}</span>
    {/if}

    {#if toolCall.cached}
      <span class="ml-auto tool-badge cached">
        <IconDatabase size={11} /> cached
      </span>
    {/if}

    {#if toolCall.pending}
      <span class="ml-auto tool-badge warn">
        <IconClock size={11} class="animate-spin" />
        running{pendingSeconds > 0 ? ` · ${pendingSeconds}s` : ""}
      </span>
    {/if}

    {#if toolCall.approvalRequired}
      <span class="ml-auto tool-badge warn">
        <IconAlertTriangle size={11} /> approval
      </span>
    {/if}

    {#if toolCall.error}
      <span class="ml-auto tool-badge err">
        <IconAlertTriangle size={11} /> error
      </span>
    {/if}

    {#if resultWarning}
      <span class="ml-auto tool-badge warn">
        <IconAlertTriangle size={11} /> warning
      </span>
    {:else if toolCall.result !== undefined && !toolCall.error}
      <span class="ml-auto tool-badge ok">
        <IconCheck size={11} /> ok
      </span>
    {/if}
  </button>

  {#if resultWarning}
    <div class="px-2.5 py-1.5 border-t border-[var(--color-border)] bg-[rgba(255,184,108,0.06)] text-[0.6875rem] text-[var(--color-warning)] flex items-start gap-1.5">
      <IconAlertTriangle size={12} class="flex-shrink-0 mt-0.5" />
      <span>{resultWarning}</span>
    </div>
  {/if}

  {#if toolCall.pending && pendingSeconds >= 15}
    <div class="px-2.5 py-1.5 border-t border-[var(--color-border)] bg-[rgba(255,184,108,0.06)] text-[0.6875rem] text-[var(--color-warning)] flex items-center gap-1.5">
      <IconAlertTriangle size={12} class="flex-shrink-0" />
      <span>
        Model is slow to respond{pendingSeconds >= 30 ? " — this free model may be stalled" : ""}.
        It will auto-retry on another model after {Math.max(0, 45 - pendingSeconds)}s, or hit Cancel to stop now.
      </span>
    </div>
  {/if}

  {#if expanded}
    <div class="tool-body">
      <!-- Args -->
      <div class="mb-2">
        <div class="flex items-center gap-1.5 opacity-70 text-[0.6875rem] font-bold uppercase tracking-wider text-[var(--color-muted)] mb-1">
          <span>Parameters</span>
        </div>
        <pre>{JSON.stringify(toolCall.args, null, 2)}</pre>
      </div>

      <!-- Result -->
      {#if toolCall.result !== undefined}
        <div class="mb-2">
          {#if shell}
            <div class="flex items-center gap-1.5 opacity-70 text-[0.6875rem] font-bold uppercase tracking-wider {shell.timedOut ? 'text-[var(--color-warning)]' : 'text-[var(--color-success)]'} mb-1">
              <span>stdout{shell.timedOut ? " · timed out" : shell.exitCode !== undefined ? ` · exit ${shell.exitCode}` : ""}</span>
            </div>
            {#if (shell.stdout ?? "").trim()}
              <pre class="tool-stdout max-h-72 overflow-y-auto">{shell.stdout}</pre>
            {:else}
              <pre class="opacity-50">(no stdout)</pre>
            {/if}
            {#if (shell.stderr ?? "").trim()}
              <div class="flex items-center gap-1.5 text-[0.6875rem] font-bold uppercase tracking-wider text-[var(--color-error)] mt-2 mb-1">
                <span>stderr</span>
              </div>
              <pre class="tool-stderr max-h-40 overflow-y-auto">{shell.stderr}</pre>
            {/if}
          {:else}
            <div class="flex items-center gap-1.5 opacity-70 text-[0.6875rem] font-bold uppercase tracking-wider text-[var(--color-success)] mb-1">
              <span>Result Payload</span>
            </div>
            <pre class="max-h-56 overflow-y-auto">{JSON.stringify(toolCall.result, null, 2)}</pre>
          {/if}
        </div>
      {/if}

      <!-- Error -->
      {#if toolCall.error}
        <div class="mb-1">
          <div class="flex items-center gap-1.5 text-[0.6875rem] font-bold uppercase tracking-wider text-[var(--color-error)] mb-1">
            <span>Execution Error</span>
          </div>
          <pre class="text-[var(--color-error)] border-[rgba(255,85,85,0.4)] bg-[rgba(255,85,85,0.08)]">{toolCall.error}</pre>
        </div>
      {/if}
    </div>
  {/if}
</div>
