import type { FileNode, ModelInfo, AgentEvent } from "../types.js";
import { workspaceStore, type OpenTab, type PendingFileChange, type PatchSignal } from "./workspace.svelte.js";
import { chatStore, type ChatMessageEntry } from "./chat.svelte.js";
import { applyChatEvent, isTerminalEvent } from "./chat-events.js";

/** A pending tool-approval card for a specific chat's agent turn. */
export interface PendingApproval {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * A single conversation within a project. Each project can have multiple
 * chats (like browser tabs), each with its own:
 *  - message history
 *  - backend agent session id
 *  - selected model (independent model picker per chat)
 *  - streaming state and SSE EventSource
 *  - pending tool-approval queue
 *
 * This enables multi-agent workflows: run one chat with a frontier model
 * for architecture, another with a free model for tests, a third for
 * debugging — all in the same project, all streaming concurrently.
 */
export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessageEntry[];
  backendSessionId: string | null;
  selectedModel: ModelInfo | null;
  streaming: boolean;
  pendingApprovals: PendingApproval[];
}

/**
 * Snapshot of a single open project's UI state. The IDE keeps several
 * projects open at once and lets the user switch between them from the
 * top-bar project switcher. Each project holds one or more `ChatSession`s
 * (chat tabs) that can stream concurrently in the background.
 */
export interface ProjectEntry {
  id: string;
  rootPath: string;
  name: string;
  // --- workspace snapshot (shared across all chats in the project) ---
  tree: FileNode[];
  openTabs: OpenTab[];
  activeTabPath: string | null;
  showHidden: boolean;
  pendingChanges: Record<string, PendingFileChange>;
  patchSignal: PatchSignal | null;
  // --- chats within this project ---
  chats: ChatSession[];
  activeChatId: string | null;
  /** Set when a background agent modified files; the UI reloads the tree
   *  and refreshes open tabs when the user switches back to this project. */
  treeStale: boolean;
}

type WorkspaceSnapshot = Omit<ProjectEntry, "id" | "rootPath" | "name" | "chats" | "activeChatId" | "treeStale">;

/** Callback fired when a file-modifying tool result arrives for the ACTIVE
 *  project + ACTIVE chat. The ChatPanel uses this to bring the file forward,
 *  flash changed lines, and record a pending change for the review toolbar.
 *  Background chats just get `treeStale = true` on their project. */
type FileChangeCallback = (projectRoot: string, eventData: { toolName: string; result?: unknown; toolCallId: string }) => void;
/** Callback fired when a file-modifying tool result arrives for the ACTIVE
 *  project + ACTIVE chat, so the file tree can be refreshed. */
type TreeRefreshCallback = () => void;

