# AdaanIDE Architecture

Detailed reference for the subsystems in AdaanIDE. For the concise operating
manual, see `AGENTS.md`.

## Desktop App (Electron)

The `apps/desktop/` package wraps the SvelteKit futuristic app as a native desktop application. Key design:

- **adapter-node**: The futuristic app uses `@sveltejs/adapter-node` (not adapter-auto) so the SvelteKit server (37+ API routes, SSE streams, file ops) runs as a Node.js process inside Electron.
- **Main process** (`src/main.ts`): In production, spawns the built SvelteKit Node server on a random localhost port, waits for it to be ready, then loads it in a `BrowserWindow`. In dev, connects to the already-running vite dev server on port 5174.
- **Preload** (`src/preload.ts`): Exposes a safe `window.adaan` API via `contextBridge` — native file dialogs (`openWorkspaceDialog`, `openFileDialog`, `saveFileDialog`), menu event listeners (`onSave`, `onOpenWorkspace`, `onNewFile`, `onWorkspaceOpened`), and platform info. `contextIsolation: true`, `nodeIntegration: false`.
- **Native menus**: File menu with `CmdOrCtrl+S` (Save), `CmdOrCtrl+O` (Open Workspace), `CmdOrCtrl+N` (New File). Save triggers `window.adaan.onSave` → the SvelteKit app calls `saveFile()` on the active dirty tab. Open Workspace uses the native OS directory dialog.
- **Single instance lock**: Only one AdaanIDE window can run at a time.
- **Lifecycle**: Server process is killed on `before-quit`; on macOS the app stays alive with no windows (standard behavior).
- **Packaging**: `electron-builder` produces `.dmg`/`.zip` (mac), `.exe`/portable (win), `.AppImage`/`.deb` (linux). The SvelteKit build output is bundled as `extraResources/server`. Output goes to `apps/desktop/release/`.
- **Browser fallback**: The app works in any browser without Electron — `window.adaan` is simply `undefined`, and the `$effect` that wires native menu events is a no-op. The CodeMirror `Mod-s` keymap handles save in both browser and desktop contexts.

## Agent Engine

FSM-based tool-calling loop with 4-iteration cap, context pruning, and session-based caching. See `packages/adaan-core/src/server/agent/engine.ts`.

## OpenRouter Provider

Streaming SSE with tool-call accumulation, free-model rotation pool (LRU), and 429/503 failover. See `packages/adaan-core/src/server/agent/providers/openrouter.ts`.

## Security

Path traversal prevention (resolve + prefix check), symlink escape detection, hash-based optimistic concurrency for file writes, command deny-list. See `packages/adaan-core/src/server/security.ts`.

## Themes

Retrowave, Ghibli, and Fiesta, with CodeMirror syntax highlighting swapped via extension compartments.

## Three.js

Background particle field in the futuristic app, toggleable via settings.

## Settings

Unified, versioned, persisted to a single `localStorage` blob (`adaan.settings.v1`). Covers theme, panel widths, selected model, the Three.js toggle, OpenRouter API key, a custom provider base URL, routing/learning toggles, and a game-style **Performance** tab (schema v9). Pure migration logic in `settings.ts` (testable, no runes); reactive store in `settings.svelte.ts`. `themeStore` and `chatStore` delegate persistence to `settingsStore`. Legacy per-feature keys are folded in on first run.

### Performance Tab

Game-style graphics quality presets (Quality / Balanced / Performance / Custom) in Settings → Performance. Controls: Three.js on/off + quality tier (particle count 500/2000/5000, DPR cap 1/1.5/2, AA off/on), pause-when-hidden (stops RAF when `document.hidden`), animations (GSAP + infinite CSS), glass blur (`backdrop-filter`), chat streaming render (smooth per-token vs throttled 100ms batched flush), editor live-sync (per-keystroke vs 300ms debounced), file-tree refresh (immediate vs 2s throttled). A `perf-lite` class on `<html>` gates CSS effects in `app.css`. Three.js is dynamically imported (leaves the initial bundle when disabled). `prefers-reduced-motion` forces the same lightweight CSS path for a11y. Defaults = today's look ("Quality" preset), so zero behavior change on upgrade.

## Local Models

