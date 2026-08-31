# AdaanIDE

A browser-based coding IDE with a file browser, CodeMirror editor, and an autonomous agentic chat. Built as a pnpm monorepo: a shared core package (`@adaan/core`) holds the agent engine, workspace, and OpenRouter provider, while a SvelteKit app (`@adaan/futuristic`) delivers a futuristic glassmorphism UI with GSAP animations and an optional Three.js particle background.

## Features

- **Agentic chat** — A finite-state-machine tool-calling loop that streams responses over SSE, calls tools (read/write/patch/search/list/symbols/execute/tests/git checkpoint), and asks for human approval before risky operations.
- **Autonomous by default** — The system prompt is tuned to act on reasonable assumptions instead of asking clarifying questions, with an iteration cap and context pruning to stay bounded.
- **OpenRouter provider** — Streaming SSE with tool-call accumulation, a free-model rotation pool (LRU) with 429/503 failover, and a model picker that groups free vs. paid models.
- **File operations** — List, read, write, create, delete, search, and patch (diff-match-patch) with hash-based optimistic concurrency to prevent clobbering concurrent edits.
- **Security** — Path traversal prevention (resolve + prefix check), symlink escape detection, a command deny-list, and per-tool approval prompts.
- **CodeMirror editor** — Multi-tab editing with syntax highlighting swapped via extension compartments.
- **File watcher** — chokidar-based watcher broadcasting workspace events to the UI in real time.
- **Themes** — Retrowave, Ghibli, and Fiesta palettes with matching syntax colors.
- **Three.js background** — Toggleable particle field, off by default.

## Repository structure

```
packages/adaan-core/      # Shared non-UI logic (agent engine, workspace, tools, OpenRouter provider)
  src/
    server/
      agent/
        engine.ts         # FSM tool-calling loop
        context.ts        # Token estimation + message pruning
        cache.ts          # Session-based response caching
        session.ts        # Per-session state
        provider.ts       # Provider abstraction
        providers/
          openrouter.ts   # Streaming SSE + free-model rotation + failover
        tools/
          files.ts        # File read/write/patch/search/list/symbols
          registry.ts     # Tool registration + dispatch
          schema.ts       # Tool parameter schemas
      workspace.ts        # File ops with hash-based locking
      security.ts         # Path + command security
      watcher.ts          # chokidar file watcher
      routes.ts           # Shared route helpers
    stores/               # Svelte 5 rune stores (theme, workspace, chat)
    themes.ts             # Theme palettes
    types.ts              # Shared TypeScript types
  tests/                  # node:test suite (cache, context, rotation, sandbox, streaming, symbols, create)
apps/futuristic/          # SvelteKit app (port 5174)
  src/
    lib/components/       # ChatPanel, Editor, FileTree, DiffView, ToolCallCard, ModelPicker, ThemeSwitcher, ThreeBackground, ...
    routes/api/           # files, sessions, workspaces, models, workspace events
    hooks.server.ts       # Server hooks
```

## Getting started

### Prerequisites

- Node.js 20+
- pnpm 9+
- An [OpenRouter](https://openrouter.ai/keys) API key

### Install

```bash
pnpm install
```

### Configure environment

```bash
cp .env.example .env
# then edit .env and set OPENROUTER_API_KEY
```

A $10 lifetime credit on OpenRouter (it does not need to be spent) raises the free-model daily cap from 50 to 1,000 requests/day/model.

### Run the dev server

```bash
pnpm dev          # futuristic app on http://localhost:5174
```

### Scripts

| Command | Description |
| --- | --- |
| `pnpm install` | Install all workspace dependencies |
| `pnpm dev` | Dev server for the futuristic app (port 5174) |
| `pnpm build` | Build all packages and apps |
| `pnpm check` | Type-check all packages |
| `pnpm test` | Run the core test suite |
| `pnpm --filter @adaan/core test` | Run core tests directly |
| `pnpm --filter @adaan/futuristic build` | Build only the futuristic app |
| `pnpm --filter @adaan/futuristic dev` | Dev only the futuristic app |
| `pnpm build:core` | Build only the core package |

## Architecture

### Agent engine

The engine (`packages/adaan-core/src/server/agent/engine.ts`) runs a finite-state-machine tool-calling loop:

1. Build the message list (system prompt + pruned history + user turn).
2. Stream a completion from the provider, accumulating tool-call deltas.
3. Dispatch each completed tool call through the registry; emit `tool.start` / `tool.args` / `tool.result` / `tool.error` events.
4. Risky tools request approval via `tool.approval_required`; the session pauses until the user approves or cancels.
5. Append tool results to the conversation and loop until the model returns a non-tool finish or the iteration cap is hit.

Context is pruned between iterations (`context.ts`) to stay within the model's window, and identical tool calls are served from a session cache (`cache.ts`).

### OpenRouter provider

`providers/openrouter.ts` consumes OpenRouter's streaming SSE endpoint, accumulates tool-call arguments across deltas, and rotates through a pool of free models using an LRU eviction policy. On 429/503 it transparently fails over to the next free model before surfacing an error.

### Workspace & security

`workspace.ts` exposes file operations and enforces hash-based optimistic concurrency: every write/patch requires an `expectedHash` matching the file's current content. `security.ts` adds path traversal prevention (resolve + prefix check), symlink escape detection, and a command deny-list for the execute tool.

### UI

The futuristic app is a SvelteKit + Tailwind v4 app using Svelte 5 runes. GSAP drives entrance/transition animations, Three.js renders an optional particle field background, and CodeMirror 6 powers the editor with syntax highlighting swapped via extension compartments when the theme changes.

## Tech stack

- **Core**: TypeScript, chokidar, diff-match-patch
- **App**: SvelteKit 2, Svelte 5 (runes), Vite 5, Tailwind v4
- **Editor**: CodeMirror 6
- **Graphics**: Three.js, GSAP
- **Models**: OpenRouter
- **Tooling**: pnpm workspaces, node:test, tsx

## License

Private project. All rights reserved.
