# Performance Plan — "Light as a Feather"

Goal: make the futuristic webapp cheap to run on any machine by (1) fixing a
handful of real hotspots and (2) adding a game-style **Performance** settings
tab that trades eye-candy for speed. Each step is small, independent, and
testable. Implement in order; stop anytime and the app still works.

---

## 1. Audit — where the weight actually is (ranked)

### A. Three.js background — the biggest GPU/CPU sink
File: `apps/futuristic/src/lib/components/ThreeBackground.svelte`

- **Always-render loop**: `requestAnimationFrame` renders 2000 particles +
  grid + camera drift at 60 fps *forever*, even when the tab is hidden, the
  window is unfocused, or the canvas is fully covered by opaque panes.
  No `document.hidden` / visibility handling. (lines 144–162)
- **Static import**: `import * as THREE from "three"` in the shared layout
  (`src/routes/+layout.svelte`), so ~150 KB gz / ~600 KB min ships and parses
  even when `threeEnabled` is off. (ThreeBackground.svelte line 3)
- **Fixed high quality**: `antialias: true`, `devicePixelRatio` capped at 2,
  hardcoded 2000 particles. (lines 96–101)
- Minor: `paletteFor(currentTheme)` is re-evaluated every frame (line 146).

### B. CSS effects — constant GPU compositing cost
File: `apps/futuristic/src/app.css`

- `backdrop-filter: blur(...)` (4/8/14/16/18 px) on panes, popovers, chat
  bubbles — repaints on every scroll and every streamed token.
- ~10 **infinite** CSS animations run 24/7: `hero-gradient-shift`,
  `scan-sweep`, `neon-flicker`, `float-y`, `border-pulse`, `caret-blink`,
  `dot-pulse`, plus per-message `status-pulse` / `animate-pulse`.
- Heavy stacked `box-shadow` glows and `filter: drop-shadow(...)` on
  interactive elements.
- No `prefers-reduced-motion` support anywhere.

### C. Editor: full-document stringify on every keystroke
File: `apps/futuristic/src/lib/components/Editor.svelte`, lines 228–240

The CodeMirror `updateListener` does
`tab.content = update.state.doc.toString(); tab.dirty = true;` on **every
keystroke** — an O(document-size) string conversion plus a write into the
reactive `workspaceStore.openTabs` (re-rendering Tabs/Editor each keypress).
This is the one code-path hotspot worth fixing regardless of settings.

### D. Chat streaming: unbatched reactive mutations
Files: `packages/adaan-core/src/stores/chat.svelte.ts`,
`packages/adaan-core/src/stores/chat-events.ts`

Every SSE `text.delta` / `reasoning.delta` mutates `$state` (`msg.content +=
text`, timeline segment append/merge). Each token re-renders the whole
`ChatMessage` component with its `{#each msg.timeline}` block (file:
`ChatMessage.svelte`). Long sessions also keep the full message DOM mounted —
no virtualization. Reasoning blocks default to expanded, inflating DOM.

### E. File tree refetch per agent tool call
File: `apps/futuristic/src/routes/+page.svelte` (lines 188–196,
`onFileChanged={loadTree}`)

On every file-writing tool result, the UI re-fetches the **entire tree** via
`GET /api/files/list`. During an agent run that writes many files this fires
repeatedly.

### F. Bundle weight (minor compared to A–D)
- `three` statically imported (see A). `gsap` statically imported in
  `+layout.svelte`, `+page.svelte`, `WorkspacePicker.svelte`, `StatsView.svelte`,
  `MetricCard.svelte` for one-shot entrance animations (~30 KB gz — optional).
- 5 JetBrains Mono weights loaded (400/500/600/700/800) in
  `src/routes/+layout.svelte`.

---

## 2. The "Performance" settings tab (game-style)

Settings live in the unified schema (`packages/adaan-core/src/stores/settings.ts`;
today `SCHEMA_VERSION = 8` → bump to **9**). Add a nested block so the tab is
one screen with a **preset** picker (Quality / Balanced / Performance /
Custom) plus per-feature overrides — exactly like a game graphics menu.

```ts
performance: {
  preset: "quality" | "balanced" | "performance" | "custom";
  threeEnabled: boolean;            // master WebGL switch (mirrors legacy threeEnabled)
  threeQuality: "low" | "medium" | "high"; // particles 500/2000/5000, DPR cap 1/1.5/2, AA off/on
  pauseWhenHidden: boolean;         // stop rAF when document.hidden
  animationsEnabled: boolean;       // GSAP entrances + infinite CSS animations
  glassEffects: boolean;            // backdrop-filter blur on/off
  streamingRender: "smooth" | "throttled"; // throttle chat token re-renders
  editorLiveSync: boolean;          // false = debounced editor→store sync
  fileTreeRefresh: "immediate" | "throttled";
}
```

Preset semantics:
- **Quality** (default): all eye-candy on, defaults as today.
- **Balanced**: three on (medium quality), pause-when-hidden on, throttled
  file-tree refresh; glass + animations on.
- **Performance**: three off, glass off, animations off, streaming throttled,
  editor sync debounced, tree refresh throttled.
- **Custom**: touching any individual toggle flips preset to `custom`.

UI mechanics:
- One CSS hook does most of the work: the layout applies a `perf-lite` class
  on `<html>`/`<body>`; `app.css` gates `backdrop-filter`, glows, and infinite
  animations under it (e.g. `html:not(.perf-lite) .glass { backdrop-filter: … }`
  and `html.perf-lite * { animation-play-state: paused }`-style overrides, or
  targeted class guards — keep it simple).
