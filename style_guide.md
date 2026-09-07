# AdaanIDE — Style Guide

A reference for the visual language, design patterns, and conventions of the futuristic webapp. Use this when building new components or modifying existing ones.

---

## 1. Architecture

| Layer | What | Where |
|---|---|---|
| **Tokens** | CSS custom properties per theme | `app.css` `:root[data-theme="..."]` blocks |
| **Tailwind** | Utility classes for layout, spacing, flex/grid | `@import "tailwindcss"` at top of `app.css` |
| **Global classes** | Reusable component classes (`.pane`, `.btn`, `.metric-card`, etc.) | `app.css` body |
| **Component styles** | Scoped `<style>` blocks per `.svelte` file | Each component |
| **Performance gating** | `html.perf-lite` class + `@media (prefers-reduced-motion)` | `app.css` end |

Tailwind handles layout utilities (`flex`, `gap`, `overflow`, `max-h-60`, etc.). The custom CSS handles the glassmorphism, glow, and themed visual identity. Components use **both** — Tailwind for structure, `var(--color-*)` and global classes for appearance.

---

## 2. Themes & Color Tokens

Six themes, all sharing the same 37 CSS variables. Only values change. Themes are switched via `data-theme` on `:root`.

| Theme | Selector | Mood |
|---|---|---|
| Retrowave | `[data-theme="retrowave"]` | Dark neon pink/purple/cyan (default) |
| Ghibli | `[data-theme="ghibli"]` | Light warm cream/sage |
| Fiesta | `[data-theme="fiesta"]` | Dark vibrant amber/magenta/cyan |
| Dawn | `[data-theme="dawn"]` | Light warm coral/gold/lavender |
| Synthwave '84 | `[data-theme="synthwave84"]` | Dark neon gold/pink/purple |
| Solarized Dark | `[data-theme="solarizedDark"]` | Dark teal/blue base |

### Core variables (always use these, never hardcode colors)

| Variable | Purpose |
|---|---|
| `--color-bg` | Page background |
| `--color-text` | Primary text |
| `--color-muted` | Secondary/muted text |
| `--color-accent` | Primary accent (links, active states, glows) |
| `--color-accent-secondary` | Secondary accent (gradients) |
| `--color-accent-cyan` | Tertiary accent |
| `--color-success` | Positive feedback |
| `--color-warning` | Warning/amber |
| `--color-error` | Error/destructive |
| `--color-border` | Default border |
| `--color-border-accent` | Accent-tinted border |
| `--color-surface` | Semi-transparent surface fill |
| `--color-surface-solid` | Opaque surface (perf-lite fallback) |
| `--color-surface-glass` | Gradient glass fill |
| `--color-selection` | Text selection highlight |

### RGB channel variables (for `rgba()` tints)

Every color has an `--*-rgb` companion for opacity control:

```css
--accent-rgb: 255, 46, 154;       /* → rgba(var(--accent-rgb), 0.12) */
--accent-2-rgb: 180, 107, 255;
--accent-3-rgb: 46, 230, 255;
--muted-rgb: 122, 106, 168;
--error-rgb: 255, 85, 85;
--success-rgb: 105, 240, 174;
--warning-rgb: 255, 184, 108;
--surface-1-rgb: 22, 10, 53;
--surface-2-rgb: 8, 4, 24;
--bg-deep-rgb: 5, 0, 16;
--shadow-rgb: 0, 0, 0;
```

### Glow & gradient tokens

```css
--glow-accent: 0 0 20px var(--color-accent-glow);
--glow-text: 0 0 10px var(--color-accent-glow);
--color-accent-glow: rgba(var(--accent-rgb), 0.4);
--gradient-spectrum: linear-gradient(90deg, #ff2e9a 0%, #b46bff 25%, #2ee6ff 50%, ...);
```

**Rule:** Never use hardcoded hex colors in component styles. Always reference `var(--color-*)` or `rgba(var(--*-rgb), alpha)`. This ensures every theme works automatically.

---

## 3. Typography

| Property | Value |
|---|---|
| Font family | `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` |
| Applied via | `*, *::before, *::after { font-family: ... !important; }` |
| Base size | `15px` |
| Line height | `1.5` |
| Rendering | `antialiased`, `grayscale`, `optimizeLegibility` |

### Type scale (observed patterns)

