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
</div>
