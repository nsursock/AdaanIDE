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
pnpm --filter @adaan/core test        # Run core tests (274 tests)
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
- **Telemetry**: Phase 1 "Measure" subsystem. Every LLM request and user task is instrumented — real token usage (parsed from OpenRouter's SSE `usage` chunk), cost, latency, request-type heuristic (planning/coding/debugging/final_response), tool classification (read/modify/command/test), cache hits, and context-pruning savings. Daily rollups double as the Phase 3 capability-matrix seed. Persisted to `~/.adaan/telemetry.json` (capped recent records + unbounded daily rollups, debounced writes). Dashboard via `TelemetryPanel.svelte` (app-bar chart icon) and `GET /api/telemetry/summary`; the killer metric is **successful tasks per 1,000 requests** (optimizes against OpenRouter's daily cap). Per-task footer (`7 reqs · 92k tokens · $0.031 · 84s · saved 12k ctx`) under each assistant message via the `task.summary` event.
- **Context Engine (Phase 2 "Reduce")**: (A1) Tool results are truncated to ~2000 tokens before entering conversation history — head ~70% + tail ~30% with an elision marker pointing at targeted re-reads; the full result still goes to the UI. (A2) Turn-aware pruning replaces the old one-message-at-a-time pruner — compacts old tool messages (stub replaces content, pairing stays valid), then drops oldest turns atomically (assistant + its tool results together) so no orphan `tool_call_id`s; always keeps the first user message (the task) and the last 2 turns. (A3) A workspace snapshot (file tree + stack hints + git status, ≤1500 tokens) is injected on the first request of a session, killing the common exploration `list_files` call. (B1) Repeat-failure guard blocks identical failed tool calls (cleared on any successful write). (B2) `apply_patch` returns `blocksApplied`/`linesAdded`/`linesDeleted`/`snippet`; `write_file`/`create_file` return `lines` — fewer verification re-reads. (C1) Workspace-level L2 read cache (LRU 200, TTL 5 min) shared across sessions, invalidated on writes and watcher events.
- **Adaptive Router (Phase 3 "Optimize")**: (9) Model registry persists the OpenRouter catalog to `~/.adaan/model-registry.json` (24h TTL) with tier assignment (free/mid/frontier by price percentile) and empirical stats merged from telemetry rollups. `GET /api/models/registry`. (10) A 100% local heuristic classifier (`classifyTask`) scores prompts on 6 dimensions (complexity, reasoning, coding, toolUse, contextNeeded, multiFile) and assigns a category (fix/test/refactor/greenfield/exploration/chat/workflow). The router (`routeModel`) picks the cheapest model likely to succeed within allowed tiers — free preferred at equal confidence, falls back to "any free tools-capable model" when no empirical data exists. Engine accepts `model: "auto"` → router decides; emits `model.routed` event; chat UI shows a pill (`auto → glm-5.2:free · category: fix`). Settings: routing mode toggle + success threshold slider. (11) Intra-task escalation: 2 consecutive error iterations → switch to next tier; emits `model.escalated`. Inter-task escalation: "Retry with stronger model" CTA on failed tasks. Telemetry tracks `routedBy`, `category`, `escalations` per task; rollups track `autoRoutedTasks`, `escalations`, `escalationSuccesses`. (12) Capability matrix: pure computation from benchmark results + organic telemetry, rendered as a color-coded grid (category × model, success %). `GET /api/capability`. (13) Benchmark harness: 10 self-contained coding tasks (simple-edit, bug-fix, test-gen, refactor, multi-file, debugging, exploration, architecture, dependency, terminal) with deterministic `verify()` functions. Runner creates temp workspaces, uses fresh `AgentSession`s, persists results to `~/.adaan/benchmark-results.json` (capped 500). Budget guard refuses to run if today's request count exceeds 50. `POST /api/benchmark/run` (SSE progress), `GET /api/benchmark/results`. Dashboard OPTIMIZE section: auto-routed tasks, escalations, post-escalation success rate, capability matrix grid, registry table.
- **Learning Loop (Phase 4 "Learn")**: (14) Richer task outcomes — `Outcome` type (verified/accepted/silent/corrected/rejected/rolled_back) replaces coarse success/error. Verified = last `run_tests` passed (exit code 0). Accepted/rejected = editor diff-review buttons POST to `/api/learn/feedback`. Corrected = next user message in same session < 5 min later matches conservative correction regex. Rolled_back = `git_rollback` in next task's first 2 iterations. `relabelOutcome` is monotonic (never downgrades verified/accepted). Outcome weights: verified/accepted 1.0, silent 0.7, corrected 0.2, rolled_back 0.1, rejected 0.0. (15) Learned model stats persisted to `~/.adaan/learned-model-stats.json` — per-category-per-model cells with Bayesian smoothing (Beta posterior with category prior, α+β≈5), recency decay (14-day half-life), and expected-requests-to-success metric (`E[reqs] = 1/P(success)`). (16) Learning policy replaces Phase 3's threshold rule when samples ≥ 3: Thompson sampling per category (sample from each model's Beta posterior, pick best draw). Free exploration always allowed; paid exploration requires `explorationPaidEnabled` setting. Falls back to Phase 3 rule when < 3 samples. `routeWithLearning()` in engine. (17) Drift detection: daily job compares last-7-day outcome weight vs posterior; drop > 2σ with ≥ 5 samples flags `DriftAlert`. (18) Weekly self-report: `GET /api/learn/report` computes auto vs manual success rates, expected vs actual requests/task, top corrections, drifted models, top models by category. Dashboard LEARN section with drift alerts and top-models-by-category grid. Settings: `learningEnabled` (default on), `explorationPaidEnabled` (default off).
- **Engine Robustness (Phase 5 "Harden")**: (D1) Orphaned tool-call cleanup — when a turn is abandoned mid-stream (user sends a new message while the engine is still executing tools), the session may have an assistant message with unresolved `tool_calls`. `cleanupOrphanedToolCalls()` runs at the start of every `run()` to remove the trailing assistant message and any partial tool results, preventing malformed message sequences that cause providers to return empty responses. (D2) Empty-response fallback — the engine never emits a silent "done" with no text. If the model returns empty content on the last iteration, or the summary turn returns empty, a fallback `text.delta` is emitted explaining the situation. (D3) Exploration cap — after 3 consecutive iterations using only read-only/non-productive tools (`read_file`, `list_files`, `search_files`, `list_symbols`, `git_status`, `git_diff`, `execute_command`, `run_tests`), a nudge is injected telling the model to produce a plan or start implementing, preventing the "explore forever, never act" failure mode common with free models. (D4) Supersession / interrupt — `session.resume()` always aborts the previous `AbortController` and sets `superseded=true` when a turn was running. The old `engine.run()` generator checks `session.superseded` at every yield point and exits silently (no `cancelled`/`error`/`done` events) so the new turn owns the UI. Without this, two generators ran concurrently, corrupting `session.messages` and causing empty responses. (D5) Interrupt vs Queue UX — when the agent is streaming and the user types a new message, the chat UI shows two buttons: **Interrupt** (amber bolt icon, default on Enter) aborts the current turn and starts a new one immediately; **Queue** (blue clock icon) stores the message and processes it after the current turn finishes via the `_messageQueue` on the session, drained by the events endpoint. (D6) Provider stall protection — the OpenRouter provider's idle timer only counts *complete* `data:` SSE lines as progress (not partial buffer content), and a hard 3-minute per-attempt deadline aborts any request that exceeds it regardless of idle signals. Both surface as 503 errors so the caller can fail over to another model. (D7) SSE stream cancel propagation — `createSSEStream` implements `cancel()` which calls `iterable.return()` to trigger the engine's `finally` block, and guards `enqueue` against writes to a closed controller so client disconnects don't crash server-side consumption. (D8) Mid-stream error UX — `ChatPanel.svelte`'s SSE `onerror` handler checks whether a terminal event (`done`/`error`/`cancelled`) was received; if not, it marks the assistant message with an error ("Connection lost — the request stalled or the server dropped the stream") instead of leaving a silent empty bubble. (D9) Action-request budget guard — at the iteration-cap summary, if the user asked for an action (`code`/`build`/`create`/`implement`/`adapt`/`port`/`rewrite`) and 0 files were modified, the summary prompt is replaced with a continuation nudge telling the model to start writing files immediately, instead of producing a text-only "plan for next turn".

## Key Files

- `packages/adaan-core/src/server/agent/engine.ts` — Agent loop
- `packages/adaan-core/src/server/agent/providers/openrouter.ts` — Provider with FSM + rotation
- `packages/adaan-core/src/server/workspace.ts` — File operations with hash-based locking
- `packages/adaan-core/src/server/security.ts` — Path + command security
- `packages/adaan-core/src/server/telemetry/` — Telemetry store, types, persistence, summary (Phase 1)
- `packages/adaan-core/src/server/registry/` — Model registry, tier assignment, empirical merge (Phase 3)
- `packages/adaan-core/src/server/router/` — Heuristic classifier + adaptive router (Phase 3)
- `packages/adaan-core/src/server/benchmark/` — Benchmark tasks, runner, capability matrix (Phase 3)
- `packages/adaan-core/src/server/learn/` — Outcome detection, learned model stats, policy, drift, report (Phase 4)
- `packages/adaan-core/src/stores/settings.ts` — Pure settings schema + migration logic (versioned, testable)
- `packages/adaan-core/src/stores/settings.svelte.ts` — Reactive settings store (single localStorage blob)
- `packages/adaan-core/src/stores/` — Svelte 5 rune stores (settings, theme, workspace, chat)

## Synthetic Progress (Phase 5 companion)

Real reasoning/thought deltas only come from reasoning models, and during a true stall zero bytes arrive anyway — so they can't solve the "is it dead?" problem. The engine now emits synthetic progress signals so a stalled/queued request doesn't look like a dead empty bubble:

- **`status` event** at each LLM request start: *"iteration 2 → requesting qwen3.8-max…"*. Cleared (empty message) on the first real token.
- **`progress` heartbeat** every ~8 s while the provider is silent: `withHeartbeat()` in `engine.ts` races the provider's single pending `.next()` against a timer (never calls `.next()` concurrently) and yields `{type:"progress", elapsedMs, phase}` markers. `phase` is `requesting` (pre-headers hang), `queued` (OpenRouter keep-alive received), or `streaming` (mid-stream stall after tokens started).
- **`provider.queued`** — OpenRouter's `: OPENROUTER PROCESSING` keep-alives (previously discarded) are now surfaced as a genuine alive signal. They do NOT re-arm the idle timer (the hard deadline is the backstop for genuinely-queued-but-alive streams).
- **UI**: one status line under the streaming bubble (*"Working… 23s · waiting for model response"* / *"queued at provider"*), with a pulsing accent dot, cleared on the first real token or when the turn terminates.

## Reasoning / Thought Streaming

Reasoning-capable models (o1, DeepSeek-R1, Claude w/ extended thinking) stream their chain-of-thought separately from the final answer. The provider now surfaces it instead of discarding it:

- **`reasoning.delta` ProviderEvent** — emitted when `delta.reasoning` (OpenRouter native) or `delta.reasoning_content` (OpenAI/DeepSeek-compatible) arrives in an SSE chunk. `reasoning_content` wins when both are present (OpenAI Chat delta convention). Non-reasoning models never set either field, so this is a no-op for them.
- **`reasoning.delta` AgentEvent** — forwarded through the engine (main loop + summary turn), accumulated into `assistantReasoning` and stored on the `ChatMessage` as `msg.reasoning`. Also clears the synthetic "waiting" status line (reasoning is a genuine alive signal).
- **Not re-sent to the provider**: `buildProviderMessages` copies only `role`/`content`/`toolCalls`/`toolCallId`/`name` — `reasoning` is deliberately excluded because providers reject or ignore reasoning in message history.
- **UI**: a collapsible, muted block above the final answer with a left accent border, a "Reasoning" header (chevron + bulb icon), and the thought text at reduced opacity/size. Defaults to expanded while streaming so the user sees live thoughts.

---

No AI signature in commit messages or code comments.