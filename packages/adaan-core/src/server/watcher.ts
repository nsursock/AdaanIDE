import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
import type { WatcherEvent, WatcherEventType } from "../types.js";
import { DEFAULT_IGNORE_DIRS } from "./security.js";

export type WatcherCallback = (event: WatcherEvent) => void;

/**
 * Watches a workspace directory for file changes.
 * Uses chokidar with the standard ignore list.
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private rootPath: string;
  private callbacks: Set<WatcherCallback> = new Set();

  constructor(rootPath: string) {
    this.rootPath = path.resolve(rootPath);
  }

  /**
   * Start watching. Returns a promise that resolves when the initial scan is complete.
   */
  async start(): Promise<void> {
    if (this.watcher) return;

    const ignored = [...DEFAULT_IGNORE_DIRS].map((d) => `**/${d}/**`);

    this.watcher = watch(this.rootPath, {
      ignored,
      persistent: true,
      ignoreInitial: true,
      depth: 15,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    const emit = (type: WatcherEventType, filePath: string) => {
      const relPath = path.relative(this.rootPath, filePath);
      const event: WatcherEvent = { type, path: relPath, timestamp: Date.now() };
      for (const cb of this.callbacks) {
        cb(event);
      }
    };

    this.watcher
      .on("add", (fp) => emit("add", fp))
      .on("change", (fp) => emit("change", fp))
      .on("unlink", (fp) => emit("unlink", fp))
      .on("addDir", (fp) => emit("addDir", fp))
      .on("unlinkDir", (fp) => emit("unlinkDir", fp));

    // Wait for initial scan
    await new Promise<void>((resolve) => {
      this.watcher?.once("ready", () => resolve());
    });
  }

  /**
   * Subscribe to watcher events.
   * Returns an unsubscribe function.
   */
  subscribe(cb: WatcherCallback): () => void {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  /**
   * Stop watching.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.callbacks.clear();
  }
}

/**
 * Global watcher registry — maps workspace root path to FileWatcher.
 */
const watchers: Map<string, FileWatcher> = new Map();

export function getWatcher(rootPath: string): FileWatcher {
  const resolved = path.resolve(rootPath);
  let watcher = watchers.get(resolved);
  if (!watcher) {
    watcher = new FileWatcher(resolved);
    watchers.set(resolved, watcher);
  }
  return watcher;
}

export async function stopAllWatchers(): Promise<void> {
  for (const watcher of watchers.values()) {
    await watcher.stop();
  }
  watchers.clear();
}