The `OpenRouterProvider` accepts a `baseUrl`, so any OpenAI-compatible server works as a drop-in. Set `OPENROUTER_BASE_URL` (env) or the "Endpoint base URL" field in Settings (UI value wins). For Rapid-MLX run `rapid-mlx serve <model>` and use `http://localhost:8000/v1` — no API key needed (a `not-needed` placeholder is sent automatically when the key is empty and a custom endpoint is set). `listModels` defaults `toolsCapable=true` when a server omits `supported_parameters` (local servers do), so local models stay selectable in the picker. `getProvider()` only requires an API key for the default OpenRouter endpoint.

### Local Provider Discovery & Serving

The IDE auto-detects installed local runtimes (Ollama, Rapid-MLX, LM Studio) by checking PATH for their binaries, lists their installed/cached models (via CLI output parsing or filesystem scanning as fallback), and probes each provider's default port to check if a server is already running. The Settings → Models tab shows all detected providers with their models, running status, and Serve/Stop buttons. The ModelPicker shows a "Local Models" tier at the top — selecting a local model auto-launches the appropriate `serve` command (detached process), waits for the endpoint to become ready, repoints the IDE at the local endpoint, and sets the model as active. Server lifecycle: `packages/adaan-core/src/server/local/` (providers spec, discovery, server-manager). API: `GET /api/local/providers`, `POST /api/local/serve`, `POST /api/local/stop`. The `/api/models` endpoint merges local models into the response as a `local` field on `ModelGroups`.

## Telemetry (Phase 1 "Measure")

Every LLM request and user task is instrumented — real token usage (parsed from OpenRouter's SSE `usage` chunk), cost, latency, request-type heuristic (planning/coding/debugging/final_response), tool classification (read/modify/command/test), cache hits, and context-pruning savings. Daily rollups double as the Phase 3 capability-matrix seed. Persisted to `~/.adaan/telemetry.json` (capped recent records + unbounded daily rollups, debounced writes). Dashboard via `TelemetryPanel.svelte` (app-bar chart icon) and `GET /api/telemetry/summary`; the killer metric is **successful tasks per 1,000 requests** (optimizes against OpenRouter's daily cap). Per-task footer (`7 reqs · 92k tokens · $0.031 · 84s · saved 12k ctx`) under each assistant message via the `task.summary` event.

## Context Engine (Phase 2 "Reduce")

- (A1) Tool results are truncated to ~2000 tokens before entering conversation history — head ~70% + tail ~30% with an elision marker pointing at targeted re-reads; the full result still goes to the UI.
- (A2) Turn-aware pruning replaces the old one-message-at-a-time pruner — compacts old tool messages (stub replaces content, pairing stays valid), then drops oldest turns atomically (assistant + its tool results together) so no orphan `tool_call_id`s; always keeps the first user message (the task) and the last 2 turns.
- (A3) A workspace snapshot (file tree + stack hints + git status, ≤1500 tokens) is injected on the first request of a session, killing the common exploration `list_files` call.
- (B1) Repeat-failure guard blocks identical failed tool calls (cleared on any successful write).
- (B2) `apply_patch` returns `blocksApplied`/`linesAdded`/`linesDeleted`/`snippet`; `write_file`/`create_file` return `lines` — fewer verification re-reads.
- (C1) Workspace-level L2 read cache (LRU 200, TTL 5 min) shared across sessions, invalidated on writes and watcher events.

## Adaptive Router (Phase 3 "Optimize")

- (9) Model registry persists the OpenRouter catalog to `~/.adaan/model-registry.json` (24h TTL) with tier assignment (free/mid/frontier by price percentile) and empirical stats merged from telemetry rollups. `GET /api/models/registry`.
- (10) A 100% local heuristic classifier (`classifyTask`) scores prompts on 6 dimensions (complexity, reasoning, coding, toolUse, contextNeeded, multiFile) and assigns a category (fix/test/refactor/greenfield/exploration/chat/workflow). The router (`routeModel`) picks the cheapest model likely to succeed within allowed tiers — free preferred at equal confidence, falls back to "any free tools-capable model" when no empirical data exists. Engine accepts `model: "auto"` → router decides; emits `model.routed` event; chat UI shows a pill (`auto → glm-5.2:free · category: fix`). Settings: routing mode toggle + success threshold slider.
- (11) Intra-task escalation: 2 consecutive error iterations → switch to next tier; emits `model.escalated`. Inter-task escalation: "Retry with stronger model" CTA on failed tasks. Telemetry tracks `routedBy`, `category`, `escalations` per task; rollups track `autoRoutedTasks`, `escalations`, `escalationSuccesses`.
- (12) Capability matrix: pure computation from benchmark results + organic telemetry, rendered as a color-coded grid (category × model, success %). `GET /api/capability`.
- (13) Benchmark harness: 10 self-contained coding tasks (simple-edit, bug-fix, test-gen, refactor, multi-file, debugging, exploration, architecture, dependency, terminal) with deterministic `verify()` functions. Runner creates temp workspaces, uses fresh `AgentSession`s, persists results to `~/.adaan/benchmark-results.json` (capped 500). Budget guard refuses to run if today's request count exceeds 50. `POST /api/benchmark/run` (SSE progress), `GET /api/benchmark/results`.

