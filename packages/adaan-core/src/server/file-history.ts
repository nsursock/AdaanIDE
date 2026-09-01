import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * Local version control for AdaanIDE — a lightweight "local GitHub".
 *
 * Every time a file is modified (by the agent via apply_patch/write_file, or
 * by the user saving in the editor), the PREVIOUS version is snapshotted into
 * `.adaan/history/<encoded-path>/<timestamp>.json`. Each snapshot stores the
 * full file content, its hash, a timestamp, and metadata about who changed it
 * and why.
 *
 * This is NOT a replacement for git — it's a session-level undo history that
 * works even in non-git workspaces, and gives the UI a timeline view with
 * per-file Accept/Reject and restore-to-any-version capabilities.
 */

export interface HistoryEntry {
  /** Unique ID for this version (timestamp + short hash). */
  id: string;
  /** Workspace-relative file path. */
  path: string;
  /** SHA-256 of the content at this version. */
  hash: string;
  /** Unix timestamp (ms) when this version was captured. */
  timestamp: number;
  /** Who made the change: "agent" | "user" | "restore". */
  source: "agent" | "user" | "restore";
  /** Optional label (e.g. the tool name, or "manual save"). */
  label?: string;
  /** Content at this version. */
  content: string;
  /** Diff stats vs the PREVIOUS version (the one before this in time). */
  stats?: { added: number; modified: number; removed: number };
}

export interface HistoryListEntry {
  id: string;
  path: string;
  hash: string;
  timestamp: number;
  source: "agent" | "user" | "restore";
  label?: string;
  stats?: { added: number; modified: number; removed: number };
}

const HISTORY_DIR = ".adaan";
const HISTORY_SUBDIR = "history";

export class FileHistory {
  constructor(readonly rootPath: string) {}

  private get historyRoot(): string {
    return path.join(this.rootPath, HISTORY_DIR, HISTORY_SUBDIR);
  }

  /** Encode a file path into a safe directory name (base64url, no padding). */
  private encodePath(filePath: string): string {
    return Buffer.from(filePath, "utf-8").toString("base64url");
  }

  private decodePath(encoded: string): string {
    return Buffer.from(encoded, "base64url").toString("utf-8");
  }

  private getFilePath(filePath: string): string {
    return path.join(this.historyRoot, this.encodePath(filePath));
  }

  /**
   * Snapshot a file version. Called BEFORE a write/patch overwrites the file
   * — the snapshot preserves the content that's about to be replaced.
   *
   * Returns the created entry, or null if there was nothing to snapshot
   * (file didn't exist or content was identical to the last snapshot).
   */
  async snapshot(
    filePath: string,
    content: string,
    source: "agent" | "user" | "restore" = "agent",
    label?: string,
    force = false,
  ): Promise<HistoryEntry | null> {
    const hash = sha256(content);
    const dir = this.getFilePath(filePath);
    await fs.mkdir(dir, { recursive: true });

    // Don't snapshot if the content is identical to the most recent snapshot
    // — avoids duplicate entries when the agent reads+writes the same content.
    // `force` bypasses this (used by restore to snapshot the pre-restore state
    // even if it matches the last version).
    const entries = await this.listEntries(filePath);
    if (!force && entries.length > 0 && entries[0].hash === hash) {
      return null;
    }

    const timestamp = Date.now();
    const id = `${timestamp}-${hash.slice(0, 8)}`;
    const entry: HistoryEntry = {
      id,
      path: filePath,
      hash,
      timestamp,
      source,
      label,
      content,
    };

    // Compute diff stats vs the previous version (if any).
    if (entries.length > 0) {
      const prev = await this.getEntry(filePath, entries[0].id);
      if (prev) {
        entry.stats = computeStats(prev.content, content);
      }
    }

    const entryPath = path.join(dir, `${id}.json`);
    await fs.writeFile(entryPath, JSON.stringify(entry), "utf-8");
    return entry;
  }

  /** List all snapshot versions of a file, newest first. */
  async list(filePath: string): Promise<HistoryListEntry[]> {
    const entries = await this.listEntries(filePath);
    return entries.map((e) => ({
      id: e.id,
      path: e.path,
      hash: e.hash,
      timestamp: e.timestamp,
      source: e.source,
      label: e.label,
      stats: e.stats,
    }));
  }

  /** Get a specific version's full content. */
  async get(filePath: string, id: string): Promise<HistoryEntry | null> {
    return this.getEntry(filePath, id);
  }

  /**
   * Restore a file to a specific version. Snapshots the CURRENT content first
   * (so the restore itself is undoable), then writes the old version back.
   * Returns the new current hash.
   */
  async restore(
    filePath: string,
    id: string,
    absPath: string,
  ): Promise<{ hash: string; restored: HistoryEntry }> {
    const entry = await this.getEntry(filePath, id);
    if (!entry) {
      throw new Error(`History version not found: ${id}`);
    }

    // Snapshot the current content before restoring (so the restore is itself
    // undoable from the history timeline).
    let currentContent = "";
    try {
      currentContent = await fs.readFile(absPath, "utf-8");
      await this.snapshot(filePath, currentContent, "restore", `before restore of ${id}`, true);
    } catch {
      // file may not exist — nothing to snapshot
    }

    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, entry.content, "utf-8");
    return { hash: entry.hash, restored: entry };
  }

  /** Delete all history for a file. */
  async clear(filePath: string): Promise<void> {
    const dir = this.getFilePath(filePath);
    await fs.rm(dir, { recursive: true, force: true });
  }

  /** List all files that have history. */
  async listFiles(): Promise<string[]> {
    try {
      const dirs = await fs.readdir(this.historyRoot, { withFileTypes: true });
      return dirs
        .filter((d) => d.isDirectory())
        .map((d) => this.decodePath(d.name))
        .sort();
    } catch {
      return [];
    }
  }

  // --- Internal ---

  private async listEntries(filePath: string): Promise<HistoryListEntry[]> {
    const dir = this.getFilePath(filePath);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return [];
    }
    const entries: HistoryListEntry[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(dir, file), "utf-8");
        const entry = JSON.parse(raw) as HistoryEntry;
        entries.push({
          id: entry.id,
          path: entry.path,
          hash: entry.hash,
          timestamp: entry.timestamp,
          source: entry.source,
          label: entry.label,
          stats: entry.stats,
        });
      } catch {
        // corrupted entry — skip
      }
    }
    // Sort newest first (IDs start with timestamp, so lexical sort works).
    entries.sort((a, b) => b.id.localeCompare(a.id));
    return entries;
  }

  private async getEntry(filePath: string, id: string): Promise<HistoryEntry | null> {
    const dir = this.getFilePath(filePath);
    try {
      const raw = await fs.readFile(path.join(dir, `${id}.json`), "utf-8");
      return JSON.parse(raw) as HistoryEntry;
    } catch {
      return null;
    }
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function computeStats(oldContent: string, newContent: string): { added: number; modified: number; removed: number } {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  // Simple LCS-free positional diff for stats — good enough for a badge.
  const maxLen = Math.max(oldLines.length, newLines.length);
  let added = 0;
  let modified = 0;
  let removed = 0;
  for (let i = 0; i < maxLen; i++) {
    if (i >= oldLines.length) {
      added++;
    } else if (i >= newLines.length) {
      removed++;
    } else if (oldLines[i] !== newLines[i]) {
      modified++;
    }
  }
  return { added, modified, removed };
}