| Use case | Size | Weight | Extra |
|---|---|---|---|
| Page/panel title | `1.25rem` (20px) | `800` | `letter-spacing: -0.02em` |
| Section heading | `1rem` (16px) | `800` | — |
| Body text | `0.8125rem` (13px) | `400-500` | — |
| Labels / metadata | `0.6875rem` (11px) | `700` | `letter-spacing: 0.1-0.2em`, `text-transform: uppercase` |
| Micro text | `0.625rem` (10px) | `700` | `letter-spacing: 0.02em` |
| Big metric numbers | `1.5-2rem` | `800` | `text-shadow: 0 0 24px accent-glow` |

**Uppercase labels** with wide letter-spacing are the signature metadata style:
```css
font-size: 0.6875rem;
font-weight: 700;
letter-spacing: 0.2em;
text-transform: uppercase;
color: var(--color-muted);
```

---

## 4. Layout Patterns

### App shell

```
┌──────────────────────────────────────────┐
│ app-bar (z:30)                           │
├──┬───────────────────────────────────────┤
│ M│ mode content (flex-1)                 │
│ o│                                       │
│ d│ ┌─────────┬──────────┬───────────┐    │
│ e│ │ sidebar │ editor   │ chat      │    │
│ R│ │ (pane)  │ (pane)   │ (pane)    │    │
│ a│ │         │          │           │    │
│ i│ │         │          ├───────────┤    │
│ l│ │         │          │ terminal  │    │
│ │ │         │          │ (pane)    │    │
│ └─│ └─────────┴──────────┴───────────┘    │
└──┴───────────────────────────────────────┘
```

- **ModeRail**: 3rem fixed-width vertical nav on the far left
- **App bar**: top bar with brand, project switcher, status, toggles
- **Panes**: each content area is a `.pane` wrapped in `.panel-enter pane pane-bracketed flex flex-col overflow-hidden rounded-lg`
- **Resizers**: 4px drag handles between panes (`.resizer` vertical, `.terminal-resizer` horizontal)

### Panel wrapper convention

Every major content panel uses:
```svelte
<div class="panel-enter pane pane-bracketed flex flex-col overflow-hidden rounded-lg">
```
This gives it the glassmorphism background, corner brackets, and GSAP entrance animation.

### Common layout primitives

| Pattern | Implementation |
|---|---|
| Flex column pane | `flex flex-col` + header + `flex-1 overflow-y-auto` body |
| Split panes | `flex` with fixed-width sidebar + `flex-1` main |
| Masonry grid | `columns: 4; column-gap: 1rem; column-fill: balance` |
| Modal | Fixed backdrop + centered card, `z-index: 100` |
| Dropdown | `relative` trigger + `absolute` menu |

---

## 5. Glassmorphism & Surfaces

### Pane (the fundamental surface)

```css
.pane {
  background: linear-gradient(165deg, rgba(var(--surface-1-rgb), 0.75), rgba(var(--surface-2-rgb), 0.88));
  backdrop-filter: blur(16px);
  border: 1px solid var(--color-border);
  box-shadow:
    0 0 0 1px rgba(var(--accent-rgb), 0.05),
    0 16px 40px -12px rgba(var(--shadow-rgb), 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
```

### Corner brackets (decorative)

`.pane-bracketed::before` draws 12px×1px and 1px×12px accent lines at all four corners. Subtle, `opacity: 0.5`, `z-index: 10`, `pointer-events: none`.

### Glass utility

```css
.glass {
  background: var(--color-surface);
  backdrop-filter: blur(14px);
  border: 1px solid var(--color-border);
}
```

### Card surfaces (metric cards, list items)

```css
background: linear-gradient(165deg, rgba(var(--surface-1-rgb), 0.55-0.92), rgba(var(--surface-2-rgb), 0.65-0.96));
border: 1px solid var(--color-border);
border-radius: 10-12px;
box-shadow: 0 4px 20px rgba(var(--shadow-rgb), 0.2);
```

### Modal surfaces

```css
background: linear-gradient(165deg, rgba(var(--surface-1-rgb), 0.95), rgba(var(--surface-2-rgb), 0.98));
backdrop-filter: blur(20px);
border: 1px solid var(--color-border-accent);
border-radius: 14px;
box-shadow: 0 24px 60px rgba(var(--shadow-rgb), 0.5);
```

---

## 6. Pane Headers

Every pane has a header bar with the same structure:

```css
.pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.45rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
  background: linear-gradient(180deg, rgba(var(--accent-rgb), 0.08), rgba(var(--surface-1-rgb), 0.4));
}
/* Hairline accent under the header */
.pane-header::after {
  content: "";
  position: absolute;
  left: 0; right: 0; bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--color-accent-glow), transparent);
  opacity: 0.4;
}
```

### Pane title

