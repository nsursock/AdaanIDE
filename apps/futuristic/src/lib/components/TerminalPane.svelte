<script lang="ts">
  import { fly } from "svelte/transition";
  import { cubicInOut } from "svelte/easing";
  import { workspaceStore, settingsStore, type FileNode } from "@adaan/core";
  import {
    IconTerminal2,
    IconTrash,
    IconChevronRight,
    IconArrowsHorizontal,
    IconColumnInsertLeft,
  } from "@tabler/icons-svelte";

  let { workspaceRoot, height = 220 }: { workspaceRoot: string; height?: number } = $props();

  type Entry = {
    command: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    denied: boolean;
  };

  let entries = $state<Entry[]>([]);
  let input = $state("");
  let running = $state(false);
  let history: string[] = [];
  let historyIndex = -1;
  let dragOver = $state(false);
  let scrollEl: HTMLDivElement;
  let inputEl: HTMLInputElement;

  const terminalMode = $derived(settingsStore.settings.terminalMode);

  // Strip ANSI escape sequences (colors, cursor moves) for clean rendering.
  const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][0AB]|\x1b[=>]/g;
  function stripAnsi(s: string): string {
    return s.replace(ANSI_RE, "");
  }

  function scrollToEnd() {
    requestAnimationFrame(() => {
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    });
  }

  // --- File path helpers (autocomplete + drag-drop) -------------------------

  /** Flatten the workspace tree into a sorted list of file paths. */
  function flattenFiles(nodes: FileNode[], out: string[] = []): string[] {
    for (const n of nodes) {
      if (n.type === "file") out.push(n.path);
      if (n.children) flattenFiles(n.children, out);
    }
    return out;
  }

  /** Quote a path if it contains whitespace or shell-special characters. */
  function quotePath(p: string): string {
    return /[\s'"$`&|<>!*?(){}#\~]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p;
  }

  /** Longest common prefix of a list of strings. */
  function commonPrefix(list: string[]): string {
    if (list.length === 0) return "";
    let pre = list[0];
    for (let i = 1; i < list.length; i++) {
      while (!list[i].startsWith(pre)) pre = pre.slice(0, -1);
      if (!pre) break;
    }
    return pre;
  }

  /** Tab completion: complete the last whitespace-delimited token against
   *  workspace file paths. Single match → full path; multiple → common prefix
   *  and the matches are echoed into the output log (like bash). */
  function tabComplete() {
    const value = input;
    const caret = inputEl?.selectionStart ?? value.length;
    // Work on the text up to the caret.
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const tokenMatch = before.match(/(\S+)$/);
    if (!tokenMatch) return; // nothing to complete at caret
    const partial = tokenMatch[1];
    const tokenStart = before.length - partial.length;

    const files = flattenFiles(workspaceStore.tree).sort();
    const matches = files.filter((p) => p.startsWith(partial));
    if (matches.length === 0) return;

    if (matches.length === 1) {
      const replacement = quotePath(matches[0]);
      input = before.slice(0, tokenStart) + replacement + after;
      const newCaret = tokenStart + replacement.length;
      requestAnimationFrame(() => inputEl?.setSelectionRange(newCaret, newCaret));
      return;
    }

    // Multiple matches: complete the common prefix and echo the options.
    const prefix = commonPrefix(matches);
    if (prefix.length > partial.length) {
      const replacement = quotePath(prefix);
      input = before.slice(0, tokenStart) + replacement + after;
      const newCaret = tokenStart + replacement.length;
      requestAnimationFrame(() => inputEl?.setSelectionRange(newCaret, newCaret));
    }
    // Show the candidate list as a non-command hint line.
    entries = [...entries, {
      command: "",
      stdout: matches.map((m) => "  " + m).join("\n"),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      denied: false,
    }];
    scrollToEnd();
  }

  // --- Drag & drop a file from the explorer ---------------------------------

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    const path = e.dataTransfer?.getData("application/x-adaan-path") || e.dataTransfer?.getData("text/plain");
    if (!path) return;
    const quoted = quotePath(path);
    // Insert at caret, or append with a separating space.
    const caret = inputEl?.selectionStart ?? input.length;
    const before = input.slice(0, caret);
    const after = input.slice(caret);
    const needSpace = before.length > 0 && !before.endsWith(" ");
    input = before + (needSpace ? " " : "") + quoted + after;
    const newCaret = before.length + (needSpace ? 1 : 0) + quoted.length;
    requestAnimationFrame(() => {
      inputEl?.focus();
      inputEl?.setSelectionRange(newCaret, newCaret);
    });
  }

  // --- Command execution ----------------------------------------------------

  async function run() {
    const cmd = input.trim();
    if (!cmd || running || !workspaceRoot) return;
    input = "";
    historyIndex = -1;
    if (history[history.length - 1] !== cmd) history.push(cmd);

    running = true;
    const entry = $state<Entry>({ command: cmd, stdout: "", stderr: "", exitCode: -1, timedOut: false, denied: false });
    entries = [...entries, entry];
    scrollToEnd();

    try {
      const res = await fetch("/api/terminal/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: workspaceRoot, command: cmd }),
      });
      const data = await res.json();
      entry.stdout = stripAnsi(data.stdout ?? "");
      entry.stderr = stripAnsi(data.stderr ?? "");
      entry.exitCode = data.exitCode ?? -1;
      entry.timedOut = !!data.timedOut;
      entry.denied = !!data.denied;
      if (!res.ok && data.error && !entry.stderr) entry.stderr = data.error;
    } catch (e) {
      entry.stderr = e instanceof Error ? e.message : "Network error";
      entry.exitCode = -1;
    } finally {
      running = false;
      scrollToEnd();
      inputEl?.focus();
    }
  }

  function clear() {
    entries = [];
  }

  function toggleMode() {
    settingsStore.setTerminalMode(terminalMode === "full" ? "editor" : "full");
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    } else if (e.key === "Tab") {
      e.preventDefault();
      tabComplete();
    } else if (e.key === "ArrowUp") {
      if (history.length === 0) return;
      e.preventDefault();
      if (historyIndex === -1) historyIndex = history.length - 1;
      else if (historyIndex > 0) historyIndex--;
      input = history[historyIndex];
    } else if (e.key === "ArrowDown") {
      if (history.length === 0 || historyIndex === -1) return;
      e.preventDefault();
      if (historyIndex < history.length - 1) {
        historyIndex++;
        input = history[historyIndex];
      } else {
        historyIndex = -1;
        input = "";
      }
    } else if (e.key === "l" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      clear();
    }
  }

  const promptName = $derived(workspaceRoot ? workspaceRoot.split("/").pop() || workspaceRoot : "~");
