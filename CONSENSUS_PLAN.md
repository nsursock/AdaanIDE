# AdaanIDE — Free-Tier Coding Optimization: Consensus Implementation Plan

Goal: make AdaanIDE reliably complete coding tasks using only free resources
(local Qwen ~4B via Rapid-MLX + OpenRouter free pool), optimizing
**successful tasks per 1,000 requests**.

This plan is the distilled consensus of four independent architecture reviews.
It is written to be executed by an AI coding agent (GLM 5.2) without any other
context. Each phase is independently shippable and testable.

---

## Ground rules (read first)

- **Repo layout**: pnpm monorepo. All changes in this plan live in
  `packages/adaan-core/` (TypeScript, no UI changes). The SvelteKit app is
  `apps/futuristic/`.
- **Verify every phase** with both:
  - `pnpm --filter @adaan/core test` (currently 325 tests, all must stay green)
  - `pnpm --filter @adaan/futuristic build` (must compile clean)
- **No new npm dependencies.** No tree-sitter, no LSP, no new CLIs. Use what
  exists: `Workspace.executeCommand()`, `Workspace.gitCheckpoint()`, ripgrep-style
  `search_files`, `list_symbols`.
- **No AI signatures** in code comments or commit messages. Match the existing
  comment style of surrounding code (the codebase uses explanatory comments).
- **Settings changes** must bump the schema version in
  `packages/adaan-core/src/stores/settings.ts` and add a migration case + test.
- **Telemetry type changes** (`telemetry/types.ts`) must backfill old records
  in `TelemetryStore.load()` (`telemetry/store.ts`).
- **Do not change** the `LLMProvider` interface
  (`src/server/agent/provider.ts`) or the OpenRouter SSE protocol.
- **Do NOT build** any of the following (explicitly rejected in review):
  pattern libraries, few-shot retrieval, task-DAG decomposition, request
  batching, fuzzy/regex anchor matching, GBNF grammar decoding, new
  complexity-scoring systems.

Key files:

| File | Role |
|---|---|
| `src/server/agent/engine.ts` | Agent FSM loop (~1480 lines). Tool execution at ~line 912 (`handler(parsedArgs, ctx)`); escalation at ~line 1043; A3 snapshot injection at ~line 361-383; `SYSTEM_PROMPT` at line 80. |
| `src/server/agent/tools/files.ts` | Tool handlers (`ToolHandler = (args, ctx) => Promise<ToolResult>`; `ctx.workspace` available). |
| `src/server/workspace.ts` | `Workspace` class: `readFile`, `writeFile`, `executeCommand(command, timeoutMs)` (line 511), `gitCheckpoint(message)` (line 555). |
| `src/server/telemetry/store.ts` | `MODIFY_TOOLS = {"write_file","apply_patch","create_file","delete_file","git_checkpoint","git_rollback"}` (line 595). |
| `src/server/router/classifier.ts` | `classifyTask()` heuristic classifier, `TaskCategory` type. |
| `src/server/benchmark/tasks.ts` + `runner.ts` | Benchmark harness: `BenchmarkTask {id, scaffold, prompt, maxIterations, verify}`. |
| `src/stores/settings.ts` | Versioned settings schema (currently v4). |

---

## Phase A — Post-edit verification gate + auto-checkpoint

**Why**: nothing currently verifies model-written code deterministically. Weak
models cannot self-correct; a free syntax check after every write converts
silent failures into repairable tool errors and feeds the existing
escalation machinery. Highest-value item in the whole plan.

### A1. New module `src/server/agent/verify.ts`

Pure, testable. Export:

```ts
export interface VerifyResult { ok: boolean; errors: string; checkRan: boolean }
export async function verifyEditedFile(workspace: Workspace, filePath: string): Promise<VerifyResult>
```

Language detection by extension; run the **cheapest file-scoped check** via
`workspace.executeCommand(cmd, 15_000)`:

