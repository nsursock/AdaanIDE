import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec as execCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { FileNode, FileContent, SearchResult } from "../types.js";
import {
  safeResolve,
  checkSymlinkEscape,
  isCommandAllowed,
  classifyPath,
  assertAgentPathAccess,
  PathSecurityError,
  PathAccessDeniedError,
  CommandDeniedError,
  DEFAULT_SECURITY,
  type SecurityOptions,
} from "./security.js";

const execAsync = promisify(execCb);

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export class Workspace {
  readonly rootPath: string;
  readonly name: string;
  readonly security: SecurityOptions;

  constructor(rootPath: string, opts?: Partial<SecurityOptions>) {
    // Resolve root path, following symlinks (e.g. /var -> /private/var on macOS)
    // so that symlink-escape checks compare against the real root.
    this.rootPath = fssync.realpathSync(path.resolve(rootPath));
    this.name = path.basename(this.rootPath);
    this.security = { ...DEFAULT_SECURITY, ...opts };
  }

  // --- Path resolution -------------------------------------------------------

  resolve(input: string): string {
    return safeResolve(this.rootPath, input);
  }

  relative(absPath: string): string {
    return path.relative(this.rootPath, absPath);
  }

  // --- File tree -------------------------------------------------------------

  async listTree(
    dir?: string,
    depth = 0,
    opts: { showHidden?: boolean; filterForAgent?: boolean } = {}
  ): Promise<FileNode[]> {
    const showHidden = opts.showHidden ?? false;
    const filterForAgent = opts.filterForAgent ?? false;
    const target = dir ? this.resolve(dir) : this.rootPath;
    if (depth >= this.security.maxTreeDepth) return [];

    let entries: fssync.Dirent[];
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch {
      return [];
    }

    const nodes: FileNode[] = [];
    for (const entry of entries) {
      const absPath = path.join(target, entry.name);
      const relPath = this.relative(absPath);
      const zone = classifyPath(relPath);
      const isHidden = entry.name.startsWith(".") || zone === "protected";

      if (filterForAgent) {
        // Agent strictly cannot list or explore protected directories/files
        if (zone === "protected") continue;
      } else {
        // File browser UI: when showHidden is off, hide dotfiles and protected dirs
        if (!showHidden && (entry.name.startsWith(".") || zone === "protected")) {
          continue;
        }
      }

      if (entry.isDirectory()) {
        const children = await this.listTree(relPath, depth + 1, opts);
        nodes.push({
          name: entry.name,
          path: relPath,
          type: "dir",
          children,
          zone,
          hidden: isHidden,
        });
      } else if (entry.isFile()) {
        const stat = await fs.stat(absPath).catch(() => null);
        nodes.push({
          name: entry.name,
          path: relPath,
          type: "file",
          size: stat?.size,
          zone,
          hidden: isHidden,
        });
      }
    }

    // dirs first, then files, alphabetical
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return nodes;
  }

  // --- File read -------------------------------------------------------------

  async readFile(input: string): Promise<FileContent> {
    const abs = this.resolve(input);

    // Check symlink escape
    try {
      const real = await fs.realpath(abs);
      checkSymlinkEscape(this.rootPath, real);
    } catch (e) {
      if (e instanceof PathSecurityError) throw e;
      // Distinguish "file doesn't exist" from other realpath failures
      // (e.g. permission errors) so the agent gets an actionable message.
      try {
        await fs.stat(abs);
      } catch {
        throw new Error(`File not found: ${input} (resolved to ${abs})`);
      }
      // File exists but realpath failed — likely a broken symlink or
      // permission issue. Try reading directly without realpath.
    }

    const stat = await fs.stat(abs).catch(() => {
      throw new Error(`File not found: ${input} (resolved to ${abs})`);
    });
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${input}`);
    }
    if (stat.size > this.security.maxFileSize) {
      throw new Error(`File too large (${stat.size} bytes, max ${this.security.maxFileSize}): ${input}`);
    }

    const content = await fs.readFile(abs, "utf-8");
    return { content, hash: sha256(content), path: this.relative(abs) };
  }

  /**
   * Read a specific line range from a file.
   */
  async readFileRange(input: string, startLine: number, endLine: number): Promise<FileContent & { lineStart: number; lineEnd: number }> {
    const full = await this.readFile(input);
    const lines = full.content.split("\n");
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    const slice = lines.slice(start, end).join("\n");
    return {
      ...full,
      content: slice,
      hash: sha256(slice),
      lineStart: start + 1,
      lineEnd: end,
    };
  }

  // --- File write ------------------------------------------------------------

  async writeFile(input: string, content: string, expectedHash?: string): Promise<{ hash: string; path: string }> {
    const abs = this.resolve(input);

    // If file exists, check hash for optimistic concurrency
    if (expectedHash !== undefined) {
      let existing: string;
      try {
        existing = await fs.readFile(abs, "utf-8");
      } catch {
        throw new Error(`Cannot apply expectedHash: file does not exist: ${input}`);
      }
      const currentHash = sha256(existing);
      if (currentHash !== expectedHash) {
        const err = new Error("Hash mismatch: file has been modified since read");
        (err as any).code = "HASH_MISMATCH";
        (err as any).status = 409;
        throw err;
      }
    } else {
      // If file exists and no hash provided, reject (require hash for existing files)
      try {
        await fs.stat(abs);
        const err = new Error(
          `File already exists: ${input}. To overwrite, first call read_file on this path to get its hash, then pass that hash as expectedHash. To edit specific parts, use apply_patch instead of write_file.`
        );
        (err as any).code = "HASH_REQUIRED";
        (err as any).status = 409;
        throw err;
      } catch (e: any) {
        if (e.code === "HASH_REQUIRED") throw e;
        // file doesn't exist — ok to create
      }
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
    return { hash: sha256(content), path: this.relative(abs) };
  }

  // --- Patch (diff-match-patch) ----------------------------------------------

  async applyPatch(input: string, patch: string, expectedHash: string): Promise<{ hash: string; path: string; applied: boolean }> {
    const abs = this.resolve(input);
    const existing = await fs.readFile(abs, "utf-8").catch(() => {
      throw new Error(`File not found for patching: ${input}`);
    });

    const currentHash = sha256(existing);
    if (currentHash !== expectedHash) {
      const err = new Error("Hash mismatch: file has been modified since read");
      (err as any).code = "HASH_MISMATCH";
      (err as any).status = 409;
      throw err;
    }

    // Apply patch using simple line-based replacement
    // The patch format is: a series of operations
    // We support a simple unified-diff-like format
    const result = applySimplePatch(existing, patch);
    if (!result.success) {
      throw new Error(`Failed to apply patch: ${result.error}`);
    }

    await fs.writeFile(abs, result.content, "utf-8");
    return { hash: sha256(result.content), path: this.relative(abs), applied: true };
  }

  // --- Create ----------------------------------------------------------------

  async createFile(input: string, content = ""): Promise<{ path: string; hash: string }> {
    const abs = this.resolve(input);
    try {
      await fs.stat(abs);
      throw new Error(
        `File already exists: ${input}. Use write_file (with expectedHash from read_file) to overwrite it, or apply_patch to edit specific parts.`
      );
    } catch (e: any) {
      if (e.message.includes("already exists")) throw e;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
    return { path: this.relative(abs), hash: sha256(content) };
  }

  async createDir(input: string): Promise<{ path: string }> {
    const abs = this.resolve(input);
    await fs.mkdir(abs, { recursive: true });
    return { path: this.relative(abs) };
  }

  // --- Delete ----------------------------------------------------------------

  async deleteFile(input: string): Promise<{ path: string }> {
    const abs = this.resolve(input);
    await fs.rm(abs, { recursive: false }).catch(() => {
      throw new Error(`Cannot delete: ${input}`);
    });
    return { path: this.relative(abs) };
  }

  /**
   * Reveal a file or folder in the host OS file manager (Finder on macOS,
   * Explorer on Windows, the default file manager on Linux). The path must
   * exist within the workspace root.
   */
  async revealInFinder(input: string): Promise<{ path: string }> {
    const abs = this.resolve(input);
    // Verify the path exists — reveal makes no sense for a missing entry.
    await fs.access(abs).catch(() => {
      throw new Error(`Path does not exist: ${input}`);
    });

    const platform = os.platform();
    if (platform === "darwin") {
      // `open -R` reveals the file/folder in Finder.
      await execAsync(`open -R "${abs}"`);
    } else if (platform === "win32") {
      // `explorer /select,<path>` highlights the file in Explorer.
      await execAsync(`explorer /select,${abs}`);
    } else {
      // Linux: no standard "reveal" — open the item itself (folder opens in
      // file manager; file opens with default app). For a file, open its
      // parent directory instead so the behavior matches the other platforms.
      const stat = await fs.stat(abs);
      const target = stat.isDirectory() ? abs : path.dirname(abs);
      await execAsync(`xdg-open "${target}"`);
    }
    return { path: this.relative(abs) };
  }

  // --- Search ----------------------------------------------------------------

  async search(query: string, glob?: string, filterForAgent = false): Promise<SearchResult[]> {
    // Try ripgrep first, fall back to JS grep
    let results: SearchResult[];
    try {
      results = await this.searchWithRipgrep(query, glob);
    } catch {
      results = await this.searchWithJs(query, glob, filterForAgent);
    }

    // Always filter out protected paths and (for agents) sensitive paths
    return results.filter((r) => {
      const zone = classifyPath(r.path);
      if (zone === "protected") return false;
      if (filterForAgent && zone === "sensitive") return false;
      return true;
    });
  }

  private async searchWithRipgrep(query: string, glob?: string): Promise<SearchResult[]> {
    const args = ["--json", "--no-heading", "--line-number", "--with-filename"];
    if (glob) args.push("--glob", glob);
    args.push("-e", query, ".");

    try {
      const { stdout } = await execAsync(`rg ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, {
        cwd: this.rootPath,
        maxBuffer: 10 * 1024 * 1024,
      });
      return parseRipgrepJson(stdout);
    } catch (e: any) {
      if (e.stderr && e.stderr.includes("no files found")) return [];
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw e;
      // rg not found or other error — fall through to JS
      throw e;
    }
  }

  private async searchWithJs(query: string, glob?: string, filterForAgent = false): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const regex = new RegExp(escapeRegex(query), "gi");
    const globRe = glob ? globToRegex(glob) : null;

    const walk = async (dir: string, depth: number) => {
      if (depth >= this.security.maxTreeDepth) return;
      let entries: fssync.Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        const rel = this.relative(abs);
        const zone = classifyPath(rel);

        if (zone === "protected") continue;
        if (filterForAgent && zone === "sensitive") continue;

        if (entry.isDirectory()) {
          await walk(abs, depth + 1);
        } else if (entry.isFile()) {
          if (globRe && !globRe.test(entry.name)) continue;
          try {
            const stat = await fs.stat(abs);
            if (stat.size > this.security.maxFileSize) continue;
            const content = await fs.readFile(abs, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              regex.lastIndex = 0;
              const match = regex.exec(lines[i]);
              if (match) {
                results.push({
                  path: rel,
                  line: i + 1,
                  column: match.index + 1,
                  text: lines[i].trim(),
                  match: match[0],
                });
                if (results.length >= 200) return;
              }
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    };

    await walk(this.rootPath, 0);
    return results;
  }

  // --- Shell -----------------------------------------------------------------

  async executeCommand(command: string, timeoutMs?: number): Promise<ShellResult> {
    if (!isCommandAllowed(command, this.security.commandDenyList)) {
      throw new CommandDeniedError(command);
    }

    const timeout = timeoutMs ?? this.security.shellTimeoutMs;
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.rootPath,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0, timedOut: false };
    } catch (e: any) {
      if (e.killed || e.signal === "SIGTERM") {
        return {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
          exitCode: e.code ?? -1,
          timedOut: true,
        };
      }
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message,
        exitCode: e.code ?? -1,
        timedOut: false,
      };
    }
  }

  // --- Git -------------------------------------------------------------------

  async gitStatus(): Promise<string> {
    const r = await this.executeCommand("git status --porcelain=v1");
    return r.stdout;
  }

  async gitDiff(file?: string): Promise<string> {
    const cmd = file ? `git diff -- ${file}` : "git diff";
    const r = await this.executeCommand(cmd);
    return r.stdout;
  }

  async gitCheckpoint(message: string): Promise<string> {
    const r = await this.executeCommand(
      `git add -A && git commit -m ${JSON.stringify(message)} --no-verify`
    );
    return r.stdout + r.stderr;
  }

  async gitRollback(ref?: string): Promise<string> {
    const cmd = ref ? `git reset --hard ${ref}` : "git reset --hard HEAD~1";
    const r = await this.executeCommand(cmd);
    return r.stdout + r.stderr;
  }

  // --- Existence -------------------------------------------------------------

  async exists(input: string): Promise<boolean> {
    try {
      const abs = this.resolve(input);
      await fs.stat(abs);
      return true;
    } catch {
      return false;
    }
  }

  // --- Static factory --------------------------------------------------------

  static async open(rootPath: string, opts?: Partial<SecurityOptions>): Promise<Workspace> {
    const stat = await fs.stat(rootPath);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${rootPath}`);
    }
    return new Workspace(rootPath, opts);
  }

  static async listCandidateRoots(): Promise<string[]> {
    const home = os.homedir();
    const candidates = [
      path.join(home, "projects"),
      path.join(home, "repos"),
      path.join(home, "code"),
      path.join(home, "dev"),
      path.join(home, "src"),
      home,
    ];

    const roots: string[] = [];
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) {
          const entries = await fs.readdir(candidate, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith(".")) {
              roots.push(path.join(candidate, entry.name));
            }
          }
          if (roots.length > 0) break;
        }
      } catch {
        // dir doesn't exist, try next
      }
    }
    return roots;
  }

  /**
   * Preferred parent directory for newly created projects: the first existing
   * candidate from listCandidateRoots (minus home fallback scanning), else home.
   */
  static async defaultProjectParent(): Promise<string> {
    const home = os.homedir();
    for (const dir of ["projects", "repos", "code", "dev", "src"]) {
      const candidate = path.join(home, dir);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) return candidate;
      } catch {
        // try next
      }
    }
    return home;
  }

  /**
   * Create a brand-new project directory and scaffold starter files.
   * Fails if the path exists as a file or as a non-empty directory.
   */
  static async create(rootPath: string, opts?: Partial<SecurityOptions> & { scaffold?: boolean }): Promise<Workspace> {
    const abs = path.resolve(rootPath);

    let exists = false;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) {
        throw new Error(`Path exists and is not a directory: ${rootPath}`);
      }
      exists = true;
      const entries = await fs.readdir(abs);
      if (entries.length > 0) {
        throw new Error(`Directory is not empty: ${rootPath}`);
      }
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }

    if (!exists) {
      await fs.mkdir(abs, { recursive: true });
    }

    if (opts?.scaffold !== false) {
      const name = path.basename(abs);
      await fs.writeFile(path.join(abs, "README.md"), `# ${name}\n`, "utf-8");
      await fs.writeFile(path.join(abs, ".gitignore"), "node_modules/\ndist/\n.env\n", "utf-8");
    }

    return new Workspace(abs, opts);
  }
}

