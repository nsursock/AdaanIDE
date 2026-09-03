<script lang="ts">
  import { projectsStore } from "@adaan/core";
  import { createEventDispatcher } from "svelte";
  import { IconPlus, IconX } from "@tabler/icons-svelte";

  const dispatch = createEventDispatcher();

  let activeProject = $derived(projectsStore.active);
  let chats = $derived(activeProject?.chats ?? []);
  let activeChatId = $derived(activeProject?.activeChatId ?? null);

  function switchChat(chatId: string) {
    if (!activeProject) return;
    projectsStore.switchChat(activeProject.id, chatId);
  }

  function newChat() {
    if (!activeProject) return;
    projectsStore.createChat(activeProject.id);
    dispatch("newchat");
  }

  async function closeChat(chatId: string, e: MouseEvent) {
    e.stopPropagation();
    if (!activeProject) return;
    const result = projectsStore.closeChat(activeProject.id, chatId);
    if (result?.sessionId) {
      try {
        await fetch(`/api/sessions/${result.sessionId}`, { method: "DELETE" });
      } catch {
        // best-effort
      }
    }
  }
</script>

{#if activeProject && chats.length > 0}
  <div class="chat-tabs-bar">
    <div class="chat-tabs-scroll">
      {#each chats as chat (chat.id)}
        <button
          class="chat-tab {chat.id === activeChatId ? 'active' : ''}"
          onclick={() => switchChat(chat.id)}
          title={chat.title}
        >
          <span class="chat-tab-title truncate">{chat.title}</span>
          {#if chat.streaming}
            <span class="chat-tab-streaming" title="Agent running"></span>
          {/if}
          <span
            class="chat-tab-close"
            role="button"
            tabindex="-1"
            aria-label="Close chat"
            onclick={(e) => closeChat(chat.id, e)}
            onkeydown={(e) => { if (e.key === "Enter") closeChat(chat.id, e as unknown as MouseEvent); }}
          >
            <IconX size={11} />
          </span>
        </button>
      {/each}
    </div>
    <button class="chat-tab-new" onclick={newChat} title="New chat" aria-label="New chat">
      <IconPlus size={13} />
    </button>
  </div>
{/if}

<style>
  .chat-tabs-bar {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    background: rgba(var(--bg-deep-rgb), 0.4);
    flex-shrink: 0;
  }
  .chat-tabs-scroll {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    overflow-x: auto;
    scrollbar-width: thin;
    flex: 1;
    min-width: 0;
  }
  .chat-tabs-scroll::-webkit-scrollbar {
    height: 3px;
  }
  .chat-tabs-scroll::-webkit-scrollbar-thumb {
    background: var(--color-border);
    border-radius: 999px;
  }
  .chat-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.5rem;
    border-radius: 5px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--color-muted);
    font-size: 0.6875rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
    max-width: 10rem;
    flex-shrink: 0;
  }
  .chat-tab:hover {
    background: rgba(var(--accent-rgb), 0.06);
    border-color: rgba(var(--accent-rgb), 0.15);
    color: var(--color-text);
  }
  .chat-tab.active {
    background: rgba(var(--accent-rgb), 0.12);
    border-color: rgba(var(--accent-rgb), 0.35);
    color: var(--color-accent);
  }
  .chat-tab-title {
    max-width: 7rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chat-tab-streaming {
    display: inline-block;
    width: 5px;
    height: 5px;
    border-radius: 999px;
    background: var(--color-accent);
    box-shadow: 0 0 6px var(--color-accent);
    animation: chat-tab-pulse 1.5s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes chat-tab-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .chat-tab-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    border-radius: 3px;
    color: var(--color-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    opacity: 0;
    transition: all 0.15s;
    flex-shrink: 0;
  }
  .chat-tab:hover .chat-tab-close,
  .chat-tab.active .chat-tab-close {
    opacity: 0.5;
  }
  .chat-tab-close:hover {
    opacity: 1 !important;
    color: var(--color-error);
    background: rgba(var(--error-rgb, 255, 60, 60), 0.12);
  }
  .chat-tab-new {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 5px;
    border: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-muted);
    cursor: pointer;
    transition: all 0.15s;
    flex-shrink: 0;
  }
  .chat-tab-new:hover {
    border-color: var(--color-accent);
    color: var(--color-accent);
    background: rgba(var(--accent-rgb), 0.08);
  }
</style>
