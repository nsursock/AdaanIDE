/**
 * Per-session tool result cache.
 * Keyed by toolName + serialized args.
 * Invalidated by file-watcher events and explicit writes/deletes.
 */
export class ToolResultCache {
  private cache: Map<string, { result: unknown; timestamp: number }> = new Map();
  private pathIndex: Map<string, Set<string>> = new Map(); // filePath -> cache keys

  private static makeKey(toolName: string, args: Record<string, unknown>): string {
    return `${toolName}:${JSON.stringify(args)}`;
  }

  /**
   * Get a cached result. Returns null if not cached.
   */
  get(toolName: string, args: Record<string, unknown>): unknown | null {
    const key = ToolResultCache.makeKey(toolName, args);
    const entry = this.cache.get(key);
    if (!entry) return null;
    return entry.result;
  }

  /**
   * Store a result in the cache.
   * If the result depends on a file path, register it for invalidation.
   */
  set(toolName: string, args: Record<string, unknown>, result: unknown, filePath?: string): void {
    const key = ToolResultCache.makeKey(toolName, args);
    this.cache.set(key, { result, timestamp: Date.now() });

    if (filePath) {
      let keys = this.pathIndex.get(filePath);
      if (!keys) {
        keys = new Set();
        this.pathIndex.set(filePath, keys);
      }
      keys.add(key);
    }
  }

  /**
   * Invalidate all cache entries related to a specific file path.
   */
  invalidatePath(filePath: string): void {
    const keys = this.pathIndex.get(filePath);
    if (!keys) return;
    for (const key of keys) {
      this.cache.delete(key);
    }
    this.pathIndex.delete(filePath);
  }

  /**
   * Invalidate all cache entries for list_files (since the tree may have changed).
   */
  invalidateTree(): void {
    // Remove all list_files entries
    for (const key of this.cache.keys()) {
      if (key.startsWith("list_files:")) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Invalidate all execute_command and run_tests entries.
   * Called after any file write/patch/delete because commands and tests
   * may depend on file contents — returning stale output hides whether
   * the edit actually worked.
   */
  invalidateCommands(): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith("execute_command:") || key.startsWith("run_tests:")) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
    this.pathIndex.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
