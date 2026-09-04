<script lang="ts">
  import {
    IconBrandGithub,
    IconRefresh,
    IconGitCommit,
    IconGitBranch,
    IconCheck,
    IconAlertTriangle,
    IconPlus,
    IconMinus,
    IconFileCode,
    IconFile,
    IconFileDiff,
    IconCircleDot,
    IconChevronRight,
    IconChevronDown,
    IconFolder,
  } from "@tabler/icons-svelte";

  let { workspaceRoot }: { workspaceRoot: string } = $props();

  interface GitCommit {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    timestamp: number;
    message: string;
    repo?: string;
  }

  let status = $state("");
  let branch = $state("");
  let remote = $state("");
  let aheadBehind = $state("");
  let commits = $state<GitCommit[]>([]);
  let rawDiff = $state("");
  let loading = $state(false);
  let committing = $state(false);
  let commitMsg = $state("");
  let showCommit = $state(false);
  let selectedFile = $state<string | null>(null);
  let error = $state<string | null>(null);
  let view = $state<"changes" | "history">("changes");
  let expandedDirs = $state<Set<string>>(new Set());

  /** Parse porcelain status into structured file entries. */
  interface FileChange {
    code: string;
    path: string;
    name: string;
    dir: string;
    staged: boolean;
  }
  const fileChanges = $derived.by<FileChange[]>(() => {
    if (!status) return [];
    return status
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const code = line.slice(0, 2);
        const p = line.slice(3);
        const parts = p.split("/");
        return {
          code,
          path: p,
          name: parts[parts.length - 1] || p,
          dir: parts.slice(0, -1).join("/"),
          staged: code[0] !== " " && code[0] !== "?",
        };
      });
  });

  const stagedCount = $derived(fileChanges.filter((f) => f.staged).length);
  const unstagedCount = $derived(fileChanges.filter((f) => !f.staged).length);
  const ahead = $derived(aheadBehind ? parseInt(aheadBehind.split(/\s+/)[0], 10) || 0 : 0);
  const behind = $derived(aheadBehind ? parseInt(aheadBehind.split(/\s+/)[1], 10) || 0 : 0);
  const repoName = $derived(remote ? remote.replace(/\.git$/, "").split("/").pop() || remote : "");

  /** Build a tree from changed file paths for the file browser. */
  interface TreeNode {
    name: string;
    path: string;
    isDir: boolean;
    children: Map<string, TreeNode>;
    file?: FileChange;
  }
  const fileTree = $derived.by<TreeNode>(() => {
    const root: TreeNode = { name: "", path: "", isDir: true, children: new Map() };
    for (const fc of fileChanges) {
      const parts = fc.path.split("/");
      let cur = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        const childPath = parts.slice(0, i + 1).join("/");
        if (!cur.children.has(part)) {
          cur.children.set(part, {
            name: part,
            path: childPath,
            isDir: !isLast,
            children: new Map(),
          });
        }
        cur = cur.children.get(part)!;
        if (isLast) {
          cur.isDir = false;
          cur.file = fc;
        }
      }
    }
    return root;
  });

  /** Sorted children array for rendering. */
  function sortedChildren(node: TreeNode): TreeNode[] {
    return [...node.children.values()].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function toggleDir(path: string) {
    if (expandedDirs.has(path)) {
      expandedDirs.delete(path);
    } else {
      expandedDirs.add(path);
    }
    expandedDirs = new Set(expandedDirs);
  }

  /** Parse a unified diff into structured lines for colored rendering. */
  interface DiffLine {
    type: "context" | "add" | "del" | "hunk" | "meta";
    oldNo: number | null;
    newNo: number | null;
    content: string;
  }
  interface DiffFile {
    path: string;
    oldPath: string;
    newPath: string;
    hunks: DiffLine[][];
  }
  const diffFiles = $derived.by<DiffFile[]>(() => {
    if (!rawDiff) return [];
    const files: DiffFile[] = [];
    let cur: DiffFile | null = null;
    let curHunk: DiffLine[] | null = null;
    let oldNo = 0;
    let newNo = 0;
    for (const line of rawDiff.split("\n")) {
      if (line.startsWith("diff --git")) {
        if (cur) files.push(cur);
        cur = { path: "", oldPath: "", newPath: "", hunks: [] };
        curHunk = null;
      } else if (line.startsWith("--- ")) {
        if (cur) cur.oldPath = line.slice(4).replace(/^a\//, "");
      } else if (line.startsWith("+++ ")) {
        if (cur) {
          cur.newPath = line.slice(4).replace(/^b\//, "");
          cur.path = cur.newPath;
        }
      } else if (line.startsWith("@@ ")) {
        if (cur) {
          curHunk = [];
          cur.hunks.push(curHunk);
          const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          oldNo = m ? parseInt(m[1], 10) - 1 : 0;
          newNo = m ? parseInt(m[2], 10) - 1 : 0;
          curHunk.push({ type: "hunk", oldNo: null, newNo: null, content: line });
        }
      } else if (line.startsWith("+")) {
        if (curHunk) {
          newNo++;
          curHunk.push({ type: "add", oldNo: null, newNo, content: line.slice(1) });
        }
      } else if (line.startsWith("-")) {
        if (curHunk) {
          oldNo++;
          curHunk.push({ type: "del", oldNo, newNo: null, content: line.slice(1) });
        }
      } else if (line.startsWith(" ")) {
        if (curHunk) {
          oldNo++;
          newNo++;
          curHunk.push({ type: "context", oldNo, newNo, content: line.slice(1) });
        }
      } else if (line.startsWith("\\") && curHunk) {
        curHunk.push({ type: "meta", oldNo: null, newNo: null, content: line });
      }
    }
    if (cur) files.push(cur);
    return files;
  });

  /** The diff for the currently selected file (or all if none selected). */
  const visibleDiff = $derived.by<DiffFile | null>(() => {
    if (diffFiles.length === 0) return null;
    if (!selectedFile) return diffFiles[0];
    return diffFiles.find((f) => f.path === selectedFile) || diffFiles[0];
  });

  async function loadAll() {
    if (!workspaceRoot) return;
    loading = true;
    error = null;
    const root = encodeURIComponent(workspaceRoot);
    try {
      const [statusRes, logRes] = await Promise.all([
        fetch(`/api/git/status?root=${root}`),
        fetch(`/api/files/history/git?root=${root}&limit=50`),
      ]);
      if (statusRes.ok) {
        const sd = await statusRes.json();
        status = sd.status || "";
        branch = sd.branch || "";
        remote = sd.remote || "";
        aheadBehind = sd.aheadBehind || "";
      }
      if (logRes.ok) {
        const ld = await logRes.json();
        commits = ld.commits || [];
      }
      // Auto-select first changed file
      if (!selectedFile && fileChanges.length > 0) {
        selectedFile = fileChanges[0].path;
      }
      await loadDiff(selectedFile);
    } catch {
      error = "Failed to load git state";
    }
    loading = false;
  }

  async function loadDiff(file: string | null) {
    if (!workspaceRoot) {
      rawDiff = "";
      return;
    }
    const root = encodeURIComponent(workspaceRoot);
    const fileParam = file ? `&file=${encodeURIComponent(file)}` : "";
    try {
      const res = await fetch(`/api/git/diff?root=${root}${fileParam}`);
      if (res.ok) {
        const data = await res.json();
        rawDiff = data.diff || "";
      }
    } catch {
      rawDiff = "";
    }
  }

  function selectFile(path: string) {
    selectedFile = path;
    loadDiff(path);
  }

  async function commit() {
    if (!workspaceRoot || !commitMsg.trim() || committing) return;
    committing = true;
    error = null;
    try {
      const res = await fetch("/api/git/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: workspaceRoot, message: commitMsg.trim() }),
      });
      if (res.ok) {
        commitMsg = "";
        showCommit = false;
        selectedFile = null;
        await loadAll();
      } else {
        const data = await res.json();
        error = data.error || "Commit failed";
      }
    } catch {
      error = "Commit failed";
    }
    committing = false;
  }

  function fileStatusColor(code: string): string {
    const c = code.trim();
    if (c === "M") return "var(--color-warning)";
    if (c === "A") return "var(--color-success)";
    if (c === "D") return "var(--color-error)";
    if (c === "?") return "var(--color-muted)";
    if (c === "R") return "var(--color-accent)";
    return "var(--color-muted)";
  }

  function fileStatusLabel(code: string): string {
    const c = code.trim();
    if (c === "M") return "M";
    if (c === "A") return "A";
    if (c === "D") return "D";
    if (c === "?") return "U";
    if (c === "R") return "R";
    if (c === "C") return "C";
    return c || "·";
  }

  function fileIcon(name: string) {
    const ext = name.split(".").pop()?.toLowerCase() || "";
    const codeExts = ["ts", "js", "tsx", "jsx", "svelte", "vue", "py", "rs", "go", "java", "c", "cpp", "h", "rb", "php", "swift", "kt", "css", "scss", "html"];
    return codeExts.includes(ext) ? IconFileCode : IconFile;
  }

  function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    const d = new Date(ts);
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  $effect(() => {
    const _ = workspaceRoot;
    loadAll();
  });
</script>

<div class="gh-panel flex flex-col overflow-hidden h-full">
  <!-- Header -->
  <div class="gh-header">
    <div class="flex items-center gap-2 min-w-0">
      <IconBrandGithub size={16} style="color: var(--color-text); flex-shrink: 0;" />
      <span class="gh-repo-name truncate">{repoName || "no remote"}</span>
      {#if branch}
        <span class="gh-branch">
          <IconGitBranch size={11} />
          {branch}
        </span>
      {/if}
    </div>
    <div class="flex items-center gap-1.5 flex-shrink-0">
      {#if ahead > 0}
        <span class="gh-ab ahead" title="ahead of upstream"><IconPlus size={10} />{ahead}</span>
      {/if}
      {#if behind > 0}
        <span class="gh-ab behind" title="behind upstream"><IconMinus size={10} />{behind}</span>
      {/if}
      <button class="gh-refresh" onclick={loadAll} title="Refresh" aria-label="Refresh git state">
        <IconRefresh size={13} />
      </button>
    </div>
  </div>

  <!-- View tabs -->
  <div class="gh-tabs">
    <button class="gh-tab" class:active={view === "changes"} onclick={() => (view = "changes")}>
      <IconFileDiff size={12} />
      Changes
      {#if fileChanges.length > 0}<span class="gh-tab-count">{fileChanges.length}</span>{/if}
    </button>
    <button class="gh-tab" class:active={view === "history"} onclick={() => (view = "history")}>
      <IconGitCommit size={12} />
      History
      {#if commits.length > 0}<span class="gh-tab-count">{commits.length}</span>{/if}
    </button>
  </div>

  {#if error}
    <div class="gh-error"><IconAlertTriangle size={12} /> {error}</div>
  {/if}

  {#if view === "changes"}
    <!-- Two-pane: file browser (left) + diff viewer (right) -->
    <div class="gh-split flex-1 flex overflow-hidden min-h-0">
      <!-- Left: file browser -->
      <div class="gh-file-browser flex flex-col overflow-hidden">
        <div class="gh-browser-header">
          <span>Changed files</span>
          <span class="gh-browser-meta">
            {#if stagedCount > 0}<span class="staged">{stagedCount} staged</span>{/if}
            {#if unstagedCount > 0}<span class="unstaged">{unstagedCount} unstaged</span>{/if}
          </span>
        </div>
        <div class="gh-browser-body flex-1 overflow-y-auto">
          {#if loading && fileChanges.length === 0}
            <div class="gh-browser-empty">Loading…</div>
          {:else if fileChanges.length === 0}
            <div class="gh-browser-empty">
              <IconCheck size={20} style="color: var(--color-success); opacity: 0.5;" />
              <div>Working tree clean</div>
            </div>
          {:else}
            {#each sortedChildren(fileTree) as node (node.path)}
              {@render renderNode(node, 0)}
            {/each}
          {/if}
        </div>

        <!-- Commit form at bottom of file browser -->
        {#if showCommit}
          <div class="gh-commit-form">
            <input
              type="text"
              bind:value={commitMsg}
              placeholder="Commit message…"
              class="gh-commit-input"
              onkeydown={(e) => e.key === "Enter" && commit()}
            />
            <div class="flex gap-1.5">
              <button class="gh-commit-btn" onclick={commit} disabled={!commitMsg.trim() || committing}>
                {#if committing}<IconRefresh size={11} class="animate-spin" />{:else}<IconGitCommit size={11} />{/if}
                {committing ? "…" : "Commit"}
              </button>
              <button class="gh-cancel-btn" onclick={() => (showCommit = false)}>Cancel</button>
            </div>
          </div>
        {:else if fileChanges.length > 0}
          <button class="gh-commit-cta" onclick={() => (showCommit = true)}>
            <IconGitCommit size={13} />
            Checkpoint {fileChanges.length} change{fileChanges.length !== 1 ? "s" : ""}
          </button>
        {/if}
      </div>

      <!-- Right: diff viewer -->
      <div class="gh-diff-viewer flex flex-col overflow-hidden flex-1 min-w-0">
        {#if visibleDiff}
          <div class="gh-diff-header">
            <IconFileDiff size={13} style="color: var(--color-accent); flex-shrink: 0;" />
            <span class="gh-diff-path truncate">{visibleDiff.path}</span>
            {#if visibleDiff.hunks.length > 0}
              {@const adds = visibleDiff.hunks.flat().filter((l) => l.type === "add").length}
              {@const dels = visibleDiff.hunks.flat().filter((l) => l.type === "del").length}
              <span class="gh-diff-stats">
                <span class="gh-stat-add">+{adds}</span>
                <span class="gh-stat-del">−{dels}</span>
              </span>
            {/if}
          </div>
          <div class="gh-diff-body flex-1 overflow-y-auto">
            {#if visibleDiff.hunks.length === 0}
              <div class="gh-diff-empty">No textual diff (binary or mode change)</div>
            {:else}
              {#each visibleDiff.hunks as hunk, hi (hi)}
                <div class="gh-hunk-header">{hunk[0]?.content}</div>
                {#each hunk.slice(1) as line, li (li)}
                  <div class="gh-diff-line {line.type}">
                    <span class="gh-line-no old">{line.oldNo ?? ""}</span>
                    <span class="gh-line-no new">{line.newNo ?? ""}</span>
                    <span class="gh-line-sign">
                      {#if line.type === "add"}+{:else if line.type === "del"}−{:else if line.type === "meta"}\{:else} {/if}
                    </span>
                    <span class="gh-line-content">{line.content}</span>
                  </div>
                {/each}
              {/each}
            {/if}
          </div>
        {:else if loading}
          <div class="gh-diff-empty">Loading diff…</div>
        {:else}
          <div class="gh-diff-empty">
            <IconFileDiff size={28} style="opacity: 0.25;" />
            <div>Select a file to view its diff</div>
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <!-- History view: commit list -->
    <div class="gh-history flex-1 overflow-y-auto">
      {#if commits.length === 0}
        <div class="gh-browser-empty">
          <IconGitCommit size={20} style="opacity: 0.3;" />
          <div>No commits yet</div>
        </div>
      {:else}
        {#each commits.slice(0, 50) as c (c.hash)}
          <div class="gh-commit-row">
            <div class="gh-commit-dot">
              <IconCircleDot size={8} style="color: rgb(240, 170, 90);" />
            </div>
            <div class="gh-commit-body min-w-0">
              <div class="gh-commit-top">
                <span class="gh-commit-hash">{c.shortHash}</span>
                <span class="gh-commit-msg truncate">{c.message}</span>
              </div>
              <div class="gh-commit-bottom">
                <span class="gh-commit-author">{c.author}</span>
                <span class="gh-commit-time">{relativeTime(c.timestamp)}</span>
              </div>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>

{#snippet renderNode(node: TreeNode, depth: number)}
  {#if node.isDir}
    <button
      class="gh-tree-dir"
      style="padding-left: {depth * 0.7 + 0.3}rem;"
      onclick={() => toggleDir(node.path)}
    >
      {#if expandedDirs.has(node.path)}
        <IconChevronDown size={10} class="flex-shrink-0 opacity-50" />
      {:else}
        <IconChevronRight size={10} class="flex-shrink-0 opacity-50" />
      {/if}
      <IconFolder size={13} style="color: var(--color-muted); flex-shrink: 0;" />
      <span class="truncate">{node.name}</span>
      <span class="gh-tree-count">{[...node.children.values()].length}</span>
    </button>
    {#if expandedDirs.has(node.path)}
      {#each sortedChildren(node) as child (child.path)}
        {@render renderNode(child, depth + 1)}
      {/each}
    {/if}
  {:else}
    <button
      class="gh-tree-file"
      class:selected={selectedFile === node.path}
      style="padding-left: {depth * 0.7 + 0.3}rem;"
      onclick={() => selectFile(node.path)}
      title={node.path}
    >
      <span class="gh-tree-spacer"></span>
      <svelte:component this={fileIcon(node.name)} size={13} style="color: var(--color-muted); flex-shrink: 0;" />
      <span class="gh-tree-fname truncate">{node.name}</span>
      <span class="gh-file-code" style="color: {fileStatusColor(node.file?.code || "")}; border-color: {fileStatusColor(node.file?.code || "")};">
        {fileStatusLabel(node.file?.code || "")}
      </span>
    </button>
  {/if}
{/snippet}

<style>
  .gh-panel {
    font-size: 0.8125rem;
  }

  .gh-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid rgba(var(--muted-rgb), 0.15);
    background: rgba(var(--bg-deep-rgb), 0.3);
    flex-shrink: 0;
  }

  .gh-repo-name {
    font-weight: 700;
    font-size: 0.8125rem;
    color: var(--color-text);
  }

  .gh-branch {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    background: rgba(var(--accent-rgb), 0.1);
    border: 1px solid rgba(var(--accent-rgb), 0.2);
    color: var(--color-accent);
    font-size: 0.6875rem;
    font-weight: 600;
    font-family: "JetBrains Mono", monospace;
    flex-shrink: 0;
  }

  .gh-ab {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
    font-size: 0.6875rem;
    font-weight: 700;
    font-family: "JetBrains Mono", monospace;
  }
  .gh-ab.ahead { background: rgba(120, 220, 150, 0.1); color: rgb(120, 220, 150); }
  .gh-ab.behind { background: rgba(255, 130, 130, 0.1); color: rgb(255, 130, 130); }

  .gh-refresh {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.2rem;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--color-muted);
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.15s, background 0.15s;
  }
  .gh-refresh:hover { opacity: 1; background: rgba(var(--muted-rgb), 0.1); }

  .gh-tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid rgba(var(--muted-rgb), 0.15);
    flex-shrink: 0;
  }

  .gh-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3rem 0.6rem;
    border-radius: 5px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--color-muted);
    font-size: 0.6875rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  .gh-tab:hover { background: rgba(var(--muted-rgb), 0.08); color: var(--color-text); }
  .gh-tab.active {
    color: var(--color-accent);
    background: rgba(var(--accent-rgb), 0.1);
    border-color: rgba(var(--accent-rgb), 0.25);
  }

  .gh-tab-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.1rem;
    height: 1.1rem;
    padding: 0 0.25rem;
    border-radius: 999px;
    background: rgba(var(--accent-rgb), 0.15);
    color: var(--color-accent);
    font-size: 0.625rem;
    font-weight: 700;
  }

  .gh-error {
    padding: 0.4rem 0.75rem;
    font-size: 0.6875rem;
    color: var(--color-error);
    display: flex;
    align-items: center;
    gap: 0.3rem;
    background: rgba(255, 130, 130, 0.05);
    flex-shrink: 0;
  }

  /* === Two-pane split === */
  .gh-split {
    min-height: 0;
  }

  /* File browser (left) */
  .gh-file-browser {
    width: 240px;
    flex-shrink: 0;
    border-right: 1px solid rgba(var(--muted-rgb), 0.15);
    min-width: 0;
  }

  .gh-browser-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.35rem 0.6rem;
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-muted);
    border-bottom: 1px solid rgba(var(--muted-rgb), 0.1);
    flex-shrink: 0;
  }

  .gh-browser-meta {
    display: inline-flex;
    gap: 0.4rem;
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
  }
  .gh-browser-meta .staged { color: var(--color-success); }
  .gh-browser-meta .unstaged { color: var(--color-warning); }

  .gh-browser-body {
    padding: 0.2rem 0;
  }

  .gh-browser-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 1.5rem 1rem;
    color: var(--color-muted);
    font-size: 0.6875rem;
    text-align: center;
    opacity: 0.6;
  }

  /* Tree nodes */
  .gh-tree-dir,
  .gh-tree-file {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    width: 100%;
    padding: 0.2rem 0.4rem;
    padding-right: 0.5rem;
    border: none;
    background: transparent;
    cursor: pointer;
    text-align: left;
    font-size: 0.6875rem;
    color: var(--color-text);
    transition: background 0.1s;
  }
  .gh-tree-dir:hover,
  .gh-tree-file:hover {
    background: rgba(var(--muted-rgb), 0.08);
  }
  .gh-tree-file.selected {
    background: rgba(var(--accent-rgb), 0.14);
    box-shadow: inset 2px 0 0 var(--color-accent);
  }

  .gh-tree-spacer {
    width: 10px;
    flex-shrink: 0;
  }

  .gh-tree-fname {
    flex: 1;
    min-width: 0;
    font-family: "JetBrains Mono", monospace;
    opacity: 0.9;
  }

  .gh-tree-count {
    font-size: 0.625rem;
    color: var(--color-muted);
    opacity: 0.6;
    flex-shrink: 0;
  }

  .gh-file-code {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.1rem;
    height: 1.1rem;
    border-radius: 3px;
    border: 1px solid;
    font-size: 0.5625rem;
    font-weight: 700;
    font-family: "JetBrains Mono", monospace;
    flex-shrink: 0;
  }

  /* Commit form */
  .gh-commit-form {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.5rem;
    border-top: 1px solid rgba(var(--muted-rgb), 0.15);
    background: rgba(var(--bg-deep-rgb), 0.3);
    flex-shrink: 0;
  }

  .gh-commit-input {
    width: 100%;
    padding: 0.35rem 0.45rem;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: rgba(var(--bg-deep-rgb), 0.6);
    color: var(--color-text);
    font-size: 0.6875rem;
    font-family: "JetBrains Mono", monospace;
    outline: none;
  }
  .gh-commit-input:focus {
    border-color: var(--color-accent);
    box-shadow: var(--glow-accent);
  }

  .gh-commit-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.3rem 0.6rem;
    border-radius: 4px;
    border: 1px solid var(--color-accent);
    background: linear-gradient(120deg, var(--color-accent), var(--color-accent-secondary));
    color: var(--color-bg);
    font-size: 0.625rem;
    font-weight: 700;
    cursor: pointer;
  }
  .gh-commit-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .gh-cancel-btn {
    padding: 0.3rem 0.5rem;
    border-radius: 4px;
    border: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-muted);
    font-size: 0.625rem;
    font-weight: 600;
    cursor: pointer;
  }
  .gh-cancel-btn:hover { background: rgba(var(--muted-rgb), 0.08); }

  .gh-commit-cta {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    padding: 0.4rem 0.5rem;
    border-radius: 0;
    border: none;
    border-top: 1px solid rgba(var(--accent-rgb), 0.3);
    background: rgba(var(--accent-rgb), 0.08);
    color: var(--color-accent);
    font-size: 0.6875rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
    flex-shrink: 0;
  }
  .gh-commit-cta:hover { background: rgba(var(--accent-rgb), 0.15); }

  /* === Diff viewer (right) === */
  .gh-diff-viewer {
    min-width: 0;
  }

  .gh-diff-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid rgba(var(--muted-rgb), 0.15);
    background: rgba(var(--bg-deep-rgb), 0.3);
    flex-shrink: 0;
  }

  .gh-diff-path {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--color-text);
    flex: 1;
    min-width: 0;
  }

  .gh-diff-stats {
    display: inline-flex;
    gap: 0.3rem;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.625rem;
    font-weight: 700;
    flex-shrink: 0;
  }
  .gh-stat-add { color: rgb(120, 220, 150); }
  .gh-stat-del { color: rgb(255, 130, 130); }

  .gh-diff-body {
    font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 0.6875rem;
    line-height: 1.5;
    background: rgba(var(--bg-deep-rgb), 0.35);
  }

  .gh-diff-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem 1rem;
    color: var(--color-muted);
    font-size: 0.75rem;
    text-align: center;
    opacity: 0.5;
    height: 100%;
  }

  .gh-hunk-header {
    padding: 0.2rem 0.6rem;
    font-size: 0.625rem;
    color: var(--color-accent);
    background: rgba(var(--accent-rgb), 0.06);
    border-top: 1px solid rgba(var(--accent-rgb), 0.15);
    border-bottom: 1px solid rgba(var(--accent-rgb), 0.15);
    font-family: "JetBrains Mono", monospace;
    white-space: pre;
    overflow-x: auto;
  }

  .gh-diff-line {
    display: flex;
    align-items: flex-start;
    padding: 0 0.6rem;
    min-height: 1.5em;
  }
  .gh-diff-line:hover { background: rgba(var(--accent-rgb), 0.04); }

  .gh-diff-line.context { color: var(--color-text); opacity: 0.7; }
  .gh-diff-line.add {
    background: rgba(80, 200, 120, 0.1);
    color: rgb(140, 230, 170);
  }
  .gh-diff-line.del {
    background: rgba(255, 85, 85, 0.1);
    color: rgb(255, 150, 150);
  }
  .gh-diff-line.meta {
    color: var(--color-muted);
    opacity: 0.5;
    font-style: italic;
  }

  .gh-line-no {
    width: 2.5rem;
    flex-shrink: 0;
    text-align: right;
    padding-right: 0.4rem;
    font-size: 0.625rem;
    color: var(--color-muted);
    opacity: 0.5;
    user-select: none;
  }

  .gh-line-sign {
    width: 0.8rem;
    flex-shrink: 0;
    text-align: center;
    font-weight: 700;
    user-select: none;
  }
  .gh-diff-line.add .gh-line-sign { color: rgb(120, 220, 150); }
  .gh-diff-line.del .gh-line-sign { color: rgb(255, 130, 130); }

  .gh-line-content {
    flex: 1;
    white-space: pre-wrap;
    word-break: break-all;
    min-width: 0;
  }

  /* === History view === */
  .gh-history {
    padding: 0.5rem 0.75rem;
  }

  .gh-commit-row {
    display: flex;
    gap: 0.5rem;
    padding: 0.3rem 0;
    position: relative;
  }
  .gh-commit-row:not(:last-child)::after {
    content: "";
    position: absolute;
    left: 4px;
    top: 1.4rem;
    bottom: -0.1rem;
    width: 1px;
    background: rgba(var(--muted-rgb), 0.15);
  }

  .gh-commit-dot { flex-shrink: 0; margin-top: 0.15rem; z-index: 1; }
  .gh-commit-body { flex: 1; min-width: 0; }
  .gh-commit-top { display: flex; align-items: center; gap: 0.4rem; }

  .gh-commit-hash {
    font-size: 0.625rem;
    font-family: "JetBrains Mono", monospace;
    color: rgb(240, 170, 90);
    font-weight: 700;
    flex-shrink: 0;
  }

  .gh-commit-msg {
    font-size: 0.6875rem;
    color: var(--color-text);
    opacity: 0.85;
  }

  .gh-commit-bottom {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.1rem;
  }

  .gh-commit-author {
    font-size: 0.625rem;
    color: var(--color-muted);
    font-family: "JetBrains Mono", monospace;
  }

  .gh-commit-time {
    font-size: 0.625rem;
    color: var(--color-muted);
    opacity: 0.6;
  }
</style>