</script>

<div
  class="terminal-pane pane pane-bracketed flex flex-col overflow-hidden rounded-lg {dragOver ? 'is-dragover' : ''}"
  style="height: {height}px;"
  transition:fly={{ y: 40, duration: 240, easing: cubicInOut, opacity: 0 }}
  ondragover={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; dragOver = true; }}
  ondragleave={(e) => { if (e.target === e.currentTarget) dragOver = false; }}
  ondrop={onDrop}
  role="application"
  aria-label="Terminal"
>
  <header class="pane-header terminal-header">
    <div class="pane-title">
      <span class="pane-title-bar"></span>
      <IconTerminal2 size={13} class="text-[var(--color-accent)]" />
      <span class="kicker-tag">⌬ //</span>
      <span>Terminal</span>
      <span class="terminal-mode-tag">{terminalMode}</span>
    </div>
    <div class="flex items-center gap-1.5">
      {#if running}
        <span class="terminal-running"><span class="dot"></span> running</span>
      {/if}
      <button
        class="icon-btn"
        onclick={toggleMode}
        title="Toggle width: {terminalMode === 'full' ? 'full window' : 'editor column'} → {terminalMode === 'full' ? 'editor column' : 'full window'}"
        aria-label="Toggle terminal width mode"
      >
        {#if terminalMode === "full"}
          <IconColumnInsertLeft size={14} />
        {:else}
          <IconArrowsHorizontal size={14} />
        {/if}
      </button>
      <button class="icon-btn" onclick={clear} title="Clear (Ctrl+L)" aria-label="Clear terminal">
        <IconTrash size={14} />
      </button>
    </div>
  </header>

  <div class="terminal-output" bind:this={scrollEl} role="log" aria-live="polite">
    {#if entries.length === 0}
      <div class="terminal-empty">
        <IconTerminal2 size={22} class="opacity-40" />
        <span>Shell ready — type a command and press Enter.</span>
        <span class="opacity-60">cwd: {workspaceRoot || "—"}</span>
        <span class="opacity-50">drop a file from the explorer · Tab to complete</span>
      </div>
    {:else}
      {#each entries as e (e)}
        {#if e.command}
          <div class="term-line term-cmd">
            <span class="term-prompt">{promptName} <IconChevronRight size={11} class="term-chev" /></span>
            <span class="term-cmd-text">{e.command}</span>
          </div>
        {/if}
        {#if e.stdout}
          <pre class="term-line term-out">{e.stdout}</pre>
        {/if}
        {#if e.stderr}
          <pre class="term-line term-err">{e.stderr}</pre>
        {/if}
        {#if e.command && (e.exitCode !== 0 || e.timedOut || e.denied)}
          <div class="term-exit {e.denied || e.exitCode !== 0 ? 'is-error' : ''}">
            {#if e.denied}denied by security policy{:else if e.timedOut}timed out{:else}exit {e.exitCode}{/if}
          </div>
        {/if}
      {/each}
      {#if running}
        <div class="term-line term-cmd"><span class="term-cursor"></span></div>
      {/if}
    {/if}
  </div>

  <div class="terminal-input-row">
    <span class="term-prompt term-prompt-input">{promptName} <IconChevronRight size={11} class="term-chev" /></span>
    <input
      bind:this={inputEl}
      bind:value={input}
      onkeydown={onKeydown}
      class="terminal-input"
      placeholder={running ? "running…" : "type a command (↑/↓ history · Tab complete · drop a file)"}
      spellcheck="false"
      autocomplete="off"
      disabled={running}
    />
  </div>
</div>

<style>
  .terminal-pane {
    flex-shrink: 0;
    position: relative;
  }
  .terminal-pane.is-dragover {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 1px var(--color-accent), 0 0 24px var(--color-accent-glow), inset 0 0 0 1px rgba(var(--accent-rgb), 0.2);
  }
  .terminal-pane.is-dragover::after {
    content: "drop file to insert path";
    position: absolute;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(var(--bg-deep-rgb), 0.55);
    color: var(--color-accent);
    font-size: 0.75rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    pointer-events: none;
  }

  .terminal-header {
    padding: 0.35rem 0.75rem;
  }

  .terminal-mode-tag {
    font-size: 0.5625rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    background: rgba(var(--accent-rgb), 0.12);
    color: var(--color-accent);
    border: 1px solid rgba(var(--accent-rgb), 0.25);
  }

  .terminal-running {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.625rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-accent);
  }
  .terminal-running .dot {
    width: 6px; height: 6px; border-radius: 999px;
    background: var(--color-accent);
    box-shadow: 0 0 8px var(--color-accent);
    animation: dot-pulse 1.2s ease-in-out infinite;
  }

  .terminal-output {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0.4rem 0.75rem;
    background: rgba(var(--bg-deep-rgb), 0.55);
    font-size: 0.75rem;
    line-height: 1.45;
    color: var(--color-text);
    scrollbar-gutter: stable;
  }

  .terminal-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    height: 100%;
    color: var(--color-muted);
    font-size: 0.7rem;
    text-align: center;
  }

  .term-line {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: "JetBrains Mono", monospace;
  }
  .term-cmd {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    color: var(--color-text);
    margin-top: 0.35rem;
  }
  .term-cmd:first-child { margin-top: 0; }
  .term-cmd-text {
    color: var(--color-text);
    font-weight: 600;
  }
  .term-prompt {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    color: var(--color-accent);
    flex-shrink: 0;
    font-weight: 700;
  }
  :global(.term-chev) { opacity: 0.7; }
  .term-out { color: var(--color-text); opacity: 0.92; }
  .term-err { color: var(--color-error); }
  .term-exit {
    font-size: 0.625rem;
    color: var(--color-muted);
    padding-left: 0.1rem;
    margin-bottom: 0.15rem;
  }
  .term-exit.is-error { color: var(--color-error); }

  .term-cursor {
    display: inline-block;
    width: 7px; height: 0.95rem;
    background: var(--color-accent);
    box-shadow: 0 0 8px var(--color-accent-glow);
    animation: caret-blink 1s steps(1) infinite;
    vertical-align: text-bottom;
  }

  .terminal-input-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.75rem;
    border-top: 1px solid var(--color-border);
    background: linear-gradient(180deg, rgba(var(--surface-2-rgb), 0.5), rgba(var(--surface-1-rgb), 0.7));
  }
  .term-prompt-input { flex-shrink: 0; }
  .terminal-input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--color-text);
    font-size: 0.78rem;
    font-family: "JetBrains Mono", monospace;
  }
  .terminal-input::placeholder { color: var(--color-muted); opacity: 0.6; }
  .terminal-input:disabled { opacity: 0.5; }
</style>
