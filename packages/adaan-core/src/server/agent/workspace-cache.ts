/**
 * Workspace-level (L2) tool result cache. Shared across all sessions in a
 * workspace, so two sessions reading the same file don't re-execute the tool.
 *
 * LRU with TTL-based expiry. Only caches read-only tools:
 * read_file, list_symbols, search_files, list_files, git_status, git_diff.
 *
 * Owned by the Workspace (one per root). Invalidated on any write through
 * workspace.ts and on external file-watcher events.
 */
export class WorkspaceCache {
  private cache: Map<string, { result: unknown; expiresAt: number }> = new Map();
  private pathIndex: Map<string, Set<string>> = new Map();
  private accessOrder: string[] = []; // LRU tracking
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(maxEntries = 200, ttlMs = 5 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
  }

  private static makeKey(toolName: string, args: Record<string, unknown>): string {
    return `${toolName}:${JSON.stringify(args)}`;
  }

  /** Get a cached result. Returns null if not cached or expired. */
  get(toolName: string, args: Record<string, unknown>): unknown | null {
    const key = WorkspaceCache.makeKey(toolName, args);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      return null;
    }
    // Move to end (most recently used).
    this.removeFromAccessOrder(key);
    this.accessOrder.push(key);
    return entry.result;
  }

  /** Store a result. If it depends on a file path, register for invalidation. */
  set(toolName: string, args: Record<string, unknown>, result: unknown, filePath?: string): void {
    const key = WorkspaceCache.makeKey(toolName, args);
    // Evict LRU if at capacity.
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      const oldest = this.accessOrder.shift();
      if (oldest) {
        this.cache.delete(oldest);
        this.removeFromPathIndex(oldest);
      }
    }
    this.cache.set(key, { result, expiresAt: Date.now() + this.ttlMs });
    this.removeFromAccessOrder(key);
    this.accessOrder.push(key);

    if (filePath) {
      let keys = this.pathIndex.get(filePath);
      if (!keys) {
        keys = new Set();
        this.pathIndex.set(filePath, keys);
      }
      keys.add(key);
    }
  }

  /** Invalidate all entries related to a specific file path. */
  invalidatePath(filePath: string): void {
    const keys = this.pathIndex.get(filePath);
    if (!keys) return;
    for (const key of keys) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
    }
    this.pathIndex.delete(filePath);
  }

  /** Invalidate all list_files / git_status / git_diff entries (tree changed). */
  invalidateTree(): void {
    for (const key of this.cache.keys()) {
      if (
        key.startsWith("list_files:") ||
        key.startsWith("git_status:") ||
        key.startsWith("git_diff:")
      ) {
        this.cache.delete(key);
        this.removeFromAccessOrder(key);
      }
    }
  }

  /** Clear the entire cache. */
  clear(): void {
    this.cache.clear();
    this.pathIndex.clear();
    this.accessOrder = [];
  }

  get size(): number {
    return this.cache.size;
  }

  private removeFromAccessOrder(key: string): void {
    const idx = this.accessOrder.indexOf(key);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
  }

  private removeFromPathIndex(key: string): void {
    for (const keys of this.pathIndex.values()) {
      keys.delete(key);
    }
  }
}

/** Read-only tools that are safe to cache at the workspace level. */
export const L2_CACHEABLE_TOOLS = new Set([
  "read_file",
  "list_symbols",
  "search_files",
  "list_files",
  "git_status",
  "git_diff",
]);