- `.py` → `python3 -m py_compile <file>`
- `.js`, `.mjs`, `.cjs` → `node --check <file>`
- `.ts`, `.tsx` → only if the workspace has a `tsconfig.json`:
  `npx tsc --noEmit -p .` (project-wide is unavoidable for TS; accept it).
  If no tsconfig, return `{ok: true, checkRan: false}`.
- Other extensions → `{ok: true, errors: "", checkRan: false}`.

Rules:
- Truncate `errors` to ~600 chars, head-first (the model only needs the first
  diagnostic).
- `checkRan: false` means "no gate available" — callers must treat it as pass.
- Never throw; wrap everything in try/catch and return `ok: true, checkRan: false`
  on infrastructure failure (missing python, no node, etc.). The gate must
  never break the agent loop.

### A2. Hook into the engine

In `engine.ts`, immediately after `const result: ToolResult = await handler(parsedArgs, ctx);`
(~line 912), when the tool succeeded (`result.success`) and the tool name is
`write_file`, `apply_patch`, or `create_file`:

1. Extract the edited file path from `parsedArgs` (`path` or `filePath` —
   check `tools/schema.ts` for the exact arg names).
2. Call `verifyEditedFile(workspace, path)`.
3. If `!ok`: convert this into the **existing failure path** — emit
   `tool.error`, set `iterationHadError = true`, record in
   `session.failedCallCache`, push the `role: "tool"` error message — with
   content like
   `{"error":"Syntax check failed after edit","diagnostics":"<truncated errors>"}`.
   Do NOT invent a new event type; reuse the exact failure path already used
   at ~lines 917-934 so B1 repeat-failure guard and Phase-3 escalation
   (2 consecutive error iterations → next tier) engage automatically.
4. Track per-task repair attempts: add `verifyGateFailures: number` to
   `ActiveTask` (`telemetry/store.ts`) and `TaskRecord` (`telemetry/types.ts`,
   backfill 0 in `store.load()`). After **2** gate failures on the same file
   within one task, stop re-running the gate for that file (avoid infinite
   loop; the escalation/summary machinery takes over).
5. Roll up into `DailyRollup` is NOT required — keep it on TaskRecord only.

### A3. Auto git checkpoint before first write

Before executing the first successful write-family tool (`write_file`,
`apply_patch`, `create_file`) of a task, call
`await workspace.gitCheckpoint("auto: pre-task checkpoint")` inside a
try/catch (best-effort; not a git repo → silently skip). Track with a
`task.checkpointTaken` boolean (ActiveTask only, no telemetry schema change
needed). This makes every failed task cheaply reversible via the existing
`git_rollback` tool.

### A4. Tests

New `tests/verify.test.ts`:
- py_compile pass/fail on temp `.py` files (skip gracefully if no python3).
- `node --check` pass/fail on temp `.js` files.
- Truncation of long error output.
- `checkRan: false` for unknown extensions.

Engine-level test: mock provider that calls `write_file` with syntactically
invalid JS → assert `tool.error` emitted and `task.verifyGateFailures === 1`.

---

## Phase B — Edit-format benchmark experiment (data collection)

**Why**: the four reviews disagree on the best edit format for weak models
(apply_patch vs full-file rewrite vs anchors). AdaanIDE owns a benchmark
harness — settle it with data instead of opinions. This phase changes no
agent behavior; it only extends the harness.

### B1. Runner option: tool filter

`BenchmarkRunOptions` (`runner.ts`): add optional
`toolFilter?: string[]` — when set, the runner constructs the AgentSession /
engine with only these tool schemas exposed to the model. Thread it through
however the runner currently builds sessions (read `runner.ts` first; keep
the change minimal). If the engine/registry doesn't support a tool subset,
add an optional `tools?: string[]` to `EngineOptions` that filters
`registry.allSchemas` when building the provider request (do NOT mutate the
shared `defaultRegistry`).

