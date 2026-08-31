<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { IconAlertTriangle, IconCheck, IconX, IconShieldLock } from "@tabler/icons-svelte";

  const dispatch = createEventDispatcher();

  let { toolName, args } = $props<{
    toolName: string;
    args: Record<string, unknown>;
  }>();
</script>

<div class="approval-card">
  <div class="flex items-center justify-between mb-2">
    <div class="flex items-center gap-2">
      <IconAlertTriangle size={17} class="text-[var(--color-warning)] animate-bounce" />
      <span class="font-bold text-xs tracking-wider uppercase text-[var(--color-warning)]">
        Permission Required
      </span>
    </div>
    <span class="px-2 py-0.5 rounded bg-[rgba(255,184,108,0.15)] text-[var(--color-warning)] border border-[rgba(255,184,108,0.3)] font-mono text-[0.6875rem] font-bold">
      {toolName}
    </span>
  </div>

  <div class="mb-3">
    <div class="text-[0.625rem] text-[var(--color-muted)] font-bold tracking-wider uppercase mb-1">
      Payload Parameters
    </div>
    <pre class="text-xs p-2.5 rounded-lg bg-[rgba(var(--bg-deep-rgb),0.75)] border border-[var(--color-border)] font-mono text-[var(--color-text)] max-h-40 overflow-y-auto">{JSON.stringify(args, null, 2)}</pre>
  </div>

  <div class="flex gap-2">
    <button class="approval-btn approve flex-1 justify-center" onclick={() => dispatch("approve", true)}>
      <IconCheck size={15} /> Authorize Execution
    </button>
    <button class="approval-btn deny flex-1 justify-center" onclick={() => dispatch("approve", false)}>
      <IconX size={15} /> Deny
    </button>
  </div>
</div>
