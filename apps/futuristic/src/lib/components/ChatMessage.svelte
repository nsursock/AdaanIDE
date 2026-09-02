<script lang="ts">
  import type { ChatMessageEntry, TimelineSegment } from "@adaan/core";
  import ToolCallCard from "./ToolCallCard.svelte";
  import { IconUser, IconBrain, IconCpu, IconSparkles, IconAlertTriangle, IconCreditCard, IconX, IconRoute, IconArrowUp, IconChevronDown, IconChevronRight, IconBulb } from "@tabler/icons-svelte";

  let {
    msg,
    onTryPaidModel = () => {},
    onDismissExhausted = () => {},
  } = $props<{
    msg: ChatMessageEntry;
    onTryPaidModel?: () => void;
    onDismissExhausted?: () => void;
  }>();

  // Per-segment collapse state for reasoning blocks in the timeline. Each
  // reasoning segment is independently collapsible; defaults to expanded
  // (so the user sees live thoughts during streaming). Keyed by timeline
  // index so each block tracks its own state.
  let collapsedReasoning = $state<Set<number>>(new Set());

  function toggleReasoning(idx: number) {
    const next = new Set(collapsedReasoning);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    collapsedReasoning = next;
  }

  // Look up a tool call by ID from the flat toolCalls array — the timeline
  // only stores a reference (toolCallId) so the live result/error/pending
  // state on the tool-call object is always current.
  function getToolCall(toolCallId: string) {
    return msg.toolCalls?.find((t) => t.id === toolCallId);
  }

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
  {#if msg.routedTo}
    <div class="mb-2 flex items-center gap-1.5 text-[0.6875rem] font-mono text-[var(--color-accent)] opacity-80">
      <IconRoute size={11} class="flex-shrink-0" />
      <span>auto → {msg.routedTo.model.split("/").pop()} · {msg.routedTo.category}</span>
    </div>
  {/if}
  {#if msg.modelEscalations && msg.modelEscalations.length > 0}
    <div class="mb-2 flex items-center gap-1.5 text-[0.6875rem] font-mono text-[var(--color-warning)] opacity-80">
      <IconArrowUp size={11} class="flex-shrink-0" />
      {#each msg.modelEscalations as esc, i}
        <span>{i > 0 ? " · " : ""}{esc.from.split("/").pop()} → {esc.to.split("/").pop()}</span>
      {/each}
    </div>
  {/if}

  {#if msg.modelFallback && msg.modelFallback.length > 0}
    <div class="mb-2 p-2 rounded border border-[rgba(255,184,108,0.35)] bg-[rgba(255,184,108,0.07)] flex items-start gap-2 text-[var(--color-warning)] text-[0.6875rem] font-mono">
      <IconAlertTriangle size={13} class="flex-shrink-0 mt-0.5" />
      <div class="break-words space-y-0.5">
        <div>
          Model fell back: {msg.modelFallback[0].from} → {msg.modelFallback[msg.modelFallback.length - 1].to}
        </div>
        {#if msg.modelFallback.length > 1}
          <div class="opacity-70 text-[0.6875rem]">
            {#each msg.modelFallback as hop, i}
              <span>{i > 0 ? ' → ' : ''}{hop.to}</span>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Chronological timeline — renders the real interleaved sequence of the
       agent loop: thinking → commands → thinking → commands → feedback → …
       Each reasoning segment is its own collapsible block; each tool call is
       its own card; content segments are the final-answer text. Falls back
       to flat content for user messages (no timeline). -->
  {#if msg.timeline && msg.timeline.length > 0}
    {#each msg.timeline as seg, idx (idx)}
      {#if seg.type === "reasoning"}
        <div class="reasoning-block mb-2">
          <button
            type="button"
            class="reasoning-header"
            onclick={() => toggleReasoning(idx)}
            aria-expanded={!collapsedReasoning.has(idx)}
            aria-label="Toggle reasoning"
          >
            {#if !collapsedReasoning.has(idx)}
              <IconChevronDown size={11} class="flex-shrink-0" />
            {:else}
              <IconChevronRight size={11} class="flex-shrink-0" />
            {/if}
            <IconBulb size={11} class="flex-shrink-0" />
            <span>Reasoning</span>
          </button>
          {#if !collapsedReasoning.has(idx)}
            <div class="reasoning-body">
              {seg.text}
            </div>
          {/if}
        </div>
      {:else if seg.type === "tool"}
        {@const tc = getToolCall(seg.toolCallId)}
        {#if tc}
          <div class="mt-2.5">
            <ToolCallCard toolCall={tc} />
          </div>
        {/if}
      {:else if seg.type === "content" && seg.text}
        <div class="text-[0.8125rem] whitespace-pre-wrap break-words leading-relaxed font-mono opacity-95 mt-2">
          {seg.text}
        </div>
      {/if}
    {/each}
  {:else if msg.content}
    <!-- Fallback for messages without a timeline (user messages, legacy) -->
    <div class="text-[0.8125rem] whitespace-pre-wrap break-words leading-relaxed font-mono opacity-95">
      {msg.content}
    </div>
  {/if}

  <!-- Live status line — shown while the provider is silent (no tokens yet)
       so a stalled/queued request doesn't look like a dead empty bubble.
       Cleared on the first real token or when the turn terminates. -->
  {#if msg.status && msg.status.message}
    <div class="mt-1 flex items-center gap-1.5 text-[0.6875rem] font-mono text-[var(--color-accent)] opacity-80">
      <span class="status-pulse-dot"></span>
      <span class="truncate">{msg.status.message}</span>
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
    <div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] font-mono text-[var(--color-muted)] opacity-80 border-t border-[rgba(var(--border-rgb),0.25)] pt-1.5">
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
      {#if (msg.taskSummary.truncationTokensSaved ?? 0) + (msg.taskSummary.compactionTokensSaved ?? 0) > 0}
        <span class="opacity-40">·</span>
        <span>saved {fmtTokens((msg.taskSummary.truncationTokensSaved ?? 0) + (msg.taskSummary.compactionTokensSaved ?? 0))} ctx</span>
      {/if}
      {#if (msg.taskSummary.redundantCallsAvoided ?? 0) > 0}
        <span class="opacity-40">·</span>
        <span>{msg.taskSummary.redundantCallsAvoided} blocked</span>
      {/if}
      {#if (msg.taskSummary.escalations ?? 0) > 0}
        <span class="opacity-40">·</span>
        <span class="text-[var(--color-warning)]">{msg.taskSummary.escalations} escalated</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .reasoning-block {
    border-left: 2px solid var(--color-accent, #38bdf8);
    background: rgba(var(--bg-deep-rgb, 10, 12, 20), 0.45);
    border-radius: 0 6px 6px 0;
    overflow: hidden;
  }
  .reasoning-header {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    width: 100%;
    padding: 0.3rem 0.55rem;
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-accent, #38bdf8);
    opacity: 0.85;
    background: transparent;
    border: none;
    cursor: pointer;
    user-select: none;
  }
  .reasoning-header:hover { opacity: 1; }
  .reasoning-body {
    padding: 0.4rem 0.6rem 0.5rem;
    font-size: 0.6875rem;
    line-height: 1.5;
    font-family: var(--font-mono, monospace);
    color: var(--color-text, #c9d1d9);
    opacity: 0.62;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 320px;
    overflow-y: auto;
  }
  .status-pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 9999px;
    flex-shrink: 0;
    background: var(--color-accent, #38bdf8);
    box-shadow: 0 0 6px var(--color-accent, #38bdf8);
    animation: status-pulse 1.1s ease-in-out infinite;
  }
  @keyframes status-pulse {
    0%, 100% { opacity: 0.35; transform: scale(0.85); }
    50% { opacity: 1; transform: scale(1.15); }
  }
  .task-footer-status {
    text-transform: uppercase;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 0 0.3rem;
    border-radius: 3px;
    font-size: 0.6875rem;
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
