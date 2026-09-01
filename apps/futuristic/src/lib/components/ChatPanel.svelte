<script lang="ts">
  import { chatStore, workspaceStore, type ModelInfo, type ChatMessageEntry } from "@adaan/core";
  import { onMount } from "svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import ToolCallCard from "./ToolCallCard.svelte";
  import ApprovalPrompt from "./ApprovalPrompt.svelte";
  import {
    IconSend,
    IconSquare,
    IconRefresh,
    IconSparkles,
    IconBrain,
    IconTerminal2,
    IconFlame,
    IconCpu,
    IconClipboard,
    IconCheck,
  } from "@tabler/icons-svelte";

  let { workspaceRoot, onFileChanged = () => {} } = $props();

  let input = $state("");
  let models = $state<{ free: ModelInfo[]; paid: ModelInfo[] } | null>(null);
  let eventSource: EventSource | null = null;
  let pendingApprovals = $state<Array<{ sessionId: string; toolCallId: string; toolName: string; args: any }>>([]);
  let messagesContainer: HTMLDivElement;
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  const quickPrompts = [
    "Explain project structure",
    "Find bugs or issues",
    "Add test coverage",
  ];

  onMount(async () => {
    await loadModels();
  });

  async function loadModels() {
    try {
      const res = await fetch("/api/models");
      if (res.ok) {
        models = await res.json();
        // Restore the user's last-selected model if it's still available;
        // otherwise fall back to the first free tools-capable model.
        if (models && !chatStore.restoreModel(models)) {
          const free = models.free.find((m) => m.toolsCapable);
          if (free) chatStore.setModel(free);
        }
      }
    } catch {
      // ignore
    }
  }

  function handlePromptChip(text: string) {
    input = text;
    send();
  }

  async function send() {
    if (!input.trim() || chatStore.streaming) return;
    const message = input.trim();
    input = "";
    await sendMessage(message);
  }

  /**
   * Core send path, shared by the console input and the "Try Paid Model"
   * retry flow so both go through the same session/SSE wiring.
   */
  async function sendMessage(message: string) {
    if (chatStore.streaming) return;
    // A new turn supersedes any tool approval left over from a previous,
    // now-abandoned turn — the backend auto-denies those (see
    // AgentSession.resume()), so drop the matching UI state too instead of
    // leaving cards stuck showing "pending" forever.
    pendingApprovals = [];
    chatStore.cancelPendingToolCalls();
    chatStore.addUserMessage(message);

    const model = chatStore.selectedModel?.id || undefined;
    const contextLength = chatStore.selectedModel?.contextLength || 4096;

    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceRoot,
        message,
        model,
        contextLength,
        sessionId: chatStore.sessionId,
      }),
    });

    if (!res.ok) {
      chatStore.startAssistantMessage();
      chatStore.finishStreaming();
      return;
    }

    const { sessionId } = await res.json();
    chatStore.setSessionId(sessionId);

    const assistantId = chatStore.startAssistantMessage();

    eventSource?.close();
    eventSource = new EventSource(`/api/sessions/${sessionId}/events`);

    eventSource.onmessage = (e) => {
      const event = JSON.parse(e.data);
      chatStore.handleEvent(assistantId, event);

      if (event.type === "tool.approval_required") {
        pendingApprovals.push({
          sessionId,
          toolCallId: event.data.toolCallId,
          toolName: event.data.toolName,
          args: event.data.args,
        });
        pendingApprovals = [...pendingApprovals];
      }

      // When the agent patches or writes a file, bring it forward in the
      // editor and flash the changed lines so the user sees what happened.
      if (event.type === "tool.result" && event.data?.toolName) {
        const toolName = event.data.toolName as string;
        if (toolName === "apply_patch" || toolName === "write_file") {
          handleAgentFileChange(event.data);
        }
        // Any file-modifying tool should refresh the file browser so new
        // files appear and deleted ones disappear.
        if (
          toolName === "apply_patch" ||
          toolName === "write_file" ||
          toolName === "create_file" ||
          toolName === "delete_file"
        ) {
          onFileChanged();
        }
      }

      if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
        eventSource?.close();
        eventSource = null;
      }
    };

    eventSource.onerror = () => {
      eventSource?.close();
      eventSource = null;
      chatStore.finishStreaming();
    };
  }

  async function cancel() {
    if (chatStore.sessionId) {
      await fetch(`/api/sessions/${chatStore.sessionId}/cancel`, { method: "POST" });
      eventSource?.close();
      eventSource = null;
      chatStore.finishStreaming();
    }
  }

  /**
   * When the agent modifies a file via apply_patch or write_file, reload it
   * from disk, bring it forward in the editor, flash the changed lines, and
   * record a pending add/modify/remove diff so the user can review it and
   * Accept or Reject the change.
   */
  async function handleAgentFileChange(eventData: { toolName: string; result?: unknown; toolCallId: string }) {
    // The tool result doesn't include the file path directly — we need to
    // look it up from the chat message's tool call args.
    const msg = chatStore.messages.find((m) => m.id === chatStore.messages[chatStore.messages.length - 1]?.id);
    const tc = msg?.toolCalls?.find((t) => t.id === eventData.toolCallId);
    const filePath = tc?.args?.path as string | undefined;
    if (!filePath || !workspaceRoot) return;

    // apply_patch / write_file now return the pre-edit content (see
    // workspace.ts) — that's the authoritative "before" version for the
    // diff, independent of whether the file happened to already be open.
    const toolResult = eventData.result as { previousContent?: string; hash?: string } | undefined;

    try {
      const res = await fetch(`/api/files/read?root=${encodeURIComponent(workspaceRoot)}&path=${encodeURIComponent(filePath)}`);
      if (!res.ok) return;
      const data = await res.json();

      // Compute changed lines by diffing old content (if tab open) vs new
      let changedLines: number[] = [];
      const existingTab = workspaceStore.openTabs.find((t) => t.path === filePath);
      const beforeContent = toolResult?.previousContent ?? existingTab?.content;
      // Capture the pre-write hash BEFORE we overwrite the tab below —
      // reused for recordFileChange's metadata.
      const beforeHash = workspaceStore.pendingChanges[filePath]?.beforeHash ?? existingTab?.hash ?? "";
      if (beforeContent !== undefined) {
        changedLines = diffLines(beforeContent, data.content);
      }

      // Update or open the tab with fresh content
      if (existingTab) {
        existingTab.content = data.content;
        existingTab.hash = data.hash;
        existingTab.dirty = false;
      } else {
        workspaceStore.openFile(filePath, data.content, data.hash);
      }
      workspaceStore.activeTabPath = filePath;

      // Signal the editor to flash changed lines
      workspaceStore.signalPatch(filePath, changedLines.length > 0 ? changedLines : allLines(data.content));

      // Record the pending change (add/modify/remove diff) for the review
      // toolbar — this persists until the user Accepts or Rejects it, unlike
      // the transient flash above. `create_file` has no previous content, so
      // there's nothing to review/revert.
      if (beforeContent !== undefined) {
        workspaceStore.recordFileChange(filePath, beforeContent, beforeHash, data.content, data.hash);
      }
    } catch {
      // file may have been deleted — ignore
    }
  }

  /** Simple line-level diff: returns 1-indexed line numbers that differ. */
  function diffLines(oldContent: string, newContent: string): number[] {
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const changed: number[] = [];
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (oldLines[i] !== newLines[i]) {
        changed.push(i + 1);
      }
    }
    return changed;
  }

  /** Returns all line numbers (1-indexed) — used when we don't have old content. */
  function allLines(content: string): number[] {
    const lines = content.split("\n");
    return lines.map((_, i) => i + 1);
  }

  async function approve(toolCallId: string, approved: boolean) {
    if (chatStore.sessionId) {
      await fetch(`/api/sessions/${chatStore.sessionId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolCallId, approved }),
      });
    }
    pendingApprovals = pendingApprovals.filter((p) => p.toolCallId !== toolCallId);
  }

  function clearChat() {
    chatStore.clear();
    pendingApprovals = [];
  }

  /**
   * Refresh the live model catalog and switch to the first tools-capable
   * paid model, then re-issue the request that failed. Called when every
   * free model we tried for a turn turned out to be unavailable.
   */
  async function tryPaidModel(msg: ChatMessageEntry) {
    await loadModels();
    if (!models || models.paid.length === 0) return;

    const paidModel = models.paid.find((m) => m.toolsCapable) ?? models.paid[0];
    chatStore.setModel(paidModel);

    // Find the user message that started the failed turn so we can retry it.
    const idx = chatStore.messages.findIndex((m) => m.id === msg.id);
    const userMsg = chatStore.messages
      .slice(0, idx)
      .reverse()
      .find((m) => m.role === "user");

    msg.freeModelsExhausted = undefined;
    if (userMsg) {
      await sendMessage(userMsg.content);
    }
  }

  function dismissExhausted(msg: ChatMessageEntry) {
    msg.freeModelsExhausted = undefined;
  }

  async function copyTranscript() {
    if (chatStore.messages.length === 0) return;
    const text = chatStore.toTranscript();
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 2000);
    } catch {
      // clipboard may be unavailable (e.g. non-secure context) — ignore
    }
  }

  $effect(() => {
    const _ = chatStore.messages.length;
    if (messagesContainer) {
      requestAnimationFrame(() => {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      });
    }
  });
</script>

<div class="flex-1 flex flex-col overflow-hidden relative">
  <div class="pane-scan"></div>

  <!-- Pane Header -->
  <div class="pane-header">
    <div class="pane-title">
      <span class="pane-title-bar"></span>
      <span class="kicker-tag">02 //</span>
      <span>Neural Agent</span>
    </div>

    <div class="flex items-center gap-1.5">
      <!-- Live Status Pill -->
      <span class="status-chip text-[0.625rem] py-0.5 px-2 hidden sm:inline-flex">
        {#if chatStore.streaming}
          <span class="dot bg-[var(--color-accent)] shadow-[0_0_8px_var(--color-accent)] animate-ping"></span>
          <span class="text-[var(--color-accent)]">Streaming</span>
        {:else}
          <span class="dot"></span>
          <span>Ready</span>
        {/if}
      </span>

      <button
        class="icon-btn"
        style="width:1.6rem;height:1.6rem;"
        onclick={copyTranscript}
        disabled={chatStore.messages.length === 0}
        title="Copy transcript to clipboard"
        aria-label="Copy transcript"
      >
        {#if copied}
          <IconCheck size={13} class="text-[var(--color-success)]" />
        {:else}
          <IconClipboard size={13} />
        {/if}
      </button>

      <button
        class="icon-btn"
        style="width:1.6rem;height:1.6rem;"
        onclick={clearChat}
        title="Reset conversation"
        aria-label="Clear chat"
      >
        <IconRefresh size={13} />
      </button>
    </div>
  </div>

  <!-- Model Selector -->
  {#if models}
    <ModelPicker {models} />
  {/if}

  <!-- Messages List -->
  <div class="flex-1 overflow-y-auto px-3 py-3 space-y-3" bind:this={messagesContainer}>
    {#if chatStore.messages.length === 0}
      <div class="editor-empty" style="height: auto; padding: 2.5rem 0.5rem;">
        <div class="reticle-ring" style="width:70px;height:70px;">
          <IconBrain size={28} class="editor-empty-glyph" />
        </div>
        <div class="space-y-1">
          <div class="hero-title text-base font-bold">Neural Coding Assistant</div>
          <div class="editor-empty-hint text-xs">⟨ Ready for Autonomous Tool Execution ⟩</div>
        </div>

        <!-- Quick Prompt Suggestion Pills -->
        <div class="flex flex-col gap-1.5 mt-2 w-full max-w-xs">
          {#each quickPrompts as qp}
            <button
              class="prompt-chip justify-center"
              onclick={() => handlePromptChip(qp)}
            >
              <IconSparkles size={12} class="text-[var(--color-accent)]" />
              <span>{qp}</span>
            </button>
          {/each}
        </div>
      </div>
    {:else}
      {#each chatStore.messages as msg (msg.id)}
        <ChatMessage
          {msg}
          onTryPaidModel={() => tryPaidModel(msg)}
          onDismissExhausted={() => dismissExhausted(msg)}
        />
      {/each}
    {/if}

    <!-- Pending Approvals -->
    {#each pendingApprovals as approval (approval.toolCallId)}
      <ApprovalPrompt
        toolName={approval.toolName}
        args={approval.args}
        on:approve={(e) => approve(approval.toolCallId, e.detail)}
      />
    {/each}
  </div>

  <!-- Command Console Input Area -->
  <div class="p-2.5 border-t border-[var(--color-border)] bg-[rgba(var(--bg-deep-rgb),0.6)]">
    <div class="chat-console-box p-1.5">
      <div class="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-[0.625rem] font-bold tracking-wider text-[var(--color-muted)] uppercase select-none opacity-75">
        <IconTerminal2 size={12} class="text-[var(--color-accent)]" />
        <span>Prompt Console</span>
        {#if chatStore.streaming}
          <span class="ml-auto text-[var(--color-accent)] animate-pulse">Computing...</span>
        {/if}
      </div>

      <div class="flex gap-2 items-end mt-1">
        <textarea
          bind:value={input}
          placeholder="Instruct the neural agent..."
          class="chat-input flex-1"
          rows="2"
          onkeydown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        ></textarea>

        {#if chatStore.streaming}
          <button class="chat-send cancel" onclick={cancel} title="Halt generation" aria-label="Cancel">
            <IconSquare size={15} />
          </button>
        {:else}
          <button class="chat-send" onclick={send} disabled={!input.trim()} title="Send command" aria-label="Send">
            <IconSend size={15} />
          </button>
        {/if}
      </div>
    </div>

    <div class="flex justify-between items-center px-1.5 pt-1.5 text-[0.625rem] text-[var(--color-muted)] opacity-60">
      <span>ENTER to send</span>
      <span>SHIFT+ENTER for new line</span>
    </div>
  </div>
</div>
