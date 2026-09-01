import type { ChatMessage, SessionState, SessionStatus } from "../../types.js";
import { ToolResultCache } from "./cache.js";

/**
 * An agent session holds the conversation state for one chat thread.
 */
export class AgentSession {
  id: string;
  workspaceId: string;
  status: SessionStatus = "idle";
  messages: ChatMessage[] = [];
  iterationCount = 0;
  modelUsed: string | null = null;
  createdAt: number;
  abortController: AbortController = new AbortController();
  cache: ToolResultCache = new ToolResultCache();

  /** Set by resume() when a new turn supersedes an in-flight one. The
   *  old engine.run() generator checks this to exit silently instead of
   *  emitting error/cancelled events that would clobber the new turn's UI. */
  superseded = false;

  /** B1: repeat-failure guard — maps argsHash to the last error for a failed
   *  tool call. Cleared on any successful write. Prevents the model from
   *  re-issuing an identical failed call (e.g. malformed apply_patch 3×). */
  failedCallCache: Map<string, string> = new Map();

  // Pending approval requests: toolCallId -> resolver
  private pendingApprovals: Map<string, (approved: boolean) => void> = new Map();

  constructor(id: string, workspaceId: string) {
    this.id = id;
    this.workspaceId = workspaceId;
    this.createdAt = Date.now();
  }

  get state(): SessionState {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      status: this.status,
      messages: [...this.messages],
      iterationCount: this.iterationCount,
      modelUsed: this.modelUsed,
      createdAt: this.createdAt,
    };
  }

  cancel() {
    this.status = "cancelled";
    this.abortController.abort();
    // Reject all pending approvals
    for (const resolver of this.pendingApprovals.values()) {
      resolver(false);
    }
    this.pendingApprovals.clear();
  }

  /** Prepare a finished/cancelled session to accept another user turn. */
  resume() {
    // If a turn is currently running, mark it as superseded so the old
    // engine.run() generator exits silently instead of emitting events
    // that would clobber the new turn's UI.
    if (this.status === "running") {
      this.superseded = true;
    }
    // ALWAYS abort the previous AbortController so any in-flight
    // engine.run() generator stops calling the provider and pushing to
    // session.messages. Without this, two generators run concurrently,
    // corrupting the conversation and causing empty responses.
    this.abortController.abort();
    this.abortController = new AbortController();
    // A new user message supersedes any in-flight turn. If the previous
    // engine.run() generator is still suspended waiting on a tool approval
    // (e.g. the user typed a follow-up instead of answering the prompt),
    // that generator is about to be abandoned — auto-deny its approvals so
    // they don't linger forever as zombie UI cards or silently resolve
    // later against a conversation that has already moved on.
    if (this.pendingApprovals.size > 0) {
      for (const resolver of this.pendingApprovals.values()) {
        resolver(false);
      }
      this.pendingApprovals.clear();
    }
    this.status = "running";
    this.iterationCount = 0;
  }

  isCancelled(): boolean {
    return this.status === "cancelled" || this.abortController.signal.aborted;
  }

  /**
   * Wait for user approval of a tool call.
   */
  awaitApproval(toolCallId: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(toolCallId, resolve);
    });
  }

  /**
   * Resolve a pending approval request.
   */
  resolveApproval(toolCallId: string, approved: boolean) {
    const resolver = this.pendingApprovals.get(toolCallId);
    if (resolver) {
      resolver(approved);
      this.pendingApprovals.delete(toolCallId);
    }
  }
}

/**
 * In-memory session store.
 */
export class SessionStore {
  private sessions: Map<string, AgentSession> = new Map();

  create(id: string, workspaceId: string): AgentSession {
    const session = new AgentSession(id, workspaceId);
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  delete(id: string) {
    const session = this.sessions.get(id);
    if (session) {
      session.cancel();
      this.sessions.delete(id);
    }
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  all(): AgentSession[] {
    return [...this.sessions.values()];
  }
}

export const sessionStore = new SessionStore();