## Learning Loop (Phase 4 "Learn")

- (14) Richer task outcomes — `Outcome` type (verified/accepted/silent/corrected/rejected/rolled_back) replaces coarse success/error. Verified = last `run_tests` passed (exit code 0). Accepted/rejected = editor diff-review buttons POST to `/api/learn/feedback`. Corrected = next user message in same session < 5 min later matches conservative correction regex. Rolled_back = `git_rollback` in next task's first 2 iterations. `relabelOutcome` is monotonic (never downgrades verified/accepted). Outcome weights: verified/accepted 1.0, silent 0.7, corrected 0.2, rolled_back 0.1, rejected 0.0.
- (15) Learned model stats persisted to `~/.adaan/learned-model-stats.json` — per-category-per-model cells with Bayesian smoothing (Beta posterior with category prior, α+β≈5), recency decay (14-day half-life), and expected-requests-to-success metric (`E[reqs] = 1/P(success)`).
- (16) Learning policy replaces Phase 3's threshold rule when samples ≥ 3: Thompson sampling per category (sample from each model's Beta posterior, pick best draw). Free exploration always allowed; paid exploration requires `explorationPaidEnabled` setting. Falls back to Phase 3 rule when < 3 samples. `routeWithLearning()` in engine.
- (17) Drift detection: daily job compares last-7-day outcome weight vs posterior; drop > 2σ with ≥ 5 samples flags `DriftAlert`.
- (18) Weekly self-report: `GET /api/learn/report` computes auto vs manual success rates, expected vs actual requests/task, top corrections, drifted models, top models by category. Dashboard LEARN section with drift alerts and top-models-by-category grid. Settings: `learningEnabled` (default on), `explorationPaidEnabled` (default off).

## Monitoring (Living Task List)

A committee of AI personas ("lenses") reviews the project every N hours/days/weeks and maintains a **living prioritized task list** (P0–P3) that updates across runs instead of duplicating. N reviewer models run the full committee prompt in parallel, then an aggregator/judge model merges all outputs into one structured task list.

**Parameters**: reviewer models (pick specific ones or auto-pick from tier), lenses/personas (fully editable), expertise level (top-0.1% / top-1% / top-10% / top-25% — injected into every lens prompt), aggregator/judge model, schedule interval (hours/days/weeks), target path, GitHub issue auto-creation, TASKS.md export. **Model tiers**: free (all OpenRouter free models), paid (all paid models), all (free + paid). **Cost estimation**: before each run, estimates cost in USD + token count from model pricing × estimated tokens. **Smoke test preset**: 2 lenses, fast sanity check.

**Living list** (`tasklist.ts`): each task gets a `fingerprint` (djb2 hash of the sorted lowercase word-set of the issue title — tolerant of reordering/punctuation); `mergeTaskList(previous, incoming, now)` matches incoming tasks to prior ones by fingerprint (carried tasks keep `firstSeenAt`/`githubUrl`/user-resolved state; user-resolved is sticky), auto-resolves tasks missing from the latest run (`resolvedBy: "auto"`, reopens if re-flagged), dedups within a batch, and sorts open-by-priority then resolved. `buildTasksMarkdown()` renders a GitHub-style TASKS.md (`- [ ]`/`- [x]`, grouped by priority) — exported to the workspace root after each run when `config.writeTasksFile` is on.

