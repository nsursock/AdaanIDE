<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from "svelte";
  import { workspaceStore, THEMES, diffStats, type DiffLine } from "@adaan/core";
  import { EditorState, Compartment, StateEffect, StateField } from "@codemirror/state";
  import { EditorView, keymap, Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { python } from "@codemirror/lang-python";
  import { javascript } from "@codemirror/lang-javascript";
  import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
  import { tags } from "@lezer/highlight";
  import { themeStore } from "@adaan/core";
  import HistoryPanel from "./HistoryPanel.svelte";
  import {
    IconCode,
    IconFileCode,
    IconChevronRight,
    IconCheck,
    IconAlertCircle,
    IconSparkles,
    IconKeyboard,
    IconPlus,
    IconMinus,
    IconX,
  } from "@tabler/icons-svelte";

  const dispatch = createEventDispatcher();
  let { workspaceRoot }: { workspaceRoot: string | null } = $props();

  let editorDiv: HTMLDivElement;
  let view: EditorView | null = null;
  const themeCompartment = new Compartment();
  const langCompartment = new Compartment();

  // --- Line flash highlight for agent patches ---
  const flashEffect = StateEffect.define<number[]>();

  const flashField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (deco, tr) => {
      const effect = tr.effects.find((e) => e.is(flashEffect));
      if (effect) {
        // Build line decorations for each changed line
        const lines = effect.value;
        const decos = lines.map((lineNum) =>
          Decoration.line({ class: "cm-flash-line" }).range(
            tr.state.doc.line(Math.min(lineNum, tr.state.doc.lines)).from
          )
        );
        // Clear after 2.5s
        setTimeout(() => {
          if (view) view.dispatch({ effects: flashEffect.of([]) });
        }, 2500);
        return Decoration.set(decos, true);
      }
      // Clear decorations on doc change
      if (tr.docChanged) return Decoration.none;
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // --- Persistent add/modify/remove diff highlight, shown until the user
  // Accepts or Rejects the agent's change (unlike the transient flash above). ---
  class RemovedLineWidget extends WidgetType {
    text: string;
    constructor(text: string) {
      super();
      this.text = text;
    }
    eq(other: RemovedLineWidget) {
      return other.text === this.text;
    }
    toDOM() {
      const div = document.createElement("div");
      div.className = "cm-diff-remove-widget";
      div.textContent = this.text.length > 0 ? this.text : " ";
      return div;
    }
    get estimatedHeight() {
      return 21;
    }
  }

  function buildDiffDecorations(diff: DiffLine[], state: EditorState) {
    const decos: any[] = [];
    const lastLine = state.doc.lines;
    for (const d of diff) {
      if (d.type === "add" && d.newLine !== undefined) {
        const line = state.doc.line(Math.min(d.newLine, lastLine));
        decos.push(Decoration.line({ class: "cm-diff-add" }).range(line.from));
      } else if (d.type === "modify" && d.newLine !== undefined) {
        const line = state.doc.line(Math.min(d.newLine, lastLine));
        decos.push(Decoration.line({ class: "cm-diff-modify" }).range(line.from));
      } else if (d.type === "remove") {
        const anchorNum = Math.min(Math.max(d.newLine ?? 1, 1), lastLine);
        const anchor = state.doc.line(anchorNum);
        decos.push(
          Decoration.widget({ widget: new RemovedLineWidget(d.content), side: -1, block: true }).range(anchor.from)
        );
      }
    }
    return Decoration.set(decos, true);
  }

  const diffEffect = StateEffect.define<DiffLine[]>();

  const diffField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update: (deco, tr) => {
      const effect = tr.effects.find((e) => e.is(diffEffect));
      if (effect) return buildDiffDecorations(effect.value, tr.state);
      if (tr.docChanged) return Decoration.none;
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  let cursorLine = $state(1);
  let cursorCol = $state(1);
  let totalLines = $state(1);

  function getLangExtension(path: string) {
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext === "py") return python();
    if (ext === "js" || ext === "mjs" || ext === "cjs") return javascript();
    if (ext === "ts" || ext === "tsx" || ext === "jsx") return javascript({ typescript: true });
    return javascript();
  }

  function getLangName(path: string) {
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext === "py") return "PYTHON";
    if (ext === "ts" || ext === "tsx") return "TYPESCRIPT";
    if (ext === "js" || ext === "jsx") return "JAVASCRIPT";
    if (ext === "svelte") return "SVELTE";
    if (ext === "json") return "JSON";
    if (ext === "css") return "CSS";
    if (ext === "html") return "HTML";
    if (ext === "md") return "MARKDOWN";
    return "PLAINTEXT";
  }

  function getHighlightStyle() {
    const theme = THEMES[themeStore.current];
    return HighlightStyle.define([
      { tag: tags.keyword, color: theme.syntax.keyword },
      { tag: tags.string, color: theme.syntax.string },
      { tag: tags.comment, color: theme.syntax.comment, fontStyle: "italic" },
      { tag: tags.number, color: theme.syntax.number },
      { tag: tags.variableName, color: theme.syntax.variable },
      { tag: tags.function(tags.variableName), color: theme.syntax.function },
      { tag: tags.typeName, color: theme.syntax.type },
      { tag: tags.operator, color: theme.syntax.operator },
      { tag: tags.propertyName, color: theme.syntax.variable },
      { tag: tags.definition(tags.variableName), color: theme.syntax.function },
    ]);
  }

  function getEditorTheme() {
    return EditorView.theme({
      "&": {
        backgroundColor: "transparent",
        color: "var(--color-text)",
        height: "100%",
        fontFamily: '"JetBrains Mono", monospace',
      },
      ".cm-content": {
        caretColor: "var(--color-accent)",
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: "13px",
        lineHeight: "1.6",
        padding: "8px 0",
      },
      ".cm-gutters": {
        backgroundColor: "rgba(var(--bg-deep-rgb), 0.35)",
        color: "var(--color-muted)",
        borderRight: "1px solid var(--color-border)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "rgba(var(--accent-rgb), 0.12)",
        color: "var(--color-accent)",
        fontWeight: "bold",
      },
      ".cm-activeLine": {
        backgroundColor: "rgba(var(--accent-rgb), 0.04)",
      },
      "&.cm-focused .cm-selectionBackground, ::selection": {
        backgroundColor: "var(--color-selection)",
      },
      ".cm-cursor": {
        borderLeft: "2px solid var(--color-accent)",
        boxShadow: "0 0 8px var(--color-accent-glow)",
      },
    });
  }

  function updateCursorStats(state: EditorState) {
    const pos = state.selection.main.head;
    const line = state.doc.lineAt(pos);
    cursorLine = line.number;
    cursorCol = pos - line.from + 1;
    totalLines = state.doc.lines;
  }

  function createState(doc: string, path: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        keymap.of([{
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            if (view) {
              const tab = workspaceStore.activeTab;
              if (tab) {
                dispatch("save", { path: tab.path, content: view.state.doc.toString(), hash: tab.hash });
              }
            }
            return true;
          },
        }]),
        langCompartment.of(getLangExtension(path)),
        themeCompartment.of([syntaxHighlighting(getHighlightStyle()), getEditorTheme()]),
        flashField,
        diffField,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const tab = workspaceStore.activeTab;
            if (tab) {
              tab.content = update.state.doc.toString();
              tab.dirty = true;
            }
          }
          if (update.selectionSet || update.docChanged) {
            updateCursorStats(update.state);
          }
        }),
      ],
    });
  }

  function initEditor() {
    if (!editorDiv) return;
    const tab = workspaceStore.activeTab;
    if (!tab) {
      if (view) {
        view.destroy();
        view = null;
      }
      return;
    }

    if (!view) {
      const state = createState(tab.content, tab.path);
      view = new EditorView({
        state,
        parent: editorDiv,
      });
      updateCursorStats(state);
    } else {
      const currentDoc = view.state.doc.toString();
      if (currentDoc !== tab.content) {
        const state = createState(tab.content, tab.path);
        view.setState(state);
        updateCursorStats(state);
      }
    }
  }

  $effect(() => {
    const tab = workspaceStore.activeTab;
    if (tab) {
      initEditor();
    } else if (view) {
      view.destroy();
      view = null;
    }
  });

  $effect(() => {
    const _ = themeStore.current;
    if (view) {
      view.dispatch({
        effects: themeCompartment.reconfigure([syntaxHighlighting(getHighlightStyle()), getEditorTheme()]),
      });
    }
  });

  // Watch for agent patch signals — flash changed lines in the editor
  $effect(() => {
    const signal = workspaceStore.patchSignal;
    if (!signal || !view) return;
    // Only flash if the patched file is the active tab
    if (workspaceStore.activeTabPath !== signal.path) return;
    view.dispatch({ effects: flashEffect.of(signal.changedLines) });
  });

  // Render persistent add/modify/remove diff decorations while the active
  // tab has a pending (un-reviewed) agent edit. Cleared on Accept/Reject.
  $effect(() => {
    const path = workspaceStore.activeTabPath;
    const pending = path ? workspaceStore.pendingChanges[path] : undefined;
    if (!view) return;
    if (!pending) {
      view.dispatch({ effects: diffEffect.of([]) });
      return;
    }
    if (workspaceStore.activeTabPath !== pending.path) return;
    view.dispatch({ effects: diffEffect.of(pending.diff) });
  });

  onDestroy(() => {
    if (view) view.destroy();
  });

  const pathParts = $derived(workspaceStore.activeTab?.path.split("/").filter(Boolean) || []);

  // --- Accept / Reject handlers ---
  // Accept = drop the pending entry; the agent-written content already on
  // disk stays. Reject = write the pre-agent content back to disk, then drop
  // the pending entry. Both bubble a "save" up to the parent so the tab's
  // hash is refreshed and the editor re-syncs.
  async function acceptChange(path: string) {
    workspaceStore.acceptChange(path);
    // No disk write needed — the current content is already the accepted one.
    // Refresh the tab's hash from disk in case it drifted.
    const tab = workspaceStore.openTabs.find((t) => t.path === path);
    if (tab) dispatch("save", { path, content: tab.content, hash: tab.hash });
  }

  async function rejectChange(path: string) {
    const pending = workspaceStore.pendingChanges[path];
    if (!pending) return;
    // Write the pre-agent content back. expectedHash = the agent-written
    // hash (the current on-disk hash), so the optimistic-concurrency check
    // in writeFile passes.
    dispatch("save", { path, content: pending.beforeContent, hash: pending.afterHash });
    // Update the tab to the reverted content and drop the pending entry.
    const tab = workspaceStore.openTabs.find((t) => t.path === path);
    if (tab) {
      tab.content = pending.beforeContent;
      tab.hash = pending.beforeHash;
      tab.dirty = false;
    }
    workspaceStore.acceptChange(path); // removes the pending entry
  }

  async function acceptAll() {
    for (const path of Object.keys(workspaceStore.pendingChanges)) {
      await acceptChange(path);
    }
    workspaceStore.acceptAllChanges();
  }

  async function rejectAll() {
    for (const path of Object.keys(workspaceStore.pendingChanges)) {
      await rejectChange(path);
    }
  }

  const activePending = $derived(
    workspaceStore.activeTabPath ? workspaceStore.pendingChanges[workspaceStore.activeTabPath] : undefined,
  );
  const activeStats = $derived(activePending ? diffStats(activePending.diff) : null);
  const anyPending = $derived(workspaceStore.hasPendingChanges);
