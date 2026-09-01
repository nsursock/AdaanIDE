import type { FileNode, WorkspaceInfo } from "../types.js";
import { computeLineDiff, type DiffLine } from "../diff.js";

export interface OpenTab {
  path: string;
  name: string;
  content: string;
  hash: string;
  dirty: boolean;
}

/**
 * Signal emitted when a file is modified by the agent (apply_patch / write_file).
 * The Editor component watches this to bring the file forward and flash the
 * changed lines.
 */
export interface PatchSignal {
  path: string;
  /** 1-indexed line numbers that were changed (best-effort from diff). */
  changedLines: number[];
  timestamp: number;
}

/**
 * An agent-made edit to a file that hasn't been reviewed yet. `beforeContent`
 * is the content that was on disk before the FIRST edit this turn made to
 * this file (kept stable across multiple patches in the same turn so
 * rejecting restores the pre-agent version, not just the last patch).
 */
export interface PendingFileChange {
  path: string;
  beforeContent: string;
  beforeHash: string;
  afterContent: string;
  afterHash: string;
  diff: DiffLine[];
  timestamp: number;
}

class WorkspaceStore {
  workspace = $state<WorkspaceInfo | null>(null);
  tree = $state<FileNode[]>([]);
  openTabs = $state<OpenTab[]>([]);
  activeTabPath = $state<string | null>(null);
  loading = $state(false);
  showHidden = $state(false);
  /** Fired when the agent patches/writes a file — Editor watches this. */
  patchSignal = $state<PatchSignal | null>(null);
  /** Agent edits awaiting Accept/Reject, keyed by file path. */
  pendingChanges = $state<Record<string, PendingFileChange>>({});

  get activeTab(): OpenTab | null {
    if (!this.activeTabPath) return null;
    return this.openTabs.find((t) => t.path === this.activeTabPath) ?? null;
  }

  setWorkspace(ws: WorkspaceInfo) {
    this.workspace = ws;
  }

  setTree(tree: FileNode[]) {
    this.tree = tree;
  }

  toggleHidden() {
    this.showHidden = !this.showHidden;
  }

  openFile(path: string, content: string, hash: string) {
    const name = path.split("/").pop() ?? path;
    const existing = this.openTabs.find((t) => t.path === path);
    if (existing) {
      this.activeTabPath = path;
      return;
    }
    this.openTabs.push({ path, name, content, hash, dirty: false });
    this.activeTabPath = path;
  }

  closeTab(path: string) {
    const idx = this.openTabs.findIndex((t) => t.path === path);
    if (idx === -1) return;
    this.openTabs.splice(idx, 1);
    if (this.activeTabPath === path) {
      this.activeTabPath = this.openTabs[idx]?.path ?? this.openTabs[idx - 1]?.path ?? null;
    }
  }

  updateTabContent(path: string, content: string) {
    const tab = this.openTabs.find((t) => t.path === path);
    if (tab) {
      tab.content = content;
      tab.dirty = content !== tab.content;
    }
  }

  markClean(path: string) {
    const tab = this.openTabs.find((t) => t.path === path);
    if (tab) tab.dirty = false;
  }

  /**
   * Notify the editor that the agent modified a file. The Editor will
   * bring the file forward and flash the changed lines.
   */
  signalPatch(path: string, changedLines: number[]) {
    this.patchSignal = { path, changedLines, timestamp: Date.now() };
  }

  reloadTab(path: string, content: string, hash: string) {
    const tab = this.openTabs.find((t) => t.path === path);
    if (tab && !tab.dirty) {
      tab.content = content;
      tab.hash = hash;
      tab.dirty = false;
    }
  }

  isDirty(path: string): boolean {
    return this.openTabs.find((t) => t.path === path)?.dirty ?? false;
  }

  get pendingChangeCount(): number {
    return Object.keys(this.pendingChanges).length;
  }

  get hasPendingChanges(): boolean {
    return this.pendingChangeCount > 0;
  }

  /**
   * Record an agent-made edit to `path` (from apply_patch / write_file) so
   * the editor can render add/modify/remove highlights and the user can
   * Accept or Reject it. If this file already has a pending change from
   * earlier in the same turn, its original `beforeContent`/`beforeHash` is
   * kept so Reject restores the version before ANY of the agent's edits
   * this turn, not just the most recent one.
   */
  recordFileChange(path: string, beforeContent: string, beforeHash: string, afterContent: string, afterHash: string) {
    const existing = this.pendingChanges[path];
    const baseBeforeContent = existing?.beforeContent ?? beforeContent;
    const baseBeforeHash = existing?.beforeHash ?? beforeHash;
    this.pendingChanges = {
      ...this.pendingChanges,
      [path]: {
        path,
        beforeContent: baseBeforeContent,
        beforeHash: baseBeforeHash,
        afterContent,
        afterHash,
        diff: computeLineDiff(baseBeforeContent, afterContent),
        timestamp: Date.now(),
      },
    };
  }

  /** Keep the current (agent-written) version of `path` and stop reviewing it. */
  acceptChange(path: string) {
    if (!(path in this.pendingChanges)) return;
    const { [path]: _removed, ...rest } = this.pendingChanges;
    this.pendingChanges = rest;
  }

  /** Keep every pending agent edit. */
  acceptAllChanges() {
    this.pendingChanges = {};
  }

  close() {
    this.workspace = null;
    this.tree = [];
    this.openTabs = [];
    this.activeTabPath = null;
    this.showHidden = false;
    this.pendingChanges = {};
  }
}

export const workspaceStore = new WorkspaceStore();