```css
.pane-title {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.pane-title-bar {
  width: 3px; height: 12px; border-radius: 2px;
  background: var(--color-accent);
  box-shadow: 0 0 8px var(--color-accent-glow);
}
```

Usage: `<div class="pane-title"><span class="pane-title-bar"></span> Title</div>`

---

## 7. Buttons

### `.btn` — standard button

```css
.btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  border-radius: 0.375rem;
  font-size: 0.8125rem;
  font-weight: 500;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.btn:hover {
  border-color: var(--color-accent);
  box-shadow: var(--glow-accent);
  transform: translateY(-1px);
}
```

Variants: `.btn-sm`, `.btn-xs`, `.btn-ghost`, `.btn-primary` (gradient fill), `.btn-danger` (red gradient).

### `.icon-btn` — square icon button

```css
.icon-btn {
  width: 2rem; height: 2rem;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: rgba(var(--bg-deep-rgb), 0.4);
  opacity: 0.8;
}
.icon-btn:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
  box-shadow: var(--glow-accent);
  transform: translateY(-1px);
}
.icon-btn.active {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: rgba(var(--accent-rgb), 0.12);
}
```

### Button conventions

- Always `inline-flex` with `align-items: center` and `gap`
- Hover: accent border + glow + slight `translateY(-1px)` lift
- Active/selected: `rgba(var(--accent-rgb), 0.12)` background + accent border
- Disabled: `opacity: 0.3-0.4`, `cursor: not-allowed`, no hover effects
- Danger: red tinted (`rgba(248, 113, 113, 0.12)`) on hover
- Transitions: `0.15-0.2s` with `cubic-bezier(0.16, 1, 0.3, 1)` easing

---

## 8. Badges, Pills & Tags

### Status chip (with pulsing dot)

```css
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.6875rem;
}
.status-chip .dot {
  width: 7px; height: 7px; border-radius: 999px;
  background: var(--color-accent);
  box-shadow: 0 0 8px var(--color-accent);
  animation: dot-pulse 1.5s ease-in-out infinite;
}
```

### Badge / pill

```css
.badge {
  font-size: 0.625rem;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  font-weight: 700;
}
```

Color variants use `rgba()` tints:
- Success: `rgba(34, 197, 94, 0.15)`, `color: rgb(134, 239, 172)`
- Warning: `rgba(234, 179, 8, 0.15)`, `color: rgb(253, 224, 71)`
- Error: `rgba(220, 38, 38, 0.15)`, `color: rgb(252, 165, 165)`
- Info: `rgba(var(--accent-rgb), 0.15)`, `color: var(--color-accent)`

### Extension badges (file tree)

`.ext-badge` with per-language classes (`.ext-ts`, `.ext-js`, `.ext-svelte`, `.ext-py`, etc.) — each with a distinct color.

---

## 9. Form Controls

### Input / textarea

```css
.input, .textarea {
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  border: 1px solid var(--color-border);
  background: rgba(var(--bg-deep-rgb), 0.6);
  color: var(--color-text);
  font-size: 0.8125rem;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.input:focus, .textarea:focus {
  border-color: var(--color-accent);
  box-shadow: var(--glow-accent);
}
```

### Toggle switch

```css
.toggle { width: 36px; height: 20px; border-radius: 999px; }
.toggle-knob { /* slides left/right with transition */ }
```

### Field label convention

```css
font-size: 0.6875rem;
font-weight: 700;
letter-spacing: 0.1em;
text-transform: uppercase;
color: var(--color-muted);
```

---

## 10. Animations

### GSAP entrance patterns

**Header slide-down** (used by StatsView, ReviewPanel):
```js
gsap.from(".stats-header", { y: -20, opacity: 0, duration: 0.5, ease: "power2.out" });
```

**Card stagger** (MetricCard, list items):
```js
gsap.from(cardEl, {
  y: 30, opacity: 0, scale: 0.95,
  duration: 0.6, delay: index * 0.08,
  ease: "power3.out"
});
```

**Panel entrance** (+page.svelte on workspace open):
```js
gsap.from(".panel-enter", { y: 12, opacity: 0, stagger: 0.06, duration: 0.5, ease: "power2.out" });
```

**Landing page timeline** (WorkspacePicker):
- Kicker, glitch title, tagline, pills, console panel all stagger in
- Typewriter effect for tagline
- Count-up animation for stat tiles

### Svelte transitions

| Transition | Usage |
|---|---|
| `fade` | Modal backdrops, error messages |
| `fly={{ y: 16-30, duration: 300-400, easing: cubicInOut }}` | Modal panels, list items, cards |
| `slide` | Expandable sections |

