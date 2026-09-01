<script lang="ts">
  import type { ChatMessageEntry } from "@adaan/core";
  import ToolCallCard from "./ToolCallCard.svelte";
  import { IconUser, IconBrain, IconCpu, IconSparkles, IconAlertTriangle, IconCreditCard, IconX } from "@tabler/icons-svelte";

  let {
    msg,
    onTryPaidModel = () => {},
    onDismissExhausted = () => {},
  } = $props<{
    msg: ChatMessageEntry;
    onTryPaidModel?: () => void;
    onDismissExhausted?: () => void;
  }>();

  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  function fmtCost(c: number): string {
    if (c === 0) return "$0";
    if (c < 0.01) return `$${c.toFixed(4)}`;
    return `$${c.toFixed(2)}`;
  }

  function fmtDuration(ms: number): string {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(0)}s`;
    const m = Math.floor(s / 60);
    return `${m}m${Math.round(s % 60)}s`;
  }
</script>

<div class="msg-card {msg.role}">
  <!-- Role indicator -->
  <div class="flex items-center justify-between gap-2 mb-2">
    <div class="flex items-center gap-1.5">
      {#if msg.role === "user"}
        <IconUser size={14} class="text-[var(--color-accent)]" />
        <span class="msg-role"><span class="msg-role-bar"></span>User Input</span>
      {:else}
        <IconBrain size={14} class="text-[var(--color-accent-cyan)]" />
        <span class="msg-role"><span class="msg-role-bar"></span>Neural Response</span>
      {/if}
    </div>

    {#if msg.modelUsed}
      <span class="msg-model">{msg.modelUsed}</span>
    {/if}
  </div>

  <!-- Model fallback notice — the user's selected model was swapped after
       a transient failure, so the reply came from a different model. Shows
       the full cascade chain so the user sees every hop. -->
  {#if msg.modelFallback && msg.modelFallback.length > 0}
    <div class="mb-2 p-2 rounded border border-[rgba(255,184,108,0.35)] bg-[rgba(255,184,108,0.07)] flex items-start gap-2 text-[var(--color-warning)] text-[0.6875rem] font-mono">
      <IconAlertTriangle size={13} class="flex-shrink-0 mt-0.5" />
      <div class="break-words space-y-0.5">
        <div>
          Model fell back: {msg.modelFallback[0].from} → {msg.modelFallback[msg.modelFallback.length - 1].to}
        </div>
        {#if msg.modelFallback.length > 1}
          <div class="opacity-70 text-[0.625rem]">
            {#each msg.modelFallback as hop, i}
              <span>{i > 0 ? ' → ' : ''}{hop.to}</span>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Content -->
  {#if msg.content}
    <div class="text-[0.8125rem] whitespace-pre-wrap break-words leading-relaxed font-mono opacity-95">
      {msg.content}
    </div>
  {/if}

  <!-- Tool calls -->
  {#if msg.toolCalls && msg.toolCalls.length > 0}
    <div class="mt-2.5 space-y-2">
      {#each msg.toolCalls as tc (tc.id)}
        <ToolCallCard toolCall={tc} />
      {/each}
    </div>
  {/if}

  <!-- Stream / System Error — always terminal, so it renders last -->
  {#if msg.error}
    <div class="mt-2 p-2.5 rounded border border-[rgba(255,85,85,0.4)] bg-[rgba(255,85,85,0.08)] flex items-start gap-2 text-[var(--color-error)] text-xs font-mono">
      <IconAlertTriangle size={15} class="flex-shrink-0 mt-0.5" />
      <span class="break-words">{msg.error}</span>
    </div>
  {/if}

  <!-- All free models unavailable — offer a paid fallback -->
  {#if msg.freeModelsExhausted}
    <div class="mt-2 p-2.5 rounded border border-[rgba(255,184,108,0.4)] bg-[rgba(255,184,108,0.08)] text-xs font-mono">
      <div class="flex items-start gap-2 text-[var(--color-warning)] mb-2">
        <IconAlertTriangle size={15} class="flex-shrink-0 mt-0.5" />
        <span class="break-words">
          Every free model tried is currently unavailable ({msg.freeModelsExhausted.triedModels.join(", ")}).
        </span>
      </div>
      <div class="flex gap-2">
        <button class="approval-btn approve flex-1 justify-center" onclick={onTryPaidModel}>
          <IconCreditCard size={14} /> Try Paid Model
        </button>
        <button class="approval-btn deny flex-1 justify-center" onclick={onDismissExhausted}>
          <IconX size={14} /> Dismiss
        </button>
      </div>
    </div>
  {/if}

  <!-- Per-task cost/token footer -->
  {#if msg.taskSummary}
    <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.625rem] font-mono text-[var(--color-muted)] opacity-80 border-t border-[rgba(var(--border-rgb),0.25)] pt-1.5">
      <span class="task-footer-status status-{msg.taskSummary.status}">
        {msg.taskSummary.status}
      </span>
      <span>{msg.taskSummary.requestCount} reqs</span>
      <span class="opacity-40">·</span>
      <span>{fmtTokens(msg.taskSummary.inputTokens + msg.taskSummary.outputTokens)} tokens</span>
      {#if msg.taskSummary.cacheHits > 0}
        <span class="opacity-40">·</span>
        <span>{msg.taskSummary.cacheHits} cached</span>
      {/if}
      <span class="opacity-40">·</span>
      <span>{fmtCost(msg.taskSummary.cost)}</span>
      <span class="opacity-40">·</span>
      <span>{fmtDuration(msg.taskSummary.durationMs)}</span>
    </div>
  {/if}
</div>

<style>
  .task-footer-status {
    text-transform: uppercase;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 0 0.3rem;
    border-radius: 3px;
    font-size: 0.5625rem;
  }
  .task-footer-status.status-success {
    color: var(--color-success, #4ade80);
    background: rgba(74, 222, 128, 0.12);
  }
  .task-footer-status.status-error {
    color: var(--color-error, #f87171);
    background: rgba(248, 113, 113, 0.12);
  }
  .task-footer-status.status-cancelled {
    color: var(--color-warning, #fbbf24);
    background: rgba(251, 191, 36, 0.12);
  }
</style>