- The existing `threeEnabled` toggle currently lives in Settings → General
  (SettingsPanel.svelte ~line 919). Move/keep it synced with
  `performance.threeEnabled` so old blobs migrate cleanly.

---

## 3. Implementation steps (in order)

### Step 1 — Schema + migration (core, testable)
Files: `packages/adaan-core/src/stores/settings.ts`,
`packages/adaan-core/tests/settings.test.ts`

- Add `PerformanceSettings` interface + defaults to `Settings` and
  `DEFAULT_SETTINGS`; bump `SCHEMA_VERSION` to 9.
- Add `safePerformance()` sanitizer mirroring `safeTelemetry()` (clamps/enums,
  corrupt blob → defaults), wire into `migrateBlob`.
- Tests: defaults pass through, corrupt values sanitize, preset enum guarded,
  version bump rewrites. Run `pnpm --filter @adaan/core test`.

### Step 2 — Store helpers + root perf class
Files: `packages/adaan-core/src/stores/settings.svelte.ts`,
`apps/futuristic/src/routes/+layout.svelte`

- Add `setPerformanceParam(key, value)` (like `setTelemetryParam`) and
  `applyPerformancePreset(preset)` that bulk-writes the mapped values and sets
  `preset`.
- Add a derived `perfLite` boolean (true when preset=="performance" or
  glass/animations off); in `+layout.svelte` an `$effect` toggles
  `document.documentElement.classList` `perf-lite`.

### Step 3 — Performance tab UI
File: `apps/futuristic/src/lib/components/SettingsPanel.svelte`

- Add 5th tab id `"performance"` to `TabId`, tab button next to Telemetry.
- Game-style layout: 3 preset buttons (Quality/Balanced/Performance), then a
  toggle list: Three.js background, Three quality (3-way selector), Pause when
  hidden, Animations, Glass effects, Chat render (Smooth/Throttled), Editor
  live-sync, File-tree refresh. Each control writes via Step-2 helpers and
  flips preset to `custom`.

### Step 4 — Three.js fixes (biggest win)
File: `ThreeBackground.svelte`

- **Idle-stop**: in `animate()`, skip `renderer.render` when
  `document.hidden && pauseWhenHidden` (still keep the rAF chain so resume is
  instant; optionally re-check a `visible` flag set by a
  `visibilitychange` listener registered once in `init`).
- **Quality tiers**: map `threeQuality` → `{ particleCount, pixelRatioCap,
  antialias }` used in `init()`; rebuild on quality change via the existing
  theme-style dispose/init path.
- **Dynamic import**: replace `import * as THREE from "three"` with
  `const THREE = await import("three")` inside `init()` (only called when
  enabled) so the ~600 KB chunk leaves the initial bundle. Type-only import
  stays static.
- Minor: cache `paletteFor(currentTheme)` once per init instead of per-frame.

### Step 5 — CSS gating under `perf-lite`
File: `apps/futuristic/src/app.css`

- Wrap `backdrop-filter` rules so `perf-lite` falls back to higher-opacity
  solid backgrounds (e.g. `html:not(.perf-lite) .glass { … }` or override
  `html.perf-lite .glass { backdrop-filter: none }`).
- Disable the infinite animation list under `perf-lite`
  (`animation: none` targeted classes — don't blanket `* { animation: none }`
  because the status pulse-dot and dirty-indicator need care; explicitly list
  hero/scan/neon/float/border-pulse classes).
- Bonus: add `prefers-reduced-motion` media query to force `perf-lite` CSS
  behavior for a11y.

### Step 6 — Editor keystroke fix
File: `Editor.svelte`

- In the `updateListener`, when `performance.editorLiveSync` is false: set
  `tab.dirty = true` only, and capture content lazily (the save handler can
  read `view.state.doc.toString()` at save time; it already does). Optionally
  debounce the store write by 300 ms. When true, keep today's behavior.
  Default presets: Quality/Balanced = true, Performance = false.

### Step 7 — Chat render throttle
Files: `chat.svelte.ts`, `chat-events.ts`

- When `performance.streamingRender === "throttled"`, buffer deltas in a
  plain (non-reactive) string and flush into `$state` on a ~100 ms interval /
  rAF-based flusher stopped on terminal events. "smooth" keeps per-token
  updates. Presets: Performance = throttled.

### Step 8 — File-tree refresh throttle
File: `apps/futuristic/src/routes/+page.svelte`

- Wrap `loadTree` passed as `onFileChanged` in a trailing-edge throttle
  (e.g. 2 s) when `fileTreeRefresh === "throttled"`; still refresh immediately
  on explicit user actions (refresh button, open project).

### Step 9 — Measurement + docs
- Verify: `pnpm --filter @adaan/core test` (migration), build
  `pnpm --filter @adaan/futuristic build` and compare chunk sizes before/after
  Step 4 (three chunk should become async-only).
- Manual check: Performance preset → background off, animations stopped,
  editor still saves, chat still streams (throttled), all three themes render.
- Update `AGENTS.md` "Settings" bullet to mention the Performance tab and the
  `perf-lite` CSS gate.

---

## 4. Non-goals / guardrails

- No behavior change for existing users: defaults = today's look ("Quality").
- Don't touch engine/server code — this plan is render/client-side only.
- Don't virtualize the chat/file tree yet — only if the throttle (Step 7)
  isn't enough. Keep the plan stupid-simple.
- Keep `prefers-reduced-motion` compatibility when killing animations.

## 5. Estimated payoff

- **Step 4** (three hidden-pause + dynamic import): biggest GPU & load win.
- **Step 5** (glass/animation gate): biggest sustained-frame win.
- **Step 6** (editor keystroke): removes the main per-keystroke jank.
- Steps 7–8: fewer re-renders/fetches during agent runs.