### CSS keyframe animations

| Animation | Duration | Purpose |
|---|---|---|
| `dot-pulse` | 1.5s | Status indicator dots |
| `hero-gradient-shift` | 6s | Animated spectrum gradient text |
| `scan-sweep` | 4s | Horizontal scan line across panes |
| `neon-flicker` | 3.5s | Flickering neon label |
| `float-y` | 5s | Gentle floating card motion |
| `border-pulse` | 2.4s | Pulsing border ring |
| `caret-blink` | 1s | Terminal/typewriter cursor |
| `flash-line-pulse` | 2.5s | CodeMirror line flash on agent edit |
| `glitch-jitter` | 0.4s | RGB-split hover effect |
| `spin` (various) | 0.8s | Loading/refresh spinners |

### Performance gating

All decorative animations are disabled when:
- `html.perf-lite` class is present (Performance preset = Performance/Custom with effects off)
- `@media (prefers-reduced-motion: reduce)` matches

`backdrop-filter: blur()` is replaced with solid surfaces in perf-lite mode.

---

## 11. Icons

**Library:** `@tabler/icons-svelte` (v3.46.0)

**Usage pattern:**
```svelte
import { IconRefresh, IconPlus, IconTrash } from "@tabler/icons-svelte";

<IconRefresh size={16} class="spin" />
```

**Conventions:**
- Size `14-16` for inline buttons, `20-26` for card icons, `32-40` for empty states
- Icons inherit `color: currentColor` — control via parent `color` or `var(--color-accent)`
- Card icons get `filter: drop-shadow(0 0 8px var(--color-accent-glow))`
- `IconRefresh` commonly gets a `.spin` class during loading
- Danger actions use `IconTrash`; confirmations use `IconCheck`; close uses `IconX`

**Available icon names** (verified in this project):
`IconRefresh`, `IconPlus`, `IconTrash`, `IconCheck`, `IconX`, `IconPlayerPlay`, `IconClock`, `IconBolt`, `IconCoin`, `IconStack`, `IconAdjustments`, `IconChevronDown`, `IconChevronRight`, `IconBrandGithub`, `IconAlertTriangle`, `IconFlame`, `IconEye`, `IconCircleCheck`, `IconCircleDot`, `IconSparkles`, `IconSend`, `IconSquare`, `IconBrain`, `IconCpu`, `IconTerminal2`, `IconCode`, `IconFileCode`, `IconFolder`, `IconFolderOpen`, `IconSearch`, `IconPalette`, `IconChartBar`, `IconActivity`, `IconDatabase`, `IconArrowRight`, `IconArrowUp`, `IconKey`, `IconEye`, `IconEyeOff`, `IconCopy`, `IconRoute`, `IconLayers`, `IconGrid3x3`, `IconFlask`, `IconGitCommit`, `IconGitBranch`, `IconFileDiff`, `IconFileDescription`, `IconFolderMinus`, `IconFolderShare`, `IconKeyboard`, `IconClipboard`, `IconClockPause`, `IconCreditCard`, `IconBulb`, `IconColumnInsertLeft`, `IconArrowsHorizontal`, `IconFolderCode`, `IconCube`, `IconAlertCircle`, `IconMinus`, `IconUser`, `IconBrain`, `IconRobot`, `IconBackground`, `IconRestore`, `IconLayout`

> **Note:** `IconLayers` does NOT exist in v3.46.0 — use `IconStack` instead.

---

## 12. Z-Index Layering

| Z-Index | Layer |
|---|---|
| `0` | Three.js background canvas, grid floor |
| `1` | Vignette overlay |
| `10` | Pane corner brackets (decorative) |
| `11` | Diff review toolbar |
| `12` | Pane headers, breadcrumbs, editor status bar |
| `15` | Tab bar |
| `20` | Resizers, scan lines |
| `30` | App bar |
| `60` | Project dropdown |
| `100` | Modal overlays (delete confirm, settings) |

---

## 13. Scrollbars

WebKit-only custom styling (Firefox uses defaults):

```css
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: var(--color-accent);
  box-shadow: 0 0 8px var(--color-accent-glow);
}
```

Thin (5px), transparent track, themed thumb that glows on hover.

---

## 14. Empty States

Consistent pattern across components:

```svelte
<div class="empty-state">
  <IconChartBar size={32} />
  <div>No data yet.</div>
  <div class="empty-hint">Run some tasks to populate the dashboard.</div>
</div>
```

