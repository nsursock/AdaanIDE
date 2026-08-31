import type { FileNode, WorkspaceInfo } from "../types.js";

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

class WorkspaceStore {
  workspace = $state<WorkspaceInfo | null>(null);
  tree = $state<FileNode[]>([]);
  openTabs = $state<OpenTab[]>([]);
  activeTabPath = $state<string | null>(null);
  loading = $state(false);
  showHidden = $state(false);
  /** Fired when the agent patches/writes a file — Editor watches this. */
  patchSignal = $state<PatchSignal | null>(null);

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

  close() {
    this.workspace = null;
    this.tree = [];
    this.openTabs = [];
    this.activeTabPath = null;
    this.showHidden = false;
  }
}

export const workspaceStore = new WorkspaceStore();