### B2. Experiment tasks

Add to `tasks.ts` three variants of the **same** edit problem (a 40-60 line
file with a bug in one function — big enough that full rewrite is nontrivial,
small enough for a 4B model):

- `edit-format-patch`: normal toolset, prompt unchanged (model will likely
  pick `apply_patch`).
- `edit-format-rewrite`: `toolFilter` excluding `apply_patch`; prompt adds
  "Use write_file to rewrite the file."
- `edit-format-directed-patch`: prompt explicitly instructs SEARCH/REPLACE
  patch usage (tests whether explicit format instruction helps weak models).

Same `verify()` logic for all three (bug fixed, rest of file intact — check
both the fixed line AND that unrelated functions are unchanged, so
truncating rewrites fail).

### B3. No new metrics code

Token usage, latency, and success are already recorded by telemetry. Running
the benchmark against the local model (`rapid-mlx serve <model>` then run via
`POST /api/benchmark/run`) produces tok/s = outputTokens / latencyMs from
`GET /api/telemetry/summary`. Do not build new measurement code.

### B4. Deliverable

Run the experiment against the local 4B model, 3+ runs per variant, and
record results in `docs/edit-format-experiment.md` (table: variant, model,
success rate, avg requests/task, avg output tokens, observed failure modes).
This table decides whether Phase C's weak-tier mode defaults to rewrite or
patch, and whether an anchor tool is worth building later.

---

## Phase C — Single-shot weak-tier mode

**Why**: sub-5B models drift in multi-turn ReAct loops. For the weak tier,
replace the loop with 2 narrow, stateless, code-orchestrated LLM calls.
Depends on Phase B results (choose default edit strategy from the data).

### C1. New module `src/server/agent/single-shot.ts`

Pure functions, fully unit-testable, no provider access:

```ts
export interface ClassifyResult {
  action: "edit" | "create" | "explain" | "search" | "reject";
  targetFiles: string[];
  reason: string;
}
export function buildClassifyPrompt(request: string, fileTree: string): string
export function parseClassifyResponse(raw: string): ClassifyResult | null
export function buildEditPrompt(request: string, files: {path: string; content: string}[]): string
```

- Classify output contract: JSON `{"action":..., "targetFiles":[...]}` — but
  `parseClassifyResponse` must ALSO accept a tagged-line fallback format
  (`ACTION: edit`, `FILES: a.py, b.py`) via regex, since weak models format
  single tagged lines more reliably than JSON. Return `null` on garbage.
- `buildEditPrompt`: request + full content of target files ONLY. Explicitly
  instruct the output format chosen per Phase B results (default: full
  replacement content per file, fenced, with a `FILE: path` header line).
- Hard limits: classify input ≤ 1500 tokens (file tree = names only); edit
  input ≤ 6000 tokens total — if target files exceed it, return `action:
  "reject"` with reason (too big for weak tier; engine falls back to normal
  loop / cloud).

### C2. Engine integration

In `engine.ts` `run()`, after routing decides the model:

- Enter single-shot mode when the effective model's regime is `"local"`
  (use the existing `deriveRegime()`), OR when a new setting
  `singleShotMode` is `"always"`. Setting: add
  `singleShotMode: "auto" | "always" | "never"` to the settings schema
  (default `"auto"`, bump schema version, migration + test). `"auto"` =
  local regime only.
- Pipeline (each step a FRESH provider message array — no transcript
  accumulation):
  1. Classify call → parse. `null` or `action: "reject"`/`"search"` →
     fall back to the normal ReAct loop for this task (do not fail the task).
  2. `explain` → one normal chat completion, done.
  3. `edit`/`create` → read target files via workspace → edit call →
     parse file contents → write via `workspace.writeFile` (respect the
     existing hash-based concurrency: read current hash first, pass it).
  4. Run Phase A's `verifyEditedFile` on each written file. On failure:
     exactly ONE repair call (error diagnostics appended, same fresh-prompt
     style). Still failing → fall back to the normal ReAct loop with the
     escalation path available (do not silently fail).