```css
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 2.5-3rem 1rem;
  color: var(--color-muted);
  gap: 0.4-0.5rem;
}
.empty-hint { font-size: 0.6875rem; opacity: 0.6; }
```

The editor's empty state is more elaborate — it uses the `.hero-title` gradient, a rotating reticle ring, and feature pills.

---

## 15. Modals

Consistent modal pattern:

```svelte
<div class="modal-backdrop" transition:fade onclick={close}>
  <div class="modal" transition:fly={{ y: 30 }} onclick={(e) => e.stopPropagation()}>
    <header class="modal-header">
      <span class="modal-title">Title</span>
      <button class="modal-close" onclick={close}><IconX size={16} /></button>
    </header>
    <div class="modal-body"> ... </div>
    <footer class="modal-footer"> ... </footer>
  </div>
</div>
```

```css
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 100;
}
.modal {
  background: linear-gradient(165deg, rgba(var(--surface-1-rgb), 0.95), rgba(var(--surface-2-rgb), 0.98));
  backdrop-filter: blur(20px);
  border: 1px solid var(--color-border-accent);
  border-radius: 14px;
  max-width: 92vw; max-height: 88vh;
  box-shadow: 0 24px 60px rgba(var(--shadow-rgb), 0.5);
}
```

---

## 16. Color-Coded States

### Priority / severity (used in diffs, telemetry, tasks)

| Level | Background | Text color |
|---|---|---|
| Critical (P0 / error / remove) | `rgba(220, 38, 38, 0.15-0.25)` | `rgb(252-254, 165-202, 165-202)` |
| Warning (P1 / modify / warn) | `rgba(234, 88-179, 12-8, 0.15-0.25)` | `rgb(253, 186-224, 116-71)` |
| Info (P2 / added / success) | `rgba(34-80, 197-200, 94-120, 0.14-0.15)` | `rgb(120-134, 220-239, 150-172)` |
| Neutral (P3 / default) | `rgba(120, 120, 140, 0.2-0.25)` | `rgb(200, 200, 210)` |

### Diff colors (CodeMirror + GitHub panel)

| Type | Class | Color |
|---|---|---|
| Added | `.cm-diff-add` / `.diff-badge.add` | Green (`rgba(80, 200, 120, ...)`) |
| Modified | `.cm-diff-modify` / `.diff-badge.modify` | Orange (`rgba(255, 184, 108, ...)`) |
| Removed | `.cm-diff-remove-widget` / `.diff-badge.remove` | Red (`rgba(255, 85, 85, ...)`) |

---

## 17. Component Conventions

### File structure

```svelte
<script lang="ts">
  // 1. Imports (svelte, icons, stores, types)
  // 2. Props ($props)
  // 3. State ($state, $derived)
  // 4. onMount / lifecycle
  // 5. Functions
</script>

<!-- Markup -->

<style>
  /* Scoped styles, using var(--color-*) tokens */
</style>
```

### Naming

- **Components**: PascalCase (`StatsView.svelte`, `MetricCard.svelte`)
- **CSS classes**: kebab-case (`.stats-header`, `.card-grid`)
- **State variables**: camelCase (`selectedConfigId`, `running`)
- **Derived**: `$derived(...)` for computed values
- **Props**: `$props()` with destructuring

### Data fetching

All components fetch from `/api/*` endpoints using `fetch()` in `onMount` or event handlers. No global data store for component data — each component manages its own state.

### Tables

When using HTML tables for data (priority lists, metrics):
```css
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.75rem;
}
th, td {
  border: 1px solid var(--color-border);
  padding: 0.4rem 0.5rem;
  text-align: left;
}
th {
  background: rgba(var(--bg-deep-rgb), 0.5);
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--color-muted);
}
tr:hover td { background: rgba(var(--accent-rgb), 0.04); }
```

---

## 18. Don'ts

- **Don't** hardcode hex colors — use `var(--color-*)` or `rgba(var(--*-rgb), alpha)`
- **Don't** use `backdrop-filter` without a solid fallback (perf-lite mode)
- **Don't** use `z-index` values outside the established layering system
- **Don't** use non-monospace fonts — the entire app is JetBrains Mono
- **Don't** add infinite animations without ensuring they're gated by `perf-lite` and `prefers-reduced-motion`
- **Don't** use `IconLayers` — it doesn't exist in the installed version; use `IconStack`
- **Don't** create new CSS variable names — use the existing 37 tokens
- **Don't** use `{@const}` outside of `{#if}`, `{#each}`, `{#snippet}`, or `{#await}` blocks in Svelte
- **Don't** nest `<button>` inside `<button>` — use `<div>` for the outer element
