# AdaanIDE

A coding IDE with file browser, code editor, and agentic chat. Built as a pnpm monorepo with a SvelteKit app consuming a shared core package.

## Structure

```
adaan-core/      # Shared non-UI logic (agent engine, workspace, tools, OpenRouter provider)
apps/futuristic/ # Futuristic UI (GSAP + Three.js, glassmorphism, port 5174)
```

## Commands

```bash
pnpm install                          # Install all deps
pnpm dev                              # Dev futuristic app (port 5174)
pnpm --filter @adaan/core test        # Run core tests (97 tests)
pnpm --filter @adaan/futuristic build # Build futuristic app
pnpm --filter @adaan/futuristic dev   # Dev futuristic (port 5174)
```

## Environment

Copy `.env.example` to `.env` and set `OPENROUTER_API_KEY`. A $10 credit on OpenRouter unlocks higher daily free-model limits.

## Architecture

- **Agent Engine**: FSM-based tool-calling loop with 4-iteration cap, context pruning, and session-based caching.
- **OpenRouter Provider**: Streaming SSE with tool-call accumulation, free-model rotation pool (LRU), and 429/503 failover.
- **Security**: Path traversal prevention (resolve + prefix check), symlink escape detection, hash-based optimistic concurrency for file writes, command deny-list.
- **Themes**: Retrowave, Ghibli, and Fiesta, with CodeMirror syntax highlighting swapped via extension compartments.
- **Three.js**: Background particle field in the futuristic app, toggleable via settings.
- **Settings**: Unified, versioned, persisted to a single `localStorage` blob (`adaan.settings.v1`). Covers theme, panel widths, selected model, and the Three.js toggle. Pure migration logic in `settings.ts` (testable, no runes); reactive store in `settings.svelte.ts`. `themeStore` and `chatStore` delegate persistence to `settingsStore`. Legacy per-feature keys are folded in on first run.

## Key Files

- `packages/adaan-core/src/server/agent/engine.ts` — Agent loop
- `packages/adaan-core/src/server/agent/providers/openrouter.ts` — Provider with FSM + rotation
- `packages/adaan-core/src/server/workspace.ts` — File operations with hash-based locking
- `packages/adaan-core/src/server/security.ts` — Path + command security
- `packages/adaan-core/src/stores/settings.ts` — Pure settings schema + migration logic (versioned, testable)
- `packages/adaan-core/src/stores/settings.svelte.ts` — Reactive settings store (single localStorage blob)
- `packages/adaan-core/src/stores/` — Svelte 5 rune stores (settings, theme, workspace, chat)