- Emit existing events so the UI keeps working: `text.delta` for the final
  explanation, `tool.call`/`tool.result` for the writes (synthesize them from
  the pipeline so ChatPanel/FileBrowser see normal activity). Read how the
  ReAct loop emits these and mirror the payloads exactly.
- Telemetry: add `pipeline?: "single-shot" | "react"` to `TaskRecord`
  (backfill `null`/`"react"` in `store.load()`). Record both LLM calls via
  the existing `recordRequest` path so tokens/cost stay honest.

### C3. Tests

- Parser unit tests: valid JSON, tagged-line format, garbage → null,
  missing fields → null.
- Prompt builder tests: token-budget rejection, file content inclusion.
- Engine test with mock provider: full edit pipeline happy path (classify →
  edit → verify pass → done), and verify-fail → repair → pass.

---

## Phase D — Compact case file on escalation

**Why**: escalation currently swaps the model and continues with the FULL
conversation history (engine.ts ~line 1043-1078). A distilled case file is
cheaper and easier for the stronger model to solve.

In the escalation branch, after picking `nextTier`'s model, rebuild the
message history sent to the provider (do NOT mutate `session.messages` — the
UI and learning loop need the real transcript):

```
USER REQUEST: <first user message of the session>
FILES MODIFIED SO FAR: <paths, with CURRENT content from workspace>
LAST ERRORS: <last 3 tool error messages, truncated 300 chars each>
INSTRUCTION: Continue this task. Previous model failed repeatedly.
```

Implementation note: the engine builds provider messages via
`buildProviderMessages(session)` (~line 1388). Add an optional override so
the first request after escalation uses the case file instead, then appends
new turns normally afterwards. Cap case file at ~4000 tokens.

Test: mock provider failing twice → escalation fires → assert the escalated
request's messages contain the case-file structure and NOT the full prior
transcript.

---

## Phase E — Two small hygiene fixes

### E1. Move the A3 workspace snapshot out of the system prompt

`engine.ts` lines ~361-383 currently append the workspace snapshot to
`providerMessages[0]` (the system message) on the first request. This breaks
prefix-cache reuse for local servers (Rapid-MLX caches on identical
prefixes). Change: append the snapshot text to the first **user** message
instead. Keep the exact same snapshot content and the `task.snapshotInjected`
flag. Verify no local chat-template assumptions break (Qwen templates accept
long user messages fine).

### E2. Pre-flight scope check

In `run()`, after `classifyTask()` produces a category: if the effective
regime is `local` AND category is `refactor` or `greenfield` or
`multiFile` classification signal is true, emit a `model.routed`-style
warning event (`scope.warning`, payload `{reason}`) and — when routing mode
is `auto` and `allowedTiers` includes non-local options — prefer the cloud
free tier for that task. One small decision block, no new subsystem.

---

## Execution order and dependencies

```
A (verification gate) ──┐
                        ├──> C (single-shot mode; uses A's gate, B's data)
B (benchmark experiment)┘         │
                                  v
                    D (case-file escalation) — independent, anytime after A
                    E1, E2 — independent, trivial, do whenever
```

Recommended sequence: **A → B (run experiment, record results) → E1/E2 →
C → D**. Commit after each phase with the test suite green.

## Definition of done (whole plan)

1. `pnpm --filter @adaan/core test` green (325 existing + new tests).
2. `pnpm --filter @adaan/futuristic build` clean.
3. `docs/edit-format-experiment.md` exists with real measured numbers from
   the local 4B model (≥3 runs per variant).
4. Manual smoke: one real task end-to-end on the local model — write
   happens, gate runs, checkpoint exists (`git log` shows the auto
   checkpoint), and a deliberately broken edit triggers the repair path.
5. No new dependencies in any `package.json`.