Core: `packages/adaan-core/src/server/review/` — `types.ts` (ReviewConfig, ReviewTask, ReviewResult, ReviewProgress), `presets.ts` (smoke-test + 8 project types), `models.ts` (`resolveReviewerModels`/`resolveAggregatorModel`/`estimateReviewCost`), `runner.ts` (`runReview`: gathers context, estimates cost, runs N reviewers in parallel, aggregates, merges into the living list, optionally creates GitHub issues — never re-filing tasks that already have a `githubUrl`, optionally writes TASKS.md.

### Reviewer retry/failover

When a reviewer errors, returns empty output, or truncates, the runner retries the SAME model first (cheaper, more predictable, keeps the user's chosen model) before swapping to a spare:

1. **Truncation** (`finish: length`) → retry same model with raised `maxTokens` (8192→16384→32768, `TOKEN_BUDGETS` escalation — truncation is a budget problem, not a model problem).
2. **Transient failure** (empty output, stream error) → retry same model once with same params (`MAX_SAME_MODEL_RETRIES=1`).
3. **Model-specific failure** (tool-call syntax, degenerate reasoning) → skip same-model retry, go straight to spare.
4. **Same-model retries exhausted** → swap to a spare from the same tier pool (excluding assigned reviewers and aggregator), up to `MAX_REVIEWER_FAILOVER=2` spares.

Emits `committee.retry` events (same-model) and `committee.failover` events (spare swap); records retries in `ReviewResult.retries` and swaps in `ReviewResult.failovers`; `result.reviewerModels` reflects the actual models that served each slot.

### Aggregator retry/failover

Same strategy for the judge — same-model retry with raised budget for truncation, same-model retry for transient errors, then spare-model failover (up to `MAX_AGGREGATOR_FAILOVER=2` spares from the same tier pool excluding reviewers and original aggregator). Emits `aggregator.retry` and `aggregator.failover` events; records in `ReviewResult.aggregatorRetries` and `ReviewResult.aggregatorFailovers`; `result.aggregatorModel` reflects the actual model that served the judge.

### Reasoning guards

`reasoning.delta` is captured as a fallback when a model produces only chain-of-thought and no content, but only when the stream completed without error AND `finish: stop` AND the reasoning is not degenerate/repetitive — truncated (`finish: length`), errored, or degenerate reasoning triggers retry/failover instead.

## Engine Robustness (Phase 5 "Harden")

- (D1) **Orphaned tool-call cleanup** — when a turn is abandoned mid-stream (user sends a new message while the engine is still executing tools), the session may have an assistant message with unresolved `tool_calls`. `cleanupOrphanedToolCalls()` runs at the start of every `run()` to remove the trailing assistant message and any partial tool results, preventing malformed message sequences that cause providers to return empty responses.
- (D2) **Empty-response fallback** — the engine never emits a silent "done" with no text. If the model returns empty content on the last iteration, or the summary turn returns empty, a fallback `text.delta` is emitted explaining the situation.
- (D3) **Exploration cap** — after 3 consecutive iterations using only read-only/non-productive tools (`read_file`, `list_files`, `search_files`, `list_symbols`, `git_status`, `git_diff`, `execute_command`, `run_tests`), a nudge is injected telling the model to produce a plan or start implementing, preventing the "explore forever, never act" failure mode common with free models.
- (D4) **Supersession / interrupt** — `session.resume()` always aborts the previous `AbortController` and sets `superseded=true` when a turn was running. The old `engine.run()` generator checks `session.superseded` at every yield point and exits silently (no `cancelled`/`error`/`done` events) so the new turn owns the UI. Without this, two generators ran concurrently, corrupting `session.messages` and causing empty responses.
- (D5) **Interrupt vs Queue UX** — when the agent is streaming and the user types a new message, the chat UI shows two buttons: **Interrupt** (amber bolt icon, default on Enter) aborts the current turn and starts a new one immediately; **Queue** (blue clock icon) stores the message and processes it after the current turn finishes via the `_messageQueue` on the session, drained by the events endpoint.
- (D6) **Provider stall protection** — the OpenRouter provider's idle timer only fires when zero bytes arrive for 45s; OpenRouter's `: OPENROUTER PROCESSING` keep-alive comments re-arm the idle timer (they prove the upstream is alive). A hard 3-minute deadline catches streams that keep the connection alive but never deliver a complete SSE line.

## Three-View Telemetry Dashboard (Phase 6)

The telemetry canonical layer (`RequestRecord`/`TaskRecord` → `DailyRollup`) carries the dimensions needed to split one data model into Paid / Free / Local regime views without three separate systems:

- **`regime` + `provider` on `TaskRecord`**: derived in `AgentEngine.deriveRegime()` from the active provider — `local` when `provider.isLocalModel(model)` or a custom base URL is set, `free` for `:free` slugs on the default OpenRouter endpoint, `paid` otherwise. Re-derived after routing and on intra-task escalation so it reflects the effective model. Backfilled to `"free"`/`"paid"` (via `:free` suffix heuristic) on pre-Phase-6 records in `store.load()`.
- **`requestedModel` vs `model`**: `requestedModel` is the pre-routing/pre-escalation model the user picked; `model` is the effective/final one. The provider's `model.fallback` event (429/503 failover) now updates `task.model` so the effective model is honest even mid-request — previously `task.model` stayed stale on failover and the per-model task rollup attributed work to the wrong model.
- **`retries` + `fallbacks` on `TaskRecord`/`DailyRollup`**: same-model transient retries (429/503 with backoff) vs cross-model failovers. The provider emits a new `model.retry` event from its same-model retry path; the engine increments `task.retries`/`task.fallbacks` from `model.retry`/`model.fallback` in both the main loop and the summary turn. Rolled up into `DailyRollup.retries`/`fallbacks`.
- **`quotaDailyLimit` in settings** (default 1000, schema v4): the free-regime daily request cap. Consumed = today's `DailyRollup.requests`. 0 disables the quota display. Used by the dashboard's quota bar.
- **tok/s**: derived in the metrics layer from existing `RequestRecord.outputTokens`/`latencyMs` — no hardware probe needed.
- **Reset Stats**: `TelemetryStore.reset()` wipes all records and persists immediately; `POST /api/telemetry/reset` exposes it. The TelemetryPanel header has a trash-icon button (with confirm) that clears local state and reloads.

### Phase 6 — Pure metrics layer (`telemetry/metrics.ts`)

- `computeRegimeMetrics(tasks, requests, regime, opts)` → `RegimeMetrics`: success rate, tasks/1k req, reqs/task, tokens/task, cost/task, p50/p95 latency, escalation/retry/fallback rates, quota consumed/remaining (free, from uncapped rollup via `quotaConsumedToday` opt), tasks/hour + tok/s + time/successful task (local).
- `computeModelMatrix(tasks)` → `ModelMatrix`: cells with `{model, category, n, successes, rate, avgReqs, lowConfidence}` — **N first-class**, `lowConfidence: n < 3`.
- `computeModelTable(tasks)` → `ModelRow[]`: global per-model rollup with N + lowConfidence.
- 26 unit tests in `tests/metrics.test.ts`.

### Phase 6 — API endpoints

- `GET /api/telemetry/regimes?days=7` → `{paid, free, local}` bundles. Quota consumed from today's uncapped rollup (`quotaConsumedToday`), not the capped `recentRequests` ring.
- `GET /api/telemetry/models` → global model table merging telemetry (`computeModelTable`) + registry tiers/pricing + learned stats sample counts.
- **Fixed** `GET /api/capability` — was reading `_data().tasks` (nonexistent field, always `[]`); now reads `recentTasks`. Also returns `organic` matrix from `computeModelMatrix` alongside the legacy `matrix`.

### Phase 6 — UI: one panel, six tabs

`TelemetryPanel.svelte` refactored from 942-line monolith into tab shell + 4 sub-components in `lib/components/telemetry/`:

- `RegimeView.svelte` — parameterized, used 3× (free/paid/local). Free tab: giant hero = tasks/1k req + quota bar (green→amber→red). Paid tab: cost/successful task, p95. Local tab: tasks/hour, tok/s, time/successful task. All share overview + reliability sections.
- `ModelsView.svelte` — global model table with N, success rate (color-coded), reqs/task, tokens/task, p50/p95, cost, esc/retry/fallback. Low-confidence rows dimmed.
- `MatrixView.svelte` — Model×Category grid with `96% (N=34)` per cell. Cells with n<3 are dimmed + italic. Color-coded good/mid/bad.
- `ExperimentsView.svelte` — A/B comparison table with Δ column (green = improvement, red = regression).

### Phase 6 — Experiments

- `experiment: {name, arm} | null` on `TaskRecord`/`ActiveTask`; backfilled to `null` on old records.
- `engine.run()` accepts optional `experiment` param; session POST body passes it through.
- `GET /api/telemetry/experiments` → groups by name+arm, computes per-arm metrics (n, successRate, avgReqs, avgTokens, avgLatency, avgCost).
- `ExperimentsView.svelte` renders A/B table with Δ for success rate, reqs/task, tokens/task, latency, cost. Single-arm experiments show one column with a hint to add a second arm.

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