// --- Helpers ------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
  const pattern = glob
    .replace(/\./g, "\\.")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`);
}

function parseRipgrepJson(stdout: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "match") {
        results.push({
          path: obj.data.path.text,
          line: obj.data.line_number,
          column: (obj.data.submatches[0]?.start ?? 0) + 1,
          text: obj.data.lines.text.trim(),
          match: obj.data.submatches[0]?.match.text ?? "",
        });
      }
    } catch {
      // skip non-JSON lines
    }
  }
  return results;
}

// --- Simple patch implementation ---------------------------------------------

interface PatchResult {
  success: boolean;
  content: string;
  error?: string;
}

/**
 * Apply a simple patch format. Supports:
 * - "SEARCH\n<lines>\nREPLACE\n<lines>" blocks
 * - Multiple SEARCH/REPLACE blocks separated by "---"
 *
 * Matching strategy:
 * 1. Exact substring match (fast path).
 * 2. If that fails, try whitespace-normalized fuzzy match — weaker models
 *    often reproduce code with slightly different indentation or trailing
 *    spaces, so we collapse runs of whitespace and compare, then map the
 *    replacement back preserving the original's leading indentation.
 */
function applySimplePatch(original: string, patch: string): PatchResult {
  let content = original;
  const blocks = patch.split(/\n---\n/);

  for (const block of blocks) {
    const lines = block.split("\n");
    let state: "search" | "replace" | "none" = "none";
    let searchLines: string[] = [];
    let replaceLines: string[] = [];

    for (const line of lines) {
      if (line === "SEARCH") {
        state = "search";
        searchLines = [];
      } else if (line === "REPLACE") {
        state = "replace";
        replaceLines = [];
      } else if (state === "search") {
        searchLines.push(line);
      } else if (state === "replace") {
        replaceLines.push(line);
      }
    }

    if (searchLines.length === 0) continue;

    // A SEARCH block with no REPLACE section would silently delete the
    // matched lines — that's almost never what the model intended. Require
    // an explicit (possibly empty) REPLACE section to confirm deletion.
    if (state === "search") {
      return {
        success: false,
        content,
        error: `SEARCH block has no REPLACE section — refusing to silently delete lines. Add "REPLACE" (even if empty) to delete:\n${searchLines.join("\n").slice(0, 200)}...`,
      };
    }

    const searchText = searchLines.join("\n");
    const replaceText = replaceLines.join("\n");

    // 1. Fast path — exact substring match.
    //    Use a replacer function so `$` in replaceText is treated literally
    //    (String.replace with a string 2nd arg treats $&, $`, $', $$, $1… specially).
    if (content.includes(searchText)) {
      content = content.replace(searchText, () => replaceText);
      continue;
    }

    // 2. Fuzzy path — whitespace-normalized match.
    const fuzzy = fuzzyReplace(content, searchText, replaceText);
    if (fuzzy.matched) {
      content = fuzzy.content;
      continue;
    }

    return {
      success: false,
      content,
      error: `SEARCH block not found:\n${searchText.slice(0, 200)}...`,
    };
  }

  return { success: true, content };
}

