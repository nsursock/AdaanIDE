<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from "svelte";
  import { workspaceStore, THEMES } from "@adaan/core";
  import { EditorState, Compartment, StateEffect, StateField } from "@codemirror/state";
  import { EditorView, keymap, Decoration, type DecorationSet } from "@codemirror/view";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { python } from "@codemirror/lang-python";
  import { javascript } from "@codemirror/lang-javascript";
  import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
  import { tags } from "@lezer/highlight";
  import { themeStore } from "@adaan/core";
  import {
    IconCode,
    IconFileCode,
    IconChevronRight,
    IconCheck,
    IconAlertCircle,
    IconSparkles,
    IconKeyboard,
  } from "@tabler/icons-svelte";

  const dispatch = createEventDispatcher();

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

  onDestroy(() => {
    if (view) view.destroy();
  });

  const pathParts = $derived(workspaceStore.activeTab?.path.split("/").filter(Boolean) || []);
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
