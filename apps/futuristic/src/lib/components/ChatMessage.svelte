<script lang="ts">
  import type { ChatMessageEntry } from "@adaan/core";
  import ToolCallCard from "./ToolCallCard.svelte";
  import { IconUser, IconBrain, IconCpu, IconSparkles } from "@tabler/icons-svelte";

  let { msg } = $props<{ msg: ChatMessageEntry }>();
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
</div>