/**
 * Try to find `searchText` in `content` allowing whitespace differences
 * (different indentation, trailing spaces, CRLF vs LF). If found, replace
 * with `replaceText`, preserving the original's leading indentation on the
 * first line so the replacement doesn't break code structure.
 */
function fuzzyReplace(content: string, searchText: string, replaceText: string): { matched: boolean; content: string } {
  const normLine = (s: string): string => s.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
  const contentLines = content.split("\n");
  const searchLinesNorm = searchText.split("\n").map(normLine);
  // Drop leading/trailing empty search lines (model may add spurious blank lines).
  while (searchLinesNorm.length > 0 && searchLinesNorm[0] === "") searchLinesNorm.shift();
  while (searchLinesNorm.length > 0 && searchLinesNorm[searchLinesNorm.length - 1] === "") searchLinesNorm.pop();
  if (searchLinesNorm.length === 0) return { matched: false, content };

  for (let i = 0; i <= contentLines.length - searchLinesNorm.length; i++) {
    let match = true;
    for (let j = 0; j < searchLinesNorm.length; j++) {
      if (normLine(contentLines[i + j]) !== searchLinesNorm[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Preserve the original leading whitespace of the first matched line.
      const firstLine = contentLines[i];
      const leadingWs = firstLine.match(/^[ \t]*/)?.[0] ?? "";
      const replaceLines = replaceText.split("\n");
      if (replaceLines.length > 0 && leadingWs) {
        replaceLines[0] = leadingWs + replaceLines[0].replace(/^[ \t]+/, "");
      }
      const newLines = [
        ...contentLines.slice(0, i),
        ...replaceLines,
        ...contentLines.slice(i + searchLinesNorm.length),
      ];
      return { matched: true, content: newLines.join("\n") };
    }
  }

  return { matched: false, content };
}