</script>

<div class="flex-1 flex flex-col overflow-hidden relative">
  {#if workspaceStore.activeTab}
    <!-- Breadcrumbs & buffer status header -->
    <div class="editor-breadcrumbs">
      <div class="flex items-center gap-1.5 min-w-0 truncate">
        <IconFileCode size={13} class="text-[var(--color-accent)] flex-shrink-0" />
        {#each pathParts as part, idx}
          {#if idx > 0}
            <IconChevronRight size={11} class="opacity-40 flex-shrink-0" />
          {/if}
          <span class="crumb-segment truncate">{part}</span>
        {/each}
      </div>

      <div class="flex items-center gap-3 flex-shrink-0 pl-2">
        {#if workspaceStore.activeTab.dirty}
          <span class="inline-flex items-center gap-1 text-[var(--color-warning)] text-[0.625rem] font-bold tracking-wider uppercase">
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-warning)] shadow-[0_0_6px_var(--color-warning)] animate-pulse"></span>
            Modified [⌘S]
          </span>
        {:else}
          <span class="inline-flex items-center gap-1 text-[var(--color-success)] text-[0.625rem] font-medium tracking-wider uppercase opacity-80">
            <IconCheck size={12} />
            Synced
          </span>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Pending-change review toolbar: per-file Accept/Reject + Accept All -->
  {#if activePending && activeStats}
    <div class="diff-review-bar">
      <div class="flex items-center gap-2 min-w-0">
        <span class="diff-badge add"><IconPlus size={11} /> +{activeStats.added}</span>
        <span class="diff-badge modify">~{activeStats.modified}</span>
        <span class="diff-badge remove"><IconMinus size={11} /> −{activeStats.removed}</span>
        <span class="diff-review-label">Agent edit — review &amp; accept or reject</span>
      </div>
      <div class="flex items-center gap-1.5 flex-shrink-0">
        <button class="diff-btn reject" onclick={() => rejectChange(activePending.path)} title="Revert this file to its pre-agent content">
          <IconX size={12} /> Reject
        </button>
        <button class="diff-btn accept" onclick={() => acceptChange(activePending.path)} title="Keep the agent's changes to this file">
          <IconCheck size={12} /> Accept
        </button>
      </div>
    </div>
  {/if}
  {#if anyPending && !activePending}
    <!-- Other files have pending changes but the active tab doesn't —
         show a slim global bar so Accept All / Reject All are reachable. -->
    <div class="diff-review-bar slim">
      <div class="flex items-center gap-2 min-w-0">
        <span class="diff-review-label">{workspaceStore.pendingChangeCount} file{workspaceStore.pendingChangeCount === 1 ? '' : 's'} with unreviewed agent edits</span>
      </div>
      <div class="flex items-center gap-1.5 flex-shrink-0">
        <button class="diff-btn reject" onclick={rejectAll} title="Revert all agent edits across all files">
          <IconX size={12} /> Reject All
        </button>
        <button class="diff-btn accept" onclick={acceptAll} title="Keep all agent edits across all files">
          <IconCheck size={12} /> Accept All
        </button>
      </div>
    </div>
  {/if}
  {#if activePending && anyPending && workspaceStore.pendingChangeCount > 1}
    <!-- Active file has a pending change AND other files do too — append
         Accept All / Reject All next to the per-file buttons. -->
    <div class="diff-review-bar slim">
      <div class="flex items-center gap-2 min-w-0">
        <span class="diff-review-label">{workspaceStore.pendingChangeCount - 1} other file{workspaceStore.pendingChangeCount - 1 === 1 ? '' : 's'} with unreviewed edits</span>
      </div>
      <div class="flex items-center gap-1.5 flex-shrink-0">
        <button class="diff-btn reject" onclick={rejectAll} title="Revert all agent edits across all files">
          <IconX size={12} /> Reject All
        </button>
        <button class="diff-btn accept" onclick={acceptAll} title="Keep all agent edits across all files">
          <IconCheck size={12} /> Accept All
        </button>
      </div>
    </div>
  {/if}

  <!-- File version history (local GitHub-style timeline) -->
  <HistoryPanel {workspaceRoot} />

  <!-- Editor Container -->
  <div class="flex-1 overflow-hidden relative" bind:this={editorDiv}>
    {#if !workspaceStore.activeTab}
      <div class="editor-empty">
        <div class="reticle-ring">
          <div class="editor-empty-glyph">⌘</div>
        </div>

        <div class="space-y-1">
          <div class="hero-title text-2xl font-extrabold tracking-tight">AdaanIDE</div>
          <div class="editor-empty-hint">⟨ Neural Code Workspace ⟩</div>
        </div>

        <!-- Shortcuts Quick Cheat-Sheet -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2 max-w-sm w-full">
          <div class="feature-pill justify-between text-xs py-1.5 px-3">
            <span class="text-[var(--color-muted)]">Save Buffer</span>
            <kbd class="px-1.5 py-0.5 rounded bg-[rgba(var(--bg-deep-rgb),0.6)] border border-[var(--color-border)] text-[var(--color-accent)] font-bold">⌘S</kbd>
          </div>
          <div class="feature-pill justify-between text-xs py-1.5 px-3">
            <span class="text-[var(--color-muted)]">Prompt Agent</span>
            <kbd class="px-1.5 py-0.5 rounded bg-[rgba(var(--bg-deep-rgb),0.6)] border border-[var(--color-border)] text-[var(--color-accent)] font-bold">ENTER</kbd>
          </div>
        </div>
      </div>
    {/if}
  </div>

  {#if workspaceStore.activeTab}
    <!-- Futuristic Status Bar -->
    <div class="editor-status-bar">
      <div class="flex items-center gap-3">
        <span class="px-1.5 py-0.2 rounded bg-[rgba(var(--accent-rgb),0.1)] text-[var(--color-accent)] font-bold tracking-wider text-[0.625rem] border border-[rgba(var(--accent-rgb),0.25)]">
          {getLangName(workspaceStore.activeTab.path)}
        </span>
        <span class="opacity-75">UTF-8</span>
        <span class="opacity-75">Spaces: 2</span>
      </div>

      <div class="flex items-center gap-3 font-mono">
        <span>Ln {cursorLine}, Col {cursorCol}</span>
        <span class="opacity-50">/</span>
        <span>{totalLines} lines</span>
      </div>
    </div>
  {/if}
</div>
