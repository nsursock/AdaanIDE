<script lang="ts">
  import { chatStore, workspaceStore, settingsStore, type ModelInfo, type LocalModelInfo, type ChatMessageEntry } from "@adaan/core";
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
    IconBolt,
    IconClockPause,
  } from "@tabler/icons-svelte";

  let { workspaceRoot, onFileChanged = () => {} } = $props();

  let input = $state("");
  let models = $state<{ free: ModelInfo[]; paid: ModelInfo[]; local: LocalModelInfo[] } | null>(null);
  let servingLocal = $state(false);
  let serveError = $state<string | null>(null);
  let eventSource: EventSource | null = null;
  let pendingApprovals = $state<Array<{ sessionId: string; toolCallId: string; toolName: string; args: any }>>([]);
  let messagesContainer: HTMLDivElement;
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  // Stick-to-bottom: auto-scroll only when the user is already near the
  // bottom of the chat. If they scrolled up to read something, we don't
  // yank them back down on every incoming token. Reset to true when the
  // user sends a new message (so their message + the reply stay visible).
  let stickToBottom = $state(true);

  function onMessagesScroll() {
    if (!messagesContainer) return;
    const distFromBottom =
      messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
    stickToBottom = distFromBottom < 80;
  }

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
        // Ensure local array exists even if the server didn't send one
        if (models && !models.local) models.local = [];
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

  /** Build the local-server ref sent with every chat request when a local
   *  model is selected, so the backend can ensure the server is up before
   *  the turn runs. Returns undefined for cloud models. */
  function localRef(model: ModelInfo | null): { providerId: string; modelId: string; hfRepo?: string; singleModel: boolean } | undefined {
    const lm = model as LocalModelInfo | null;
    if (!lm || typeof lm.providerId !== "string") return undefined;
    return {
      providerId: lm.providerId,
      modelId: lm.id,
      hfRepo: lm.hfRepo,
      singleModel: settingsStore.settings.singleLocalModel,
    };
  }

  /**
   * Select a non-local (OpenRouter) model. The provider routes based on
   * the model name — OpenRouter models go to openrouter.ai, local models
   * go to the local endpoint. No endpoint reset needed.
   */
  function selectModel(model: ModelInfo) {
    chatStore.setModel(model);
  }

  /**
   * Select a local model: start the provider's server (if not already
   * running), configure the provider to route this model to the local
   * endpoint, then set the model as active. Shows a serving indicator
   * while the server starts up. Sending is blocked until this completes,
   * and the session endpoint re-verifies the server is up before every
   * turn — so a message can never reach a dead endpoint.
   */
  async function selectLocalModel(model: LocalModelInfo) {
    serveError = null;
    servingLocal = true;
    try {
      const res = await fetch("/api/local/serve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: model.providerId,
          modelId: model.id,
          hfRepo: model.hfRepo,
          singleModel: settingsStore.settings.singleLocalModel,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        serveError = data.error ?? "Failed to start local server";
        servingLocal = false;
        return;
      }
      // Keep the discovery id on the model — the session endpoint resolves
      // the server-side wire name (which may differ, e.g. an HF repo) via
      // the localModel ref sent with every request. Persisting the stable
      // discovery id also makes the selection survive reloads.
      chatStore.setModel(model);
      // Refresh the model list so running badges reflect the new state
      // (the old server was stopped, the new one is running).
      await loadModels();
    } catch (e) {
      serveError = e instanceof Error ? e.message : "Network error";
    } finally {
      servingLocal = false;
    }
  }

  function handlePromptChip(text: string) {
    input = text;
    send();
  }

  async function send() {
    if (!input.trim()) return;
    if (chatStore.streaming) return;
    if (servingLocal) return; // never send before the local server is up
    const message = input.trim();
    input = "";
    await sendMessage(message);
  }

  /**
   * Interrupt the current turn and send a new message immediately.
   * The backend aborts the in-flight generator and starts a fresh one.
   */
  async function sendInterrupt() {
    if (!input.trim()) return;
    if (servingLocal) return; // never send before the local server is up
    const message = input.trim();
    input = "";

    // Close the current SSE stream — the new turn will open a fresh one.
    eventSource?.close();
    eventSource = null;
    pendingApprovals = [];
    chatStore.cancelPendingToolCalls();
    chatStore.finishStreaming();

    await sendMessage(message);
  }

  /**
   * Queue a message to be sent after the current turn finishes.
   * The backend stores it and processes it when the current generator
   * completes.
   */
  async function sendQueue() {
    if (!input.trim() || !chatStore.streaming) return;
    if (servingLocal) return; // never send before the local server is up
    const message = input.trim();
    input = "";

    const selected = chatStore.selectedModel;
    const local = localRef(selected);
    const model = selected?.id || undefined;
    const contextLength = selected?.contextLength || 4096;
    // An explicit local pick always wins over auto-routing (the router only
    // knows cloud models). Otherwise honor the routing mode.
    const effectiveModel = settingsStore.settings.routingMode === "auto" && !local ? "auto" : model;

    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceRoot,
        message,
        model: effectiveModel,
        contextLength,
        sessionId: chatStore.sessionId,
        routingMode: settingsStore.settings.routingMode,
        routingThreshold: settingsStore.settings.routingThreshold,
        routingTiers: settingsStore.settings.routingTiers,
        explorationPaidEnabled: settingsStore.settings.explorationPaidEnabled,
        localModel: local,
        interrupt: false,
      }),
    });

    // Show the queued message in the UI immediately so the user knows
    // it's waiting. The actual assistant response will appear when the
    // current turn finishes and the queued one starts.
    chatStore.addUserMessage(message);
  }

  /**
   * Core send path, shared by the console input and the "Try Paid Model"
   * retry flow so both go through the same session/SSE wiring.
   */
  async function sendMessage(message: string) {
    if (chatStore.streaming) return;
    // The user just sent a message — force the chat to scroll to the bottom
    // so their message and the incoming reply are visible, even if they had
    // scrolled up to read earlier history.
    stickToBottom = true;
    // A new turn supersedes any tool approval left over from a previous,
    // now-abandoned turn — the backend auto-denies those (see
    // AgentSession.resume()), so drop the matching UI state too instead of
    // leaving cards stuck showing "pending" forever.
    pendingApprovals = [];
    chatStore.cancelPendingToolCalls();
    chatStore.addUserMessage(message);

    const selected = chatStore.selectedModel;
    const local = localRef(selected);
    const model = selected?.id || undefined;
    const contextLength = selected?.contextLength || 4096;

    // Phase 3: when routing mode is "auto", send "auto" as the model so the
    // engine's router picks the cheapest model likely to succeed. An
    // explicit local-model pick always wins — the router only knows about
    // cloud models and would silently drop the local selection.
    const effectiveModel = settingsStore.settings.routingMode === "auto" && !local ? "auto" : model;

    // If a local model is selected and we don't know it's running, show the
    // serving indicator while the backend ensures the server is up. The
    // session endpoint blocks until the server is ready, so no request can
    // go out before that.
    if (local && !(selected as LocalModelInfo).running) servingLocal = true;
    let res: Response;
    try {
      res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceRoot,
          message,
          model: effectiveModel,
          contextLength,
          sessionId: chatStore.sessionId,
          routingMode: settingsStore.settings.routingMode,
          routingThreshold: settingsStore.settings.routingThreshold,
          routingTiers: settingsStore.settings.routingTiers,
          explorationPaidEnabled: settingsStore.settings.explorationPaidEnabled,
          localModel: local,
          interrupt: true,
        }),
      });
    } finally {
      servingLocal = false;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const id = chatStore.startAssistantMessage();
      chatStore.setAssistantError(
        id,
        data.error ?? "Failed to start the session. If a local model is selected, its server may have failed to start.",
      );
      chatStore.finishStreaming();
      return;
    }

    const { sessionId } = await res.json();
    chatStore.setSessionId(sessionId);

    const assistantId = chatStore.startAssistantMessage();

    eventSource?.close();
    eventSource = new EventSource(`/api/sessions/${sessionId}/events`);

    // Track whether we received a terminal event so onerror can
    // distinguish a clean close from a mid-stream disconnect.
    let streamTerminated = false;

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
        streamTerminated = true;
        eventSource?.close();
        eventSource = null;
      }
    };

    eventSource.onerror = () => {
      eventSource?.close();
      eventSource = null;
      // If we never received a terminal event, the connection was lost
      // mid-stream (server crash, network drop, or stalled request that
      // the hard-deadline killed). Show an error instead of leaving a
      // silent empty bubble with "Streaming" stuck on.
      if (!streamTerminated && chatStore.streaming) {
        chatStore.setAssistantError(
          assistantId,
          "Connection lost — the request stalled or the server dropped the stream. Try sending your message again.",
        );
      }
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
    await selectModel(paidModel);

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

  // Auto-scroll to the latest content as it streams in. Reads deep into
  // each message (content, reasoning, toolCalls, timeline) so Svelte's
  // reactivity fires on every token/tool-call/reasoning delta, not just
  // when a new message is added. Respects `stickToBottom` so a user who
  // scrolled up to read isn't pulled back down.
  $effect(() => {
    // Touch every reactive property that should trigger auto-scroll.
    for (const m of chatStore.messages) {
      void m.content;
      void m.reasoning;
      void m.toolCalls?.length;
      void m.timeline?.length;
      void m.status?.message;
    }
    if (messagesContainer && stickToBottom) {
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
      <span class="status-chip text-[0.6875rem] py-0.5 px-2 hidden sm:inline-flex">
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
    <ModelPicker {models} onSelectLocal={selectLocalModel} onSelect={selectModel} />
  {/if}
  {#if servingLocal}
    <div class="px-3 py-1.5 text-[0.6875rem] text-[var(--color-accent)] flex items-center gap-1.5 border-b border-[var(--color-border)] bg-[rgba(var(--accent-rgb),0.06)]">
      <span class="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse"></span>
      Starting local server…
    </div>
  {/if}
  {#if serveError}
    <div class="px-3 py-1.5 text-[0.6875rem] text-[var(--color-error)] border-b border-[var(--color-border)]">
      {serveError}
    </div>
  {/if}

  <!-- Messages List -->
  <div class="flex-1 overflow-y-auto px-3 py-3 space-y-3" bind:this={messagesContainer} onscroll={onMessagesScroll}>
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
      <div class="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-[0.6875rem] font-bold tracking-wider text-[var(--color-muted)] uppercase select-none opacity-75">
        <IconTerminal2 size={12} class="text-[var(--color-accent)]" />
        <span>Prompt Console</span>
        {#if chatStore.streaming}
          <span class="ml-auto text-[var(--color-accent)] animate-pulse">Computing...</span>
        {/if}
      </div>

      <div class="flex gap-2 items-end mt-1">
        <textarea
          bind:value={input}
          placeholder={chatStore.streaming ? "Type to interrupt or queue..." : "Instruct the neural agent..."}
          class="chat-input flex-1"
          rows="2"
          onkeydown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (chatStore.streaming) {
                sendInterrupt();
              } else {
                send();
              }
            }
          }}
        ></textarea>

        {#if chatStore.streaming}
          <div class="flex flex-col gap-1">
            {#if input.trim()}
              <button class="chat-send interrupt" onclick={sendInterrupt} title="Interrupt & send now" aria-label="Interrupt and send">
                <IconBolt size={15} />
              </button>
              <button class="chat-send queue" onclick={sendQueue} title="Queue for after current turn" aria-label="Queue message">
                <IconClockPause size={15} />
              </button>
            {:else}
              <button class="chat-send cancel" onclick={cancel} title="Halt generation" aria-label="Cancel">
                <IconSquare size={15} />
              </button>
            {/if}
          </div>
        {:else}
          <button class="chat-send" onclick={send} disabled={!input.trim() || servingLocal} title={servingLocal ? "Waiting for the local server to start" : "Send command"} aria-label="Send">
            <IconSend size={15} />
          </button>
        {/if}
      </div>
    </div>

    <div class="flex justify-between items-center px-1.5 pt-1.5 text-[0.6875rem] text-[var(--color-muted)] opacity-60">
      {#if chatStore.streaming}
        <span>ENTER to interrupt</span>
        <span>SHIFT+ENTER for new line</span>
      {:else}
        <span>ENTER to send</span>
        <span>SHIFT+ENTER for new line</span>
      {/if}
    </div>
  </div>
</div>