function makeChatId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `chat_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function freshChat(title = "New chat"): ChatSession {
  return {
    id: makeChatId(),
    title,
    messages: [],
    backendSessionId: null,
    selectedModel: null,
    streaming: false,
    pendingApprovals: [],
  };
}

class ProjectsStore {
  /** All currently open projects. */
  projects = $state<ProjectEntry[]>([]);
  /** id of the project whose state is currently loaded into the singletons,
   *  or null when the launcher / workspace picker is showing. */
  activeId = $state<string | null>(null);

  /** SSE connections keyed by chat id. Each chat has its own EventSource
   *  so multiple chats can stream concurrently — even within the same
   *  project (multi-agent workflows). */
  private eventSources: Map<string, EventSource> = new Map();

  /** Registered by the ChatPanel to receive file-change side effects for the
   *  active project + active chat (editor flash, tab updates, pending-change
   *  recording). Background chats just set `treeStale` on their project. */
  private fileChangeCallback: FileChangeCallback | null = null;
  /** Registered by +page.svelte to refresh the file tree for the active
   *  project after a file-modifying tool runs. */
  private treeRefreshCallback: TreeRefreshCallback | null = null;

  // --- Reactive getters ----------------------------------------------------

  get active(): ProjectEntry | null {
    if (!this.activeId) return null;
    return this.projects.find((p) => p.id === this.activeId) ?? null;
  }

  get activeRoot(): string | null {
    return this.active?.rootPath ?? null;
  }

  get hasProjects(): boolean {
    return this.projects.length > 0;
  }

  /** The active chat within the active project, or null. */
  get activeChat(): ChatSession | null {
    const p = this.active;
    if (!p?.activeChatId) return null;
    return p.chats.find((c) => c.id === p.activeChatId) ?? null;
  }

  /** id of the active chat within the active project, or null. */
  get activeChatId(): string | null {
    return this.activeChat?.id ?? null;
  }

  /** Pending approval cards for the active chat (reactive). */
  get activePendingApprovals(): PendingApproval[] {
    return this.activeChat?.pendingApprovals ?? [];
  }

  /** True if any chat in the project is currently streaming. */
  isProjectStreaming(project: ProjectEntry): boolean {
    return project.chats.some((c) => c.streaming);
  }

  /** Number of background projects with at least one streaming chat. */
  get backgroundStreamingCount(): number {
    return this.projects.filter((p) => p.id !== this.activeId && this.isProjectStreaming(p)).length;
  }

  // --- Callback registration (called by ChatPanel / +page.svelte) --------

  onFileChange(cb: FileChangeCallback) {
    this.fileChangeCallback = cb;
  }
  onTreeRefresh(cb: TreeRefreshCallback) {
    this.treeRefreshCallback = cb;
  }

  // --- Internal helpers ----------------------------------------------------

  /** Find a chat by id across all projects. */
  private findChat(chatId: string): { project: ProjectEntry; chat: ChatSession } | null {
    for (const p of this.projects) {
      const chat = p.chats.find((c) => c.id === chatId);
      if (chat) return { project: p, chat };
    }
    return null;
  }

  /** Read the live workspace singleton state into a snapshot. */
  private wsSnapshot(): WorkspaceSnapshot {
    return {
      tree: workspaceStore.tree,
      openTabs: workspaceStore.openTabs,
      activeTabPath: workspaceStore.activeTabPath,
      showHidden: workspaceStore.showHidden,
      pendingChanges: workspaceStore.pendingChanges,
      patchSignal: workspaceStore.patchSignal,
    };
  }

  private freshWsSnapshot(): WorkspaceSnapshot {
    return {
      tree: [],
      openTabs: [],
      activeTabPath: null,
      showHidden: false,
      pendingChanges: {},
      patchSignal: null,
    };
  }

  /** Flush the active chat's live chatStore state back into its ChatSession. */
  private flushActiveChat() {
    const chat = this.activeChat;
    if (!chat) return;
    chat.messages = chatStore.messages;
    chat.backendSessionId = chatStore.sessionId;
    chat.selectedModel = chatStore.selectedModel;
    // streaming and pendingApprovals are maintained by the event handler.
  }

  /** Restore a chat's state into the singleton chatStore. */
  private restoreChat(chat: ChatSession) {
    chatStore.messages = chat.messages;
    chatStore.sessionId = chat.backendSessionId;
    chatStore.selectedModel = chat.selectedModel;
    chatStore.streaming = chat.streaming;
  }

  /** Write a project's workspace snapshot back into the singleton stores. */
  private restoreWorkspace(entry: ProjectEntry) {
    workspaceStore.setWorkspace({ rootPath: entry.rootPath, name: entry.name });
    workspaceStore.tree = entry.tree;
    workspaceStore.openTabs = entry.openTabs;
    workspaceStore.activeTabPath = entry.activeTabPath;
    workspaceStore.showHidden = entry.showHidden;
    workspaceStore.pendingChanges = entry.pendingChanges;
    workspaceStore.patchSignal = entry.patchSignal;
  }

  /** Flush the active project's workspace state + active chat's chat state
   *  back into their entries. */
  private flushActive() {
    const cur = this.active;
    if (!cur) return;
    const snap = this.wsSnapshot();
    cur.tree = snap.tree;
    cur.openTabs = snap.openTabs;
    cur.activeTabPath = snap.activeTabPath;
    cur.showHidden = snap.showHidden;
    cur.pendingChanges = snap.pendingChanges;
    cur.patchSignal = snap.patchSignal;
    this.flushActiveChat();
  }

  // --- Project lifecycle ---------------------------------------------------

  openProject(rootPath: string, name: string): string {
    const existing = this.projects.find((p) => p.rootPath === rootPath);
    if (existing) {
      this.switchTo(existing.id);
      return existing.id;
    }

    this.flushActive();

    const id = makeChatId().replace("chat_", "proj_");
    const firstChat = freshChat();
    const entry: ProjectEntry = {
      id,
      rootPath,
      name,
      ...this.freshWsSnapshot(),
      chats: [firstChat],
      activeChatId: firstChat.id,
      treeStale: false,
    };
    this.projects = [...this.projects, entry];
    this.activeId = id;

    // Reset singletons for the new project + its first chat.
    workspaceStore.close();
    chatStore.clear();
    workspaceStore.setWorkspace({ rootPath, name });
    this.restoreChat(firstChat);

    return id;
  }

  switchTo(id: string): ProjectEntry | null {
    if (id === this.activeId) return null;
    const target = this.projects.find((p) => p.id === id);
    if (!target) return null;

    this.flushActive();
    this.restoreWorkspace(target);
    const chat = target.chats.find((c) => c.id === target.activeChatId) ?? target.chats[0];
    if (chat) {
      target.activeChatId = chat.id;
      this.restoreChat(chat);
    }
    this.activeId = id;
    return target;
  }

  closeProject(id: string): { sessionIds: string[] } | null {
    const idx = this.projects.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const closed = this.projects[idx];
    const wasActive = this.activeId === id;

    // Stop all chat streams in this project.
    const sessionIds: string[] = [];
    for (const chat of closed.chats) {
      this.stopStream(chat.id);
      if (chat.backendSessionId) sessionIds.push(chat.backendSessionId);
    }

    const remaining = this.projects.filter((p) => p.id !== id);
    this.projects = remaining;

    if (wasActive) {
      const neighbor = remaining[idx] ?? remaining[idx - 1] ?? null;
      if (neighbor) {
        this.restoreWorkspace(neighbor);
        const chat = neighbor.chats.find((c) => c.id === neighbor.activeChatId) ?? neighbor.chats[0];
        if (chat) {
          neighbor.activeChatId = chat.id;
          this.restoreChat(chat);
        }
        this.activeId = neighbor.id;
      } else {
        this.activeId = null;
        workspaceStore.close();
        chatStore.clear();
      }
    }

    return { sessionIds };
  }

  showPicker() {
    this.flushActive();
    this.activeId = null;
  }

  // --- Chat lifecycle (within a project) -----------------------------------

  /**
   * Create a new chat within a project and make it the active chat.
   * Flushes the currently-active chat first. Returns the new chat id.
   */
  createChat(projectId: string): string {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) return "";

    // Flush the currently-active chat.
    if (this.activeId === projectId) this.flushActiveChat();

    const chat = freshChat(`Chat ${project.chats.length + 1}`);
    project.chats = [...project.chats, chat];
    project.activeChatId = chat.id;

    // If this is the active project, load the new chat into chatStore.
    if (this.activeId === projectId) {
      chatStore.clear();
      this.restoreChat(chat);
    }

    return chat.id;
  }

  /**
   * Switch the active chat within a project. Flushes the current chat,
   * restores the target. No-op if the target is already active.
   */
  switchChat(projectId: string, chatId: string) {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (project.activeChatId === chatId) return;
    const target = project.chats.find((c) => c.id === chatId);
    if (!target) return;

    if (this.activeId === projectId) {
      this.flushActiveChat();
      chatStore.clear();
      this.restoreChat(target);
    }
    project.activeChatId = chatId;
  }

  /**
   * Close a chat within a project. Stops its stream and frees the backend
   * session. If it was the active chat, switches to a neighbor; if it was
   * the last chat, creates a new empty one. Returns the backend session id
   * so the caller can delete the server-side session.
   */
  closeChat(projectId: string, chatId: string): { sessionId: string | null } | null {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) return null;
    const idx = project.chats.findIndex((c) => c.id === chatId);
    if (idx === -1) return null;
    const closed = project.chats[idx];
    const wasActive = project.activeChatId === chatId;

    // Stop the stream and collect the backend session id.
    this.stopStream(chatId);
    const sessionId = closed.backendSessionId;

    // Remove the chat.
    project.chats = project.chats.filter((c) => c.id !== chatId);

    // If that was the last chat, create a new empty one.
    if (project.chats.length === 0) {
      const newChat = freshChat("Chat 1");
      project.chats = [newChat];
      project.activeChatId = newChat.id;
      if (this.activeId === projectId) {
        chatStore.clear();
        this.restoreChat(newChat);
      }
      return { sessionId };
    }

    // If the closed chat was active, switch to a neighbor.
    if (wasActive) {
      const neighbor = project.chats[idx] ?? project.chats[idx - 1] ?? project.chats[0];
      project.activeChatId = neighbor.id;
      if (this.activeId === projectId) {
        chatStore.clear();
        this.restoreChat(neighbor);
      }
    }

    return { sessionId };
  }

  /** Update a chat's title (e.g. from the first user message). */
  setChatTitle(chatId: string, title: string) {
    const found = this.findChat(chatId);
    if (!found) return;
    found.chat.title = title;
  }

  // --- Stream management (concurrent, per-chat) ---------------------------

  /**
   * Start an SSE stream for a chat's agent turn. The EventSource is keyed
   * by chat id and persists across project/chat switches — the turn keeps
   * running in the background. Events are routed to the chat's `messages`
   * via `applyChatEvent`; when the chat is active, `chatStore.messages` is
   * the same reference so the UI updates live.
   */
  startStream(chatId: string, sessionId: string, assistantId: string) {
    const found = this.findChat(chatId);
    if (!found) return;
    const { project, chat } = found;

    // Close any existing stream for this chat (e.g. interrupt).
    this.stopStream(chatId);

    chat.backendSessionId = sessionId;
    chat.streaming = true;
    if (this.activeId === project.id && project.activeChatId === chatId) {
      chatStore.setSessionId(sessionId);
      chatStore.streaming = true;
      // CRITICAL: sync chat.messages to chatStore.messages. The user message
      // and assistant message were pushed to chatStore.messages by
      // chatStore.addUserMessage / chatStore.startAssistantMessage. If
      // chat.messages is a different reactive proxy (Svelte 5 may create a
      // separate proxy when assigning between $state fields), chat.messages
      // wouldn't have those messages. This sync ensures both point to the
      // same array so events routed to chatStore.messages find the assistant
      // message, and the chat's history is preserved on switch.
      chat.messages = chatStore.messages;
    }

    const es = new EventSource(`/api/sessions/${sessionId}/events`);
    this.eventSources.set(chatId, es);

    let streamTerminated = false;

    es.onmessage = (e) => {
      const event = JSON.parse(e.data) as AgentEvent;
      this.handleStreamEvent(project, chat, assistantId, event);

      if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
        streamTerminated = true;
        es.close();
        this.eventSources.delete(chatId);
      }
    };

    es.onerror = () => {
      es.close();
      this.eventSources.delete(chatId);
      if (!streamTerminated && chat.streaming) {
        this.handleStreamEvent(project, chat, assistantId, {
          type: "error",
          sessionId,
          data: { message: "Connection lost — the request stalled or the server dropped the stream. Try sending your message again." },
          timestamp: Date.now(),
        } as AgentEvent);
      }
      chat.streaming = false;
      if (this.activeId === project.id && project.activeChatId === chatId) {
        chatStore.finishStreaming();
      }
    };
  }

  /**
   * Route a single SSE event to the chat's message array. Updates messages
   * via `applyChatEvent`, tracks pending approvals, handles file-change side
   * effects for the active project+chat, and marks background projects' trees
   * as stale when files are modified.
   *
   * CRITICAL: for the active chat, events MUST be applied to
   * `chatStore.messages` (not `chat.messages`) because the UI reads from
   * `chatStore.messages`. In Svelte 5, `chatStore.messages = chat.messages`
   * in `restoreChat` may wrap the value in a separate reactive proxy, so
   * mutating `chat.messages` would NOT trigger UI updates via
   * `chatStore.messages`. After updating `chatStore.messages`, we sync
   * `chat.messages = chatStore.messages` so the chat's history is preserved.
   */
  private handleStreamEvent(project: ProjectEntry, chat: ChatSession, assistantId: string, event: AgentEvent) {
    const isActiveChat = this.activeId === project.id && project.activeChatId === chat.id;

    // Apply the event to the correct message array:
    // - Active chat: route through chatStore.handleEvent so the throttled
    //   streaming buffer (if enabled) batches delta re-renders.
    // - Background chat: chat.messages (silently updated)
    if (isActiveChat) {
      chatStore.handleEvent(assistantId, event);
      // Sync chat.messages to chatStore.messages so the chat's history is
      // preserved when the user switches away. This also ensures they point
      // to the same reactive proxy for future mutations.
      chat.messages = chatStore.messages;
    } else {
      applyChatEvent(chat.messages, assistantId, event);
    }

    // Track pending approvals for this chat.
    if (event.type === "tool.approval_required") {
      const data = event.data as { toolCallId: string; toolName: string; args: Record<string, unknown> };
      chat.pendingApprovals = [
        ...chat.pendingApprovals,
        {
          sessionId: chat.backendSessionId!,
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          args: data.args,
        },
      ];
    }

    // Handle file-modifying tool results.
    if (event.type === "tool.result") {
      const data = event.data as { toolName?: string; result?: unknown; toolCallId?: string } | undefined;
      const toolName = data?.toolName;
      if (toolName) {
        const fileTools = ["apply_patch", "write_file", "create_file", "delete_file"];
        if (fileTools.includes(toolName)) {
          if (isActiveChat) {
            // Active project + active chat: fire side effects (editor flash,
            // tab update, pending-change recording) and refresh the file tree.
            if (toolName === "apply_patch" || toolName === "write_file") {
              this.fileChangeCallback?.(project.rootPath, { toolName, result: data?.result, toolCallId: data?.toolCallId ?? "" });
            }
            this.treeRefreshCallback?.();
          } else {
            // Background chat: mark the project's tree as stale.
            project.treeStale = true;
          }
        }
      }
    }

    // Handle terminal events.
    if (isTerminalEvent(event)) {
      chat.streaming = false;
      if (this.activeId === project.id && project.activeChatId === chat.id) {
        chatStore.finishStreaming();
      }
    }
  }

  /** Stop a chat's stream (closes the EventSource). The server-side turn
   *  is NOT cancelled — call `cancelStream` for that. */
  stopStream(chatId: string) {
    const es = this.eventSources.get(chatId);
    if (es) {
      es.close();
      this.eventSources.delete(chatId);
    }
  }

  /** Cancel a chat's current agent turn: POST to the cancel endpoint,
   *  close the EventSource, and clear the streaming flag. */
  async cancelStream(chatId: string) {
    const found = this.findChat(chatId);
    if (!found) return;
    const { project, chat } = found;
    if (!chat.backendSessionId) return;
    try {
      await fetch(`/api/sessions/${chat.backendSessionId}/cancel`, { method: "POST" });
    } catch {
      // best-effort
    }
    this.stopStream(chatId);
    chat.streaming = false;
    if (this.activeId === project.id && project.activeChatId === chatId) {
      chatStore.finishStreaming();
    }
  }

  /** Resolve a pending tool approval for a chat. POSTs the approval
   *  decision to the backend and removes the card from the chat's
   *  pending list. */
  async resolveApproval(chatId: string, toolCallId: string, approved: boolean) {
    const found = this.findChat(chatId);
    if (!found) return;
    const { chat } = found;
    if (!chat.backendSessionId) return;
    try {
      await fetch(`/api/sessions/${chat.backendSessionId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolCallId, approved }),
      });
    } catch {
      // best-effort
    }
    chat.pendingApprovals = chat.pendingApprovals.filter((p) => p.toolCallId !== toolCallId);
  }

  /** Mark a project's tree as not-stale (after the caller reloads it). */
  clearTreeStale(rootPath: string) {
    const entry = this.projects.find((p) => p.rootPath === rootPath);
    if (entry) entry.treeStale = false;
  }
}

export const projectsStore = new ProjectsStore();
