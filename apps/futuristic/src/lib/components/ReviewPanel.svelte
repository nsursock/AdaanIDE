<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fly, fade, slide } from "svelte/transition";
  import { cubicInOut } from "svelte/easing";
  import {
    IconRefresh,
    IconPlus,
    IconTrash,
    IconPlayerPlay,
    IconCheck,
    IconX,
    IconBrandGithub,
    IconClock,
    IconBolt,
    IconCoin,
    IconStack,
    IconChevronDown,
    IconChevronRight,
    IconAlertTriangle,
    IconFlame,
    IconEye,
    IconCircleCheck,
    IconCircleDot,
    IconHistory,
    IconSquare,
    IconMessage2,
    IconLayoutGrid,
    IconArrowsSort,
    IconFilter,
    IconSearch,
    IconUpload,
    IconListCheck,
    IconFileText,
    IconDownload,
    IconListDetails,
    IconColumns,
    IconBroadcast,
    IconChartBar,
    IconArrowRight,
    IconTrendingDown,
    IconTrendingUp,
    IconPoint,
  } from "@tabler/icons-svelte";
  import { settingsStore } from "@adaan/core";
  import AggregatorModelPicker from "./AggregatorModelPicker.svelte";
  import type {
    ReviewConfig,
    ReviewResult,
    ReviewTask,
    ReviewPreset,
    ExpertiseLevel,
    GenerationMetadata,
  } from "@adaan/core/server";

  // The barrel exports two `ModelTier` types (registry + review) — use the
  // config field's own type to stay unambiguous.
  type ReviewTier = ReviewConfig["modelTier"];

  let { workspaceRoot = null }: { workspaceRoot?: string | null } = $props();

  // --- State -----------------------------------------------------------------
  let configs = $state<ReviewConfig[]>([]);
  let presets = $state<ReviewPreset[]>([]);
  let results = $state<any[]>([]);
  let freeModels = $state<{ id: string; name: string; paramSize?: string }[]>([]);
  let paidModels = $state<{ id: string; name: string; paramSize?: string }[]>([]);
  let localModels = $state<{ id: string; name: string; providerName?: string }[]>([]);
  /** Model popularity from OpenRouter rankings-daily: permaslug → total
   *  tokens over the last 7 days. Fetched once on mount, used to sort paid
   *  models by popularity so users know which are worth the dollar. */
  let popularity = $state<Map<string, number>>(new Map());
  let popularityLoading = $state(false);
  /** "popular" = sort by popularity (default for paid), "all" = catalog order. */
  let modelSort = $state<"popular" | "all">("popular");
  let selectedConfigId = $state<string | null>(null);
  let selectedResultId = $state<string | null>(null);
  let selectedResult = $state<(ReviewResult & { tasks: ReviewTask[] }) | null>(null);
  let editing = $state<ReviewConfig | null>(null);
  let deletingId = $state<string | null>(null);

  /** Two-way bridge between the timeout UI (minutes) and config.timeoutMs (ms).
   *  0 = use provider default. */
  let timeoutMinutes = $state(5);
  $effect(() => {
    if (editing) {
      timeoutMinutes = editing.timeoutMs ? Math.round(editing.timeoutMs / 60_000) : 5;
    }
  });
  function onTimeoutInput() {
    if (editing) {
      editing.timeoutMs = timeoutMinutes > 0 ? timeoutMinutes * 60_000 : undefined;
    }
  }
  let running = $state(false);
  let backgroundRunning = $state(false);
  /** Id of the run this panel is attached to (for re-attach dedup). Runs are
   *  server-side now — this tracks only the SSE subscription. */
  let attachedRunId = $state<string | null>(null);
  let runLog = $state<string>("");
  let schedulerEnabled = $state(false);
  let error = $state<string | null>(null);
  let creatingIssueIdx = $state<number | null>(null);
  let expandedTaskIdx = $state<number | null>(null);
  /** Task detail modal: the selected task in the Work to Do tab. */
  let detailTask = $state<any>(null);
  /** Bulk GitHub issue creation state. */
  let bulkCreating = $state(false);
  let bulkCreatedCount = $state(0);
  let showResolved = $state(false);
  let showHistory = $state(false);
  let cancelling = $state(false);
  /** Reviewer status cards: one per reviewer model, updated live during a run. */
  let reviewerCards = $state<{ model: string; index: number; status: "running" | "queued" | "done" | "error"; isAggregator?: boolean; error?: string }[]>([]);
  /** Accumulated streaming text per reviewer model. */
  let reviewerTexts = $state<Record<string, string>>({});
  /** Aggregator reasoning text (shown in the aggregator card instead of JSON). */
  let aggregatorReasoning = $state<string>("");
  /** Whether the aggregator has produced any text or reasoning yet — used to
   *  suppress redundant queued transitions from interspersed keep-alives. */
  let aggregatorStarted = $state<boolean>(false);
  /** Current run phase for the progress label. */
  let runPhase = $state<string>("");
  /** Detailed view shows streaming text; simple shows status cards only. */
  let detailedReviewers = $state(true);
  /** Monitoring view mode: "reviews" = per-config review management,
   *  "work" = consolidated "Work to Do" across all configs. */
  let monitorView = $state<"reviews" | "work">("reviews");
  /** Task-list visual layout inside the Reviews tab. Persisted to localStorage. */
  type ReviewViewMode = "cards" | "kanban" | "theater" | "tracker" | "scorecard" | "timeline";
  const VIEW_MODES: { id: ReviewViewMode; label: string; icon: typeof IconHistory }[] = [
    { id: "cards", label: "Cards", icon: IconListDetails },
    { id: "kanban", label: "Kanban", icon: IconColumns },
    { id: "theater", label: "Theater", icon: IconBroadcast },
    { id: "tracker", label: "Tracker", icon: IconListCheck },
    { id: "scorecard", label: "Scorecard", icon: IconChartBar },
    { id: "timeline", label: "Timeline", icon: IconHistory },
  ];
  let reviewViewMode = $state<ReviewViewMode>(
    (typeof localStorage !== "undefined" && (localStorage.getItem("adaan.reviewViewMode") as ReviewViewMode)) || "cards",
  );
  $effect(() => {
    if (typeof localStorage !== "undefined") localStorage.setItem("adaan.reviewViewMode", reviewViewMode);
  });
  /** Upload analysis mode: paste raw reviewer outputs and run only the judge. */
  let uploadMode = $state(false);
  /** Pasted reviewer outputs for upload mode — one entry per reviewer. */
  let uploadReviewers = $state<{ name: string; text: string }[]>([{ name: "reviewer-1", text: "" }]);
  /** Config selected in the upload modal (may differ from selectedConfig). */
  let uploadConfigId = $state<string | null>(null);
  /** Preset selected in the upload modal (used when no saved config is picked). */
  let uploadPresetId = $state<string | null>(null);
  /** All open tasks across all configs (for the Work to Do view). */
  let allTasks = $state<any[]>([]);
  /** Full result shown in the raw-output debug modal. */
  let rawResult = $state<ReviewResult | null>(null);
  let rawLoading = $state(false);
  let genRefreshing = $state(false);
  /** Generation Audit sort state for the raw-output modal. */
  let genSortKey = $state<"time" | "role" | "requested" | "actual" | "provider" | "inTok" | "outTok" | "cost" | "finish">("time");
  let genSortDir = $state<"asc" | "desc">("asc");
  /** Selected key in the raw-output picker (reviewer / judge reasoning / judge JSON). */
  let rawSelectedKey = $state<string | null>(null);
  /** Accordion state for the raw-output modal — only one section open at a time. */
  let genAuditOpen = $state(true);
  let rawOutputOpen = $state(false);
  /** Start Fresh modal: selectively wipe configs, reviews, and/or tasks. */
  let showStartFresh = $state(false);
  let startFreshOpts = $state({ configs: true, results: true, taskLists: true });
  let startFreshBusy = $state(false);

  let selectedConfig = $derived(configs.find((c) => c.id === selectedConfigId) ?? null);
  let configResults = $derived(results.filter((r) => r.configId === selectedConfigId));

  /** Auto-load the latest complete result when switching to a view that needs tasks. */
  $effect(() => {
    if (
      monitorView === "reviews" &&
      reviewViewMode !== "cards" &&
      reviewViewMode !== "timeline" &&
      !selectedResult &&
      !running &&
      configResults.length > 0
    ) {
      const latest = configResults.find((r) => r.status === "complete");
      if (latest) void loadResult(latest.id);
    }
  });

  /** Tasks grouped by lens for the theater view. */
  let tasksByLens = $derived.by(() => {
    if (!selectedResult) return [] as { lens: string; tasks: any[] }[];
    const map = new Map<string, any[]>();
    for (const t of selectedResult.tasks) {
      for (const l of t.lenses ?? []) {
        const arr = map.get(l) ?? [];
        arr.push(t);
        map.set(l, arr);
      }
    }
    return [...map.entries()].map(([lens, tasks]) => ({ lens, tasks }));
  });

  /** Per-lens health grade for the scorecard view: A–F based on open task priorities. */
  let lensGrades = $derived.by(() => {
    if (!selectedResult) return [] as { lens: string; grade: string; score: number; counts: { P0: number; P1: number; P2: number; P3: number } }[];
    const map = new Map<string, { P0: number; P1: number; P2: number; P3: number }>();
    for (const t of selectedResult.tasks) {
      if (t.resolved) continue;
      for (const l of t.lenses ?? []) {
        const c = map.get(l) ?? { P0: 0, P1: 0, P2: 0, P3: 0 };
        c[t.priority as "P0" | "P1" | "P2" | "P3"]++;
        map.set(l, c);
      }
    }
    return [...map.entries()].map(([lens, counts]) => {
      const score = counts.P0 * 4 + counts.P1 * 2 + counts.P2 * 1 + counts.P3 * 0.5;
      const grade = score === 0 ? "A" : score <= 1.5 ? "A-" : score <= 3 ? "B" : score <= 5 ? "B-" : score <= 8 ? "C" : score <= 12 ? "D" : "F";
      return { lens, grade, score, counts };
    }).sort((a, b) => b.score - a.score);
  });

  /** Run-over-run priority deltas for scorecard/timeline. */
  let runDeltas = $derived.by(() => {
    const complete = configResults.filter((r) => r.status === "complete");
    if (complete.length < 2) return null;
    const latest = complete[0];
    const prev = complete[1];
    return {
      p0: (latest.p0 ?? 0) - (prev.p0 ?? 0),
      p1: (latest.p1 ?? 0) - (prev.p1 ?? 0),
      p2: (latest.p2 ?? 0) - (prev.p2 ?? 0),
      p3: (latest.p3 ?? 0) - (prev.p3 ?? 0),
      latest,
      prev,
    };
  });

  /** Sparkline data: P0/P1/P2/P3 counts across recent runs (oldest → newest). */
  let sparklineData = $derived.by(() => {
    const complete = configResults.filter((r) => r.status === "complete").slice(0, 20).reverse();
    return complete.map((r) => ({
      p0: r.p0 ?? 0, p1: r.p1 ?? 0, p2: r.p2 ?? 0, p3: r.p3 ?? 0,
      total: (r.p0 ?? 0) + (r.p1 ?? 0) + (r.p2 ?? 0) + (r.p3 ?? 0),
      id: r.id, date: r.startedAt,
    }));
  });

  /** Tracker detail drawer state. */
  let trackerDetailTask = $state<any>(null);

  /** Scorecard computed values. */
  let healthScore = $derived.by(() => {
    const totalAll = taskStats.open + taskStats.resolved;
    if (totalAll === 0) return 100;
    return Math.round(100 - (taskStats.p0 * 12 + taskStats.p1 * 6 + taskStats.p2 * 3 + taskStats.p3 * 1) / Math.max(totalAll, 1) * 10);
  });
  let netDelta = $derived(runDeltas ? runDeltas.p0 + runDeltas.p1 + runDeltas.p2 + runDeltas.p3 : null);
  let sparklineMaxVal = $derived(Math.max(...sparklineData.map((d) => d.total), 1));
  let topP0Tasks = $derived(selectedResult ? selectedResult.tasks.filter((t) => t.priority === "P0" && !t.resolved) : []);

  // --- Data loading ----------------------------------------------------------
  async function loadAll() {
    error = null;
    try {
      await Promise.all([loadConfigs(), loadResults(), loadScheduler(), loadModels(), loadPopularity()]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function loadConfigs() {
    const qs = workspaceRoot ? `?root=${encodeURIComponent(workspaceRoot)}` : "";
    const res = await fetch(`/api/review/configs${qs}`);
    if (res.ok) {
      const data = await res.json();
      configs = data.configs;
      presets = data.presets;
      if (!selectedConfigId && configs.length > 0) selectedConfigId = configs[0].id;
    }
  }

  async function loadResults() {
    const qs = workspaceRoot ? `?root=${encodeURIComponent(workspaceRoot)}` : "";
    const res = await fetch(`/api/review/results${qs}`);
    if (res.ok) {
      const data = await res.json();
      results = data.results;
      backgroundRunning = results.some((r) => r.status === "running");
      // Keep the open detail view in sync (a background run may have updated it).
      if (selectedResultId && selectedResult) {
        const still = results.find((r) => r.id === selectedResultId);
        if (still && still.completedAt !== selectedResult.completedAt) await loadResult(selectedResultId);
      }
    }
  }

  async function loadResult(id: string) {
    const res = await fetch(`/api/review/results?id=${encodeURIComponent(id)}`);
    if (res.ok) {
      const data = await res.json();
      selectedResult = data.result;
      selectedResultId = id;
    }
  }

  /** Toggle the selected run's task list (View tasks button). */
  function toggleResult(id: string) {
    if (selectedResultId === id) {
      selectedResult = null;
      selectedResultId = null;
    } else {
      void loadResult(id);
    }
  }

  /** Open the raw-output debug modal for a run (reviewer texts + judge JSON). */
  async function openRawOutput(id: string) {
    rawLoading = true;
    rawSelectedKey = null;
    genAuditOpen = true;
    rawOutputOpen = false;
    try {
      const res = await fetch(`/api/review/results?id=${encodeURIComponent(id)}`);
      if (res.ok) {
        rawResult = (await res.json()).result;
      } else {
        const e = await res.json().catch(() => ({}));
        error = e.error ?? "failed to load raw output";
      }
    } finally {
      rawLoading = false;
    }
  }

  /** Fetch generation metadata from OpenRouter for the open raw-output run.
   *  Backfills older runs that didn't auto-enrich, or refreshes stale data. */
  async function refreshGenerationMetadata() {
    if (!rawResult) return;
    genRefreshing = true;
    try {
      const res = await fetch(`/api/review/generations?id=${encodeURIComponent(rawResult.id)}`);
      if (res.ok) {
        const { metadata, actualCost, actualTokens } = await res.json();
        if (metadata && Object.keys(metadata).length > 0) {
          rawResult = { ...rawResult, generationMetadata: metadata, actualCost, actualTokens };
          // Also update the matching entry in the results list
          results = results.map((r) => r.id === rawResult!.id ? { ...r, actualCost, actualTokens } : r);
        }
      }
    } catch { /* best-effort */ } finally {
      genRefreshing = false;
    }
  }

  /** Dump the raw reviewer + judge output from the open modal to a markdown
   *  file for offline debugging and analysis. */
  function dumpRawToMarkdown() {
    if (!rawResult) return;
    const r = rawResult;
    const date = r.startedAt ? new Date(r.startedAt).toISOString().replace(/[:.]/g, "-") : "unknown";
    const lines: string[] = [
      `# Review Raw Output — ${r.configName}`,
      "",
      `- **Run ID:** ${r.id}`,
      `- **Started:** ${r.startedAt ?? "—"}`,
      `- **Completed:** ${r.completedAt ?? "—"}`,
      `- **Status:** ${r.status}`,
      `- **Source:** ${r.source ?? "review"}`,
      `- **Triggered by:** ${r.triggeredBy ?? "—"}`,
      `- **Expertise:** ${r.expertise ?? "—"}`,
      `- **Reviewer models:** ${(r.reviewerModels ?? []).join(", ") || "—"}`,
      `- **Aggregator model:** ${r.aggregatorModel || "—"}`,
      ...(r.actualCost != null ? [`- **Actual cost:** $${r.actualCost.toFixed(4)}`] : r.estimatedCost != null ? [`- **Estimated cost:** $${r.estimatedCost.toFixed(4)}`] : []),
      ...(r.actualTokens != null ? [`- **Actual tokens:** ${r.actualTokens.toLocaleString()}`] : r.estimatedTokens != null ? [`- **Estimated tokens:** ${r.estimatedTokens.toLocaleString()}`] : []),
      ...(r.targetPath ? [`- **Target path:** \`${r.targetPath}\``] : []),
      "",
      "---",
      "",
    ];

    // Generation audit — what OpenRouter actually routed to
    const genMeta = Object.entries(r.generationMetadata ?? {});
    if (genMeta.length > 0) {
      lines.push("## Generation Audit (OpenRouter)", "");
      lines.push("| Role | Requested | Actual Model | Provider | In tok | Out tok | Cost | Finish |");
      lines.push("|---|---|---|---|---|---|---|---|");
      for (const [key, meta] of genMeta) {
        const parsed = parseGenerationKey(key, r.aggregatorModel);
        const mismatch = isRealFailover(parsed.requestedModel, meta.model) ? " ⚠" : "";
        lines.push(
          `| ${parsed.role === "aggregator" ? "Judge" : "Reviewer"} | ${parsed.requestedModel} | ${meta.model}${mismatch} | ${meta.providerName ?? "—"} | ${meta.tokensPrompt.toLocaleString()} | ${meta.tokensCompletion.toLocaleString()} | ${meta.totalCost > 0 ? `$${meta.totalCost.toFixed(5)}` : "free"} | ${meta.finishReason ?? "—"} |`,
        );
      }
      lines.push("", "---", "");
    }

    const entries = Object.entries(r.rawOutputs ?? {});
    if (entries.length > 0) {
      lines.push(`## Reviewer Outputs (${entries.length})`, "");
      for (const [model, text] of entries) {
        lines.push(
          `### ${r.source === "upload" ? "Pasted analysis" : "Reviewer"}: ${modelLabel(model)}`,
          "",
          `**Model ID:** \`${model}\``,
          `**Length:** ${text.length.toLocaleString()} chars`,
          "",
          "```",
          text || "(empty output)",
          "```",
          "",
        );
      }
    } else {
      lines.push("## Reviewer Outputs", "", "No reviewer output was captured for this run.", "");
    }

    lines.push("## Judge / Aggregator Reasoning", "");
    if (r.aggregatorReasoning) {
      lines.push(
        `**Model:** ${modelLabel(r.aggregatorModel)}`,
        `**Model ID:** \`${r.aggregatorModel}\``,
        `**Length:** ${r.aggregatorReasoning.length.toLocaleString()} chars`,
        "",
        "```",
        r.aggregatorReasoning,
        "```",
        "",
      );
    } else {
      lines.push("No judge reasoning was captured for this run.", "");
    }

    lines.push("## Judge / Aggregator JSON Output", "");
    if (r.aggregatorOutput) {
      lines.push(
        `**Model:** ${modelLabel(r.aggregatorModel)}`,
        `**Model ID:** \`${r.aggregatorModel}\``,
        `**Length:** ${r.aggregatorOutput.length.toLocaleString()} chars`,
        "",
        "```json",
        r.aggregatorOutput,
        "```",
        "",
      );
    } else {
      lines.push("Judge JSON output was not captured for this run.", "");
      if (r.taskListSource === "fallback") {
        lines.push("_Task list was built from consolidated reviewer priority tables (judge fallback)._", "");
      }
    }

    const md = lines.join("\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `review-${date}-${r.id}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function loadScheduler() {
    const res = await fetch("/api/review/scheduler");
    if (res.ok) {
      schedulerEnabled = (await res.json()).enabled;
    }
  }

  async function loadModels() {
    const res = await fetch("/api/review/models");
    if (res.ok) {
      const data = await res.json();
      freeModels = data.free ?? [];
      paidModels = data.paid ?? [];
      localModels = data.local ?? [];
    }
  }

  /** Fetch model popularity from OpenRouter rankings-daily (last 7 days).
   *  Best-effort — silently skips on error. Used to sort paid models so
   *  users know which are worth the dollar. */
  async function loadPopularity() {
    popularityLoading = true;
    try {
      const res = await fetch("/api/review/popularity");
      if (res.ok) {
        const data = await res.json();
        const map = new Map<string, number>();
        for (const m of data.models ?? []) {
          map.set(m.permaslug, m.tokens);
        }
        popularity = map;
      }
    } catch { /* best-effort */ } finally {
      popularityLoading = false;
    }
  }

  async function loadAllTasks() {
    const qs = workspaceRoot ? `?root=${encodeURIComponent(workspaceRoot)}` : "";
    const res = await fetch(`/api/review/tasks/all${qs}`);
    if (res.ok) {
      const data = await res.json();
      allTasks = data.tasks;
    }
  }

  function selectConfig(id: string) {
    selectedConfigId = id;
    expandedTaskIdx = null;
    // Show the config's latest run (its living task list).
    const latest = results.find((r) => r.configId === id);
    if (latest) void loadResult(latest.id);
    else { selectedResult = null; selectedResultId = null; }
  }

  // --- Background updates ------------------------------------------------------
  // The scheduler runs reviews server-side without SSE. Poll gently so the UI
  // reflects scheduled runs; poll eagerly only while something is running.
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastPoll = 0;

  onMount(() => {
    void loadAll().then(discoverActiveRuns);
    // Entrance animation is handled by the parent (+page.svelte) which
    // animates all .panel-enter elements. Don't re-animate here — it
    // conflicts with the parent's stagger and leaves panels dimmed.
    pollTimer = setInterval(() => {
      const active = running || backgroundRunning;
      const interval = active ? 4_000 : schedulerEnabled ? 20_000 : 60_000;
      if (Date.now() - lastPoll < interval) return;
      lastPoll = Date.now();
      void loadResults();
      void loadScheduler();
      void loadConfigs();
      if (!running) void discoverActiveRuns();
      if (monitorView === "work") void loadAllTasks();
    }, 2_000);
  });

  onDestroy(() => { if (pollTimer) clearInterval(pollTimer); });

  /** Runs are server-side and survive disconnects. Discover any in-flight run
   *  for this workspace and re-attach this panel's live view to it (a no-op
   *  if we're already attached). */
  async function discoverActiveRuns() {
    if (running && attachedRunId) return;
    const active = await fetchActiveRuns();
    if (active.length > 0) await attachToRun(active[0].resultId);
  }

  // Reload configs/results when the workspace changes (project switch).
  $effect(() => {
    if (workspaceRoot) {
      selectedConfigId = null;
      selectedResult = null;
      selectedResultId = null;
      // A run for another project keeps going server-side; detach locally and
      // discover whether THIS project has one in flight.
      attachedRunId = null;
      running = false;
      void loadAll().then(discoverActiveRuns);
    }
  });

  // --- Config editing --------------------------------------------------------
  function newConfig() {
    editing = {
      id: "",
      name: "New Review",
      lenses: (presets.find((p) => p.smokeTest)?.lenses ?? presets[0]?.lenses ?? []).map((l) => ({ ...l })),
      expertise: "top-1%",
      modelTier: "free",
      reviewerModels: [],
      aggregatorModel: "openrouter/auto",
      intervalValue: 24,
      intervalUnit: "hours",
      targetPath: undefined,
      workspaceRoot: workspaceRoot ?? undefined,
      createGitHubIssues: false,
      writeTasksFile: false,
      enabled: false,
    };
  }

  function clonePreset(preset: ReviewPreset) {
    editing = {
      id: "",
      name: preset.name,
      lenses: preset.lenses.map((l) => ({ ...l })),
      expertise: "top-1%",
      modelTier: "free",
      reviewerModels: [],
      aggregatorModel: "openrouter/auto",
      intervalValue: preset.smokeTest ? 0 : 24,
      intervalUnit: "hours",
      targetPath: undefined,
      workspaceRoot: workspaceRoot ?? undefined,
      createGitHubIssues: false,
      writeTasksFile: false,
      enabled: false,
    };
  }

  function editConfig(c: ReviewConfig) {
    editing = JSON.parse(JSON.stringify(c));
  }

  /** Clone a preset into a temp config and immediately run it (timeline composer). */
  async function clonePresetAndRun(preset: ReviewPreset) {
    const tempConfig: ReviewConfig = {
      id: "",
      name: preset.name,
      lenses: preset.lenses.map((l) => ({ ...l })),
      expertise: "top-1%",
      modelTier: "free",
      reviewerModels: [],
      aggregatorModel: "openrouter/auto",
      intervalValue: 0,
      intervalUnit: "hours",
      targetPath: undefined,
      workspaceRoot: workspaceRoot ?? undefined,
      createGitHubIssues: false,
      writeTasksFile: false,
      enabled: false,
    };
    await runReviewNow(tempConfig);
  }

  function removeLens(idx: number) {
    if (!editing) return;
    editing.lenses = editing.lenses.filter((_, i) => i !== idx);
  }

  function addLens() {
    if (!editing) return;
    editing.lenses = [
      ...editing.lenses,
      { id: `lens-${Date.now()}`, emoji: "🔍", code: "", label: "New Lens" },
    ];
  }

  async function saveConfig() {
    if (!editing) return;
    const res = await fetch("/api/review/configs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing),
    });
    if (res.ok) {
      const { config } = await res.json();
      editing = null;
      await loadConfigs();
      selectConfig(config.id);
    } else {
      const e = await res.json().catch(() => ({}));
      error = e.error ?? "save failed";
    }
  }

  async function confirmDelete() {
    if (!deletingId) return;
    const res = await fetch(`/api/review/configs?id=${encodeURIComponent(deletingId)}`, { method: "DELETE" });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      error = e.error ?? "delete failed";
      deletingId = null;
      return;
    }
    if (selectedConfigId === deletingId) { selectedConfigId = null; selectedResult = null; selectedResultId = null; }
    deletingId = null;
    await loadConfigs();
    await loadResults();
  }

  /** Wipe monitoring data selectively — configs, run history, and/or living
   *  task lists. Cancels any in-flight runs first. */
  async function startFresh() {
    if (!startFreshOpts.configs && !startFreshOpts.results && !startFreshOpts.taskLists) return;
    startFreshBusy = true;
    try {
      const res = await fetch("/api/review/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startFreshOpts),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        error = e.error ?? "reset failed";
        return;
      }
      // Reset local state.
      if (startFreshOpts.configs) { selectedConfigId = null; editing = null; }
      if (startFreshOpts.results) { selectedResult = null; selectedResultId = null; }
      running = false;
      backgroundRunning = false;
      attachedRunId = null;
      reviewerCards = [];
      reviewerTexts = {};
      aggregatorReasoning = "";
    aggregatorStarted = false;
      showStartFresh = false;
      await loadAll();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      startFreshBusy = false;
    }
  }

  // --- Scheduler -------------------------------------------------------------
  async function toggleScheduler() {
    const v = !schedulerEnabled;
    schedulerEnabled = v;
    settingsStore.setMonitoringEnabled(v);
    await fetch("/api/review/scheduler", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: v }),
    });
  }

  // --- Run a review ----------------------------------------------------------

  /** Read an SSE run stream to completion, feeding handleProgress. Resolves
   *  with the final result id (complete/error/cancelled), or null on
   *  disconnect — a disconnect is NOT an error: the run keeps going
   *  server-side and is re-attachable. */
  async function consumeRunStream(res: Response): Promise<string | null> {
    if (!res.ok || !res.body) {
      const e = await res.json().catch(() => ({}));
      error = e.error ?? "run failed";
      return null;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResultId: string | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.replace(/^data: /, "").trim();
        if (!data) continue;
        try {
          const ev = JSON.parse(data);
          handleProgress(ev);
          if (ev.phase === "complete") finalResultId = ev.result?.id ?? null;
          if (ev.phase === "error") error = ev.message;
        } catch { /* ignore */ }
      }
    }
    return finalResultId;
  }

  /** After a run stream ends: refresh run history and open the final result.
   *  If the stream dropped mid-run (network hiccup), discover + re-attach. */
  async function settleAfterRun(finalResultId: string | null) {
    await loadResults();
    if (finalResultId) {
      attachedRunId = null;
      running = false;
      cancelling = false;
      await loadResult(finalResultId);
      return;
    }
    // Stream ended without a terminal event — check if the run is still alive
    // server-side and re-attach.
    const active = await fetchActiveRuns();
    if (active.length > 0) {
      await attachToRun(active[0].resultId);
      return;
    }
    running = false;
    cancelling = false;
    attachedRunId = null;
    backgroundRunning = false;
  }

  async function runReviewNow(config: ReviewConfig) {
    if (!workspaceRoot) { error = "Open a workspace first."; return; }
    running = true;
    cancelling = false;
    runLog = "";
    runPhase = "";
    reviewerCards = [];
    reviewerTexts = {};
    aggregatorReasoning = "";
    aggregatorStarted = false;
    error = null;
    try {
      const res = await fetch("/api/review/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          config.id ? { configId: config.id, workspaceRoot } : { config, workspaceRoot },
        ),
      });
      const finalResultId = await consumeRunStream(res);
      await settleAfterRun(finalResultId);
    } catch (e) {
      // Aborted fetch throws a TypeError — don't show it as an error if we cancelled.
      if (!cancelling) error = e instanceof Error ? e.message : String(e);
      running = false;
      cancelling = false;
    }
  }

  /** Resume an interrupted run — reuses persisted reviewer outputs, re-runs
   *  only the missing/failed reviewers, then aggregates. */
  async function resumeRunNow(resultId: string) {
    if (!workspaceRoot) { error = "Open a workspace first."; return; }
    running = true;
    cancelling = false;
    runLog = "Resuming…";
    runPhase = "";
    reviewerCards = [];
    reviewerTexts = {};
    aggregatorReasoning = "";
    aggregatorStarted = false;
    error = null;
    try {
      const res = await fetch("/api/review/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId, workspaceRoot }),
      });
      const finalResultId = await consumeRunStream(res);
      await settleAfterRun(finalResultId);
    } catch (e) {
      if (!cancelling) error = e instanceof Error ? e.message : String(e);
      running = false;
      cancelling = false;
    }
  }

  /** Attach this panel's live view to an in-flight server-side run. */
  async function attachToRun(runId: string) {
    if (attachedRunId === runId && running) return;
    attachedRunId = runId;
    running = true;
    cancelling = false;
    error = null;
    try {
      const res = await fetch(`/api/review/run?runId=${encodeURIComponent(runId)}`);
      const finalResultId = await consumeRunStream(res);
      await settleAfterRun(finalResultId);
    } catch {
      running = false;
      attachedRunId = null;
    }
  }

  /** Query the server for runs in flight on this workspace (runs survive
   *  disconnects — this is how we re-discover them after a project switch,
   *  tab reload, or app restart-while-running). */
  async function fetchActiveRuns(): Promise<{ resultId: string; configId: string; configName: string }[]> {
    try {
      const qs = workspaceRoot ? `?root=${encodeURIComponent(workspaceRoot)}` : "";
      const res = await fetch(`/api/review/runs${qs}`);
      if (res.ok) return (await res.json()).runs ?? [];
    } catch { /* best-effort */ }
    return [];
  }

  async function cancelRun() {
    cancelling = true;
    try {
      await fetch("/api/review/cancel", { method: "POST" });
    } catch { /* best-effort */ }
  }

  function handleProgress(ev: any) {
    runPhase = ev.phase;
    switch (ev.phase) {
      case "run.started":
        // First event of every run (also first on re-attach replay) — reset
        // the live view so replayed events rebuild it cleanly.
        attachedRunId = ev.runId;
        running = true;
        runLog = ev.resumed ? `Resuming "${ev.configName}"…` : `Running "${ev.configName}"…`;
        reviewerCards = [];
        reviewerTexts = {};
        aggregatorReasoning = "";
    aggregatorStarted = false;
        break;
      case "context": runLog = "Gathering context…"; break;
      case "cost": runLog = `Est. cost: $${ev.estimatedCost} · ${ev.estimatedTokens.toLocaleString()} tokens`; break;
      case "committee": runLog = ev.message; break;
      case "committee.start":
        // Add a reviewer card if not already present.
        if (!reviewerCards.some((c) => c.model === ev.model)) {
          reviewerCards = [...reviewerCards, { model: ev.model, index: ev.reviewerIndex, status: "running" }];
        }
        break;
      case "committee.queued":
        // Mark the reviewer card as queued at the provider — but ONLY before
        // any text has arrived. OpenRouter sends PROCESSING keep-alives
        // throughout the stream; without this guard the card would flash
        // between queued/running on every keep-alive after the first token.
        if (!(reviewerTexts[ev.model] ?? "").trim()) {
          reviewerCards = reviewerCards.map((c) =>
            c.model === ev.model && c.index === ev.reviewerIndex && c.status === "running"
              ? { ...c, status: "queued" }
              : c,
          );
          runLog = `${modelLabel(ev.model)} queued at provider…`;
        }
        break;
      case "committee.delta":
        // Accumulate streaming text per reviewer; transition out of queued state.
        reviewerTexts = { ...reviewerTexts, [ev.model]: (reviewerTexts[ev.model] ?? "") + ev.text };
        reviewerCards = reviewerCards.map((c) =>
          c.model === ev.model && c.status === "queued" ? { ...c, status: "running" } : c,
        );
        break;
      case "committee.retry": {
        // Same-model retry (possibly with a raised token budget). Update
        // the card status and log — no card swap since the model is the same.
        runLog = `Retrying ${modelLabel(ev.model)} (${ev.maxTokens} tokens): ${ev.reason}`;
        break;
      }
      case "committee.failover": {
        // A reviewer errored or returned empty output — mark the failed
        // model's card and add a fresh card for the spare so its streaming
        // deltas have somewhere to land.
        reviewerCards = reviewerCards.map((c) =>
          c.model === ev.from && c.index === ev.reviewerIndex
            ? { ...c, status: "error", error: `failed → ${modelLabel(ev.to)}` }
            : c,
        );
        if (!reviewerCards.some((c) => c.model === ev.to && c.index === ev.reviewerIndex)) {
          reviewerCards = [...reviewerCards, { model: ev.to, index: ev.reviewerIndex, status: "running" }];
        }
        runLog = `${modelLabel(ev.from)} failed (${ev.reason}) → retrying with ${modelLabel(ev.to)}`;
        break;
      }
      case "committee.done":
        reviewerCards = reviewerCards.map((c) =>
          c.model === ev.model ? { ...c, status: ev.error ? "error" : "done", error: ev.error ?? undefined } : c,
        );
        runLog = ev.error
          ? `Reviewer ${ev.model.split("/").pop()} failed: ${ev.error}`
          : `Reviewer ${ev.model.split("/").pop()} done (${ev.reviewerIndex + 1})`;
        break;
      case "parse":
        // Mark the aggregator card as done when we move past aggregation.
        reviewerCards = reviewerCards.map((c) => c.isAggregator && (c.status === "running" || c.status === "queued") ? { ...c, status: "done" } : c);
        runLog = ev.message ?? "Parsing outputs…";
        break;
      case "aggregator":
        runLog = `Aggregating (${ev.model.split("/").pop()})…`;
        // Add the aggregator as a special reviewer card if not present.
        if (!reviewerCards.some((c) => c.isAggregator)) {
          reviewerCards = [...reviewerCards, { model: ev.model, index: reviewerCards.length, status: "running", isAggregator: true }];
        }
        break;
      case "aggregator.queued":
        // Only show queued before any output — same guard as committee.queued.
        if (!aggregatorStarted) {
          reviewerCards = reviewerCards.map((c) =>
            c.isAggregator && c.status === "running" ? { ...c, status: "queued" } : c,
          );
          runLog = `Aggregator (${modelLabel(ev.model)}) queued at provider…`;
        }
        break;
      case "aggregator.delta":
        // JSON output — don't show in the card (it's not useful to watch).
        // Transition out of queued state; just update the run log.
        aggregatorStarted = true;
        reviewerCards = reviewerCards.map((c) =>
          c.isAggregator && c.status === "queued" ? { ...c, status: "running" } : c,
        );
        runLog = `Aggregator producing JSON…`;
        break;
      case "aggregator.reasoning":
        aggregatorReasoning += ev.text;
        aggregatorStarted = true;
        reviewerCards = reviewerCards.map((c) =>
          c.isAggregator && c.status === "queued" ? { ...c, status: "running" } : c,
        );
        runLog = `Aggregator thinking…`;
        break;
      case "aggregator.retry": {
        // Same-model retry for the judge (possibly with a raised token budget).
        aggregatorStarted = false;
        aggregatorReasoning = "";
        runLog = `Retrying judge ${modelLabel(ev.model)} (${ev.maxTokens} tokens): ${ev.reason}`;
        break;
      }
      case "aggregator.failover": {
        // The judge model errored or produced only truncated/degenerate
        // reasoning — mark its card as errored and add a fresh card for
        // the replacement model so its streaming has somewhere to land.
        aggregatorStarted = false;
        aggregatorReasoning = "";
        reviewerCards = reviewerCards.map((c) =>
          c.isAggregator && c.model === ev.from ? { ...c, status: "error", error: ev.reason } : c,
        );
        reviewerCards = [...reviewerCards, { model: ev.to, index: reviewerCards.length, status: "running", isAggregator: true }];
        runLog = `Aggregator ${modelLabel(ev.from)} → ${modelLabel(ev.to)}: ${ev.reason}`;
        break;
      }
      case "github": runLog = `GitHub: ${ev.message}`; break;
      case "complete": runLog = "Complete."; break;
      case "cancelled": runLog = "Cancelled."; break;
      case "error": runLog = `Error: ${ev.message}`; break;
    }
  }

  async function runFromEditor() {
    if (!editing || !workspaceRoot) return;
    const config = { ...editing, workspaceRoot: editing.workspaceRoot || workspaceRoot };
    editing = null;
    await runReviewNow(config);
  }

  // --- Task state --------------------------------------------------------------
  async function toggleTaskResolved(task: ReviewTask) {
    if (!selectedConfigId || !task.fingerprint) return;
    const res = await fetch("/api/review/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configId: selectedConfigId, fingerprint: task.fingerprint, resolved: !task.resolved }),
    });
    if (res.ok && selectedResult) {
      await loadResult(selectedResult.id);
      void loadResults();
    }
  }

  // --- GitHub issue ------------------------------------------------------------
  async function createIssue(resultId: string, taskIndex: number) {
    if (!workspaceRoot) return;
    creatingIssueIdx = taskIndex;
    try {
      const res = await fetch("/api/review/issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId, taskIndex, workspaceRoot }),
      });
      if (res.ok) {
        const { url } = await res.json();
        if (url && selectedResult) {
          selectedResult.tasks[taskIndex].githubUrl = url;
          selectedResult = { ...selectedResult };
        }
      } else {
        const e = await res.json().catch(() => ({}));
        error = e.error ?? "issue creation failed";
      }
    } finally {
      creatingIssueIdx = null;
    }
  }

  /** Open the task detail modal (from Work to Do tab). */
  function openTaskDetail(task: any) {
    detailTask = task;
  }

  /** Create a GitHub issue for a task from the detail modal. */
  async function createIssueFromDetail() {
    if (!detailTask || !workspaceRoot) return;
    const task = detailTask;
    // Find the result id for this task's config.
    const result = results.find((r) => r.configId === task.configId);
    if (!result) { error = "Review result not found for this task."; return; }
    // Find the task index in that result.
    const fullResult = await fetch(`/api/review/results?id=${result.id}`).then((r) => r.json()).then((d) => d.result);
    if (!fullResult) { error = "Full review result not found."; return; }
    const taskIdx = fullResult.tasks.findIndex((t: any) =>
      (t.fingerprint && t.fingerprint === task.fingerprint) || t.issue === task.issue,
    );
    if (taskIdx < 0) { error = "Task not found in review result."; return; }

    creatingIssueIdx = taskIdx;
    try {
      const res = await fetch("/api/review/issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId: result.id, taskIndex: taskIdx, workspaceRoot }),
      });
      if (res.ok) {
        const { url } = await res.json();
        if (url) {
          detailTask = { ...detailTask, githubUrl: url };
          // Refresh all tasks so the table reflects the link.
          void loadAllTasks();
        }
      } else {
        const e = await res.json().catch(() => ({}));
        error = e.error ?? "issue creation failed";
      }
    } finally {
      creatingIssueIdx = null;
    }
  }

  /** Bulk-create GitHub issues for all open tasks without one. Skips tasks
   *  that already have a githubUrl (sync — no duplicates). */
  async function bulkCreateIssues() {
    const toCreate = allTasks.filter((t) => !t.resolved && !t.githubUrl);
    if (toCreate.length === 0) return;
    bulkCreating = true;
    bulkCreatedCount = 0;
    try {
      for (const task of toCreate) {
        const result = results.find((r) => r.configId === task.configId);
        if (!result) continue;
        const fullResult = await fetch(`/api/review/results?id=${result.id}`).then((r) => r.json()).then((d) => d.result);
        if (!fullResult) continue;
        const taskIdx = fullResult.tasks.findIndex((t: any) =>
          (t.fingerprint && t.fingerprint === task.fingerprint) || t.issue === task.issue,
        );
        if (taskIdx < 0) continue;
        try {
          const res = await fetch("/api/review/issue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ resultId: result.id, taskIndex: taskIdx, workspaceRoot }),
          });
          if (res.ok) {
            const { url } = await res.json();
            if (url) task.githubUrl = url;
          }
        } catch { /* continue to next task */ }
        bulkCreatedCount++;
      }
      void loadAllTasks();
    } finally {
      bulkCreating = false;
      bulkCreatedCount = 0;
    }
  }

  // --- Helpers -----------------------------------------------------------------
  function priorityIcon(p: string) {
    return p === "P0" ? IconFlame : p === "P1" ? IconAlertTriangle : p === "P2" ? IconCircleDot : IconCircleCheck;
  }
  function fmtDate(s?: string): string {
    if (!s) return "—";
    try { return new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return s; }
  }
  function fmtCost(c?: number): string {
    if (c == null) return "—";
    if (c < 0.01) return `$${c.toFixed(4)}`;
    return `$${c.toFixed(2)}`;
  }
  function tierLabel(t: ReviewTier) { return t === "free" ? "Free" : t === "paid" ? "Paid" : "All"; }
  function intervalLabel(c: ReviewConfig): string {
    if (c.intervalValue <= 0) return "manual";
    return `every ${c.intervalValue} ${c.intervalUnit.slice(0, c.intervalValue > 1 ? undefined : -1)}`;
  }

  /** Derive the canonical 3-5 letter short code from a lens label
   *  (same algorithm the server uses). */
  function lensCodeFromLabel(label: string): string {
    const words = label.replace(/[^a-zA-Z\s]/g, "").split(/\s+/).filter(Boolean);
    if (words.length === 1) return words[0].slice(0, 4).toUpperCase();
    if (words.length === 2) return (words[0].slice(0, 2) + words[1].slice(0, 2)).toUpperCase();
    return words.map((w) => w[0]).join("").slice(0, 5).toUpperCase();
  }

  /** Build a lens id → label map from all known presets and saved configs.
   *  Also maps short codes (3-5 letter abbreviations) to full labels. */
  const lensLabelMap = $derived.by(() => {
    const map = new Map<string, string>();
    const addLens = (l: { id: string; label: string; code?: string }) => {
      map.set(l.id, l.label);
      map.set(l.label, l.label);
      map.set(lensCodeFromLabel(l.label), l.label);
      if (l.code?.trim()) map.set(l.code.trim().toUpperCase(), l.label);
    };
    for (const p of presets) for (const l of p.lenses) addLens(l);
    for (const c of configs) for (const l of c.lenses) addLens(l);
    return map;
  });

  /** All known lenses with a letter skeleton, for fuzzy code resolution. */
  const lensCandidates = $derived.by(() => {
    const arr: { label: string; skeleton: string; configId: string | null }[] = [];
    const add = (label: string, configId: string | null) => {
      arr.push({ label, skeleton: label.replace(/[^a-zA-Z]/g, "").toUpperCase(), configId });
    };
    for (const p of presets) for (const l of p.lenses) add(l.label, null);
    for (const c of configs) for (const l of c.lenses) add(l.label, c.id);
    return arr;
  });

  function isSubsequence(needle: string, hay: string): boolean {
    let i = 0;
    for (const ch of hay) {
      if (ch === needle[i]) i++;
      if (i === needle.length) return true;
    }
    return false;
  }

  /** Lens id/code/label → emoji, so table chips are instantly recognizable. */
  const lensEmojiMap = $derived.by(() => {
    const map = new Map<string, string>();
    const add = (l: { id: string; emoji: string; label: string; code?: string }) => {
      map.set(l.id, l.emoji);
      map.set(l.label, l.emoji);
      map.set(lensCodeFromLabel(l.label), l.emoji);
      if (l.code?.trim()) map.set(l.code.trim().toUpperCase(), l.emoji);
    };
    for (const p of presets) for (const l of p.lenses) add(l);
    for (const c of configs) for (const l of c.lenses) add(l);
    return map;
  });
  function lensEmoji(id: string): string {
    return lensEmojiMap.get(id) ?? "🔍";
  }

  /** Legend entries for the lenses actually present in a set of tasks:
   *  emoji + code + full label (popover) + open-task count. Clicking an entry
   *  toggles the lens filter, so codes become self-explanatory. */
  function buildLensLegend(tasks: { resolved?: boolean; lenses: string[] }[]): { key: string; emoji: string; label: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const t of tasks) {
      if (t.resolved) continue;
      for (const l of t.lenses ?? []) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([key, count]) => ({ key, count, emoji: lensEmoji(key), label: lensLabel(key) }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }

  /** Vendor color dot for reviewer chips (theme tokens only). */
  function reviewerDot(friendly: string): string {
    const f = friendly.toLowerCase();
    if (f.includes("chatgpt") || f.includes("gpt") || f.includes("openai")) return "var(--color-success)";
    if (f.includes("claude") || f.includes("anthropic")) return "var(--color-warning)";
    if (f.includes("gemini") || f.includes("google")) return "var(--color-accent-2)";
    if (f.includes("deepseek")) return "var(--color-accent)";
    if (f.includes("qwen")) return "var(--color-accent-cyan)";
    if (f.includes("grok")) return "var(--color-error)";
    return "var(--color-muted)";
  }

  /** Resolve a lens id or short code to the full role label used in the
   *  review config — e.g. "STAT" → "Statistician". Judges often invent their
   *  own codes (MLAI, EVAL, SOFT), so unresolved codes are matched fuzzily
   *  against the config's lens labels (prefix, then letter subsequence),
   *  preferring the config that produced the task. */
  function lensLabel(id: string, preferConfigId?: string | null): string {
    const exact = lensLabelMap.get(id);
    if (exact) return exact;
    const up = id.toUpperCase();
    if (up.length >= 3) {
      const own = preferConfigId ? lensCandidates.filter((c) => c.configId === preferConfigId) : [];
      const pool = [...own, ...lensCandidates];
      const match =
        pool.find((c) => c.skeleton.startsWith(up)) ??
        pool.find((c) => isSubsequence(up, c.skeleton));
      if (match) return match.label;
    }
    return id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Role suffixes that add no meaning in a compact table chip —
   *  "Evaluation & Metrics Specialist" → "Evaluation & Metrics". */
  const LENS_ROLE_SUFFIX = /\s+\b(specialist|engineer|researcher|analyst|consultant|coordinator|officer|manager|lead|expert)$/i;

  /** Compact chip label for tables: strip the role suffix, cap the length.
   *  "Data Scientist" stays as-is; full label is kept for tooltips. */
  function lensShortLabel(id: string, preferConfigId?: string | null): string {
    const full = lensLabel(id, preferConfigId);
    let s = full.replace(LENS_ROLE_SUFFIX, "").trim() || full;
    if (s.length > 22) {
      const cut = s.slice(0, 21);
      const sp = cut.lastIndexOf(" ");
      s = (sp > 8 ? cut.slice(0, sp) : cut).trim() + "…";
    }
    return s;
  }

  /** True failover detection for the Generation Audit table. OpenRouter's
   *  catalog often has date-suffixed canonical slugs (e.g. requested
   *  "openai/gpt-5.6-luna" actually resolves to "openai/gpt-5.6-luna-20260709")
   *  — that's normal version pinning, NOT a failover to a different model.
   *  Only flag it when the base model (with any trailing "-YYYYMMDD"-style
   *  date suffix stripped) genuinely differs. */
  function isRealFailover(requested: string, actual: string): boolean {
    if (requested === actual) return false;
    const stripDateSuffix = (id: string) => id.replace(/-\d{6,8}$/, "");
    return stripDateSuffix(requested) !== stripDateSuffix(actual);
  }

  /** Parse a `generationIds`/`generationMetadata` key into its role and
   *  requested model id. Keys are `reviewer:<model>` / `aggregator:<model>`,
   *  optionally suffixed with `#<n>` when a model was called more than once
   *  (e.g. manually reconciled retries) — legacy runs may have bare model
   *  ids with no prefix at all. */
  function parseGenerationKey(key: string, aggregatorModel?: string): { role: "reviewer" | "aggregator"; requestedModel: string } {
    const noAttempt = key.replace(/#\d+$/, "");
    if (noAttempt.startsWith("reviewer:")) return { role: "reviewer", requestedModel: noAttempt.slice("reviewer:".length) };
    if (noAttempt.startsWith("aggregator:")) return { role: "aggregator", requestedModel: noAttempt.slice("aggregator:".length) };
    return { role: noAttempt === aggregatorModel ? "aggregator" : "reviewer", requestedModel: noAttempt };
  }

  /** Format an ISO timestamp as a compact time (HH:MM:SS) for the audit table. */
  function fmtTime(s?: string): string {
    if (!s) return "—";
    try {
      return new Date(s).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    } catch { return s; }
  }

  /** Sort the Generation Audit entries by the active sort key/direction. */
  function sortGenEntries(
    entries: [string, GenerationMetadata][],
    key: typeof genSortKey,
    dir: "asc" | "desc",
  ): [string, GenerationMetadata][] {
    const mul = dir === "asc" ? 1 : -1;
    const cmp = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);
    return [...entries].sort(([_ka, ma], [_kb, mb]) => {
      switch (key) {
        case "time": return mul * cmp(ma.createdAt ?? "", mb.createdAt ?? "");
        case "role": return mul * cmp(_ka, _kb);
        case "requested": return mul * cmp(_ka, _kb);
        case "actual": return mul * cmp(ma.model, mb.model);
        case "provider": return mul * cmp(ma.providerName ?? "", mb.providerName ?? "");
        case "inTok": return mul * cmp(ma.tokensPrompt, mb.tokensPrompt);
        case "outTok": return mul * cmp(ma.tokensCompletion, mb.tokensCompletion);
        case "cost": return mul * cmp(ma.totalCost, mb.totalCost);
        case "finish": return mul * cmp(ma.finishReason ?? "", mb.finishReason ?? "");
        default: return 0;
      }
    });
  }

  /** Cycle sort direction (or set a new key → default asc). Clicking the
   *  active column toggles asc/desc; clicking a new column starts asc. */
  function setGenSort(key: typeof genSortKey) {
    if (genSortKey === key) genSortDir = genSortDir === "asc" ? "desc" : "asc";
    else { genSortKey = key; genSortDir = "asc"; }
  }

  /** Build the list of selectable raw outputs for the picker: reviewer
   *  outputs, judge reasoning, and judge JSON — each with a stable key,
   *  a label, and the text. */
  function buildRawOutputs(r: ReviewResult): { key: string; label: string; text: string }[] {
    const out: { key: string; label: string; text: string }[] = [];
    for (const [model, text] of Object.entries(r.rawOutputs ?? {})) {
      const attempt = model.match(/#(\d+)$/)?.[1];
      const base = model.replace(/#\d+$/, "");
      const label = `${r.source === "upload" ? "Pasted" : "Reviewer"} · ${modelLabel(base)}${attempt ? ` (attempt ${attempt})` : ""}`;
      out.push({ key: `raw:${model}`, label, text });
    }
    if (r.aggregatorReasoning) {
      out.push({ key: "judge:reasoning", label: `Judge reasoning · ${modelLabel(r.aggregatorModel)}`, text: r.aggregatorReasoning });
    }
    if (r.aggregatorOutput) {
      out.push({ key: "judge:json", label: `Judge JSON · ${modelLabel(r.aggregatorModel)}`, text: r.aggregatorOutput });
    }
    return out;
  }

  /** Build a model id → display name map from the loaded model lists. */
  const modelNameMap = $derived.by(() => {
    const map = new Map<string, string>();
    for (const m of freeModels) map.set(m.id, m.name || m.id);
    for (const m of paidModels) map.set(m.id, m.name || m.id);
    for (const m of localModels) map.set(m.id, m.name || m.id);
    return map;
  });

  /** Resolve a model id to a friendly display name.
   *  e.g. "openai/gpt-4o" → "GPT-4o", "google/gemini-flash-1.5" → "Gemini Flash 1.5".
   *  Falls back to prettifying the id, then to the raw id. */
  function modelLabel(id: string): string {
    // Check the catalog first.
    const catalogName = modelNameMap.get(id);
    if (catalogName) return catalogName;

    // Strip vendor prefix (e.g. "openai/" → "").
    const base = id.includes("/") ? id.split("/").pop()! : id;
    // Strip ":free" suffix.
    const clean = base.replace(/:free$/i, "");

    // Prettify: replace separators, capitalize words.
    const pretty = clean
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      // Common model name fixes
      .replace(/\bGpt\b/g, "GPT")
      .replace(/\bAi\b/g, "AI")
      .replace(/\bMlx\b/g, "MLX")
      .replace(/\bLlama\b/g, "Llama")
      .replace(/\bMistral\b/g, "Mistral")
      .replace(/\bGemma\b/g, "Gemma")
      .replace(/\bClaude\b/g, "Claude")
      .replace(/\bGemini\b/g, "Gemini")
      .replace(/\bDeepseek\b/g, "DeepSeek")
      .replace(/\bQwen\b/g, "Qwen")
      .replace(/\bPhi\b/g, "Phi")
      .replace(/\bSonnet\b/g, "Sonnet")
      .replace(/\bOpus\b/g, "Opus")
      .replace(/\bHaiku\b/g, "Haiku")
      .replace(/\bFlash\b/g, "Flash")
      .replace(/\bPro\b/g, "Pro")
      .replace(/\bMini\b/g, "Mini")
      .replace(/\bNano\b/g, "Nano");

    return pretty || id;
  }

  /** Friendly vendor name for a reviewer: "gpt-5.6-sol" → "ChatGPT",
   *  "claude-sonnet-5" → "Claude". Already-friendly names pass through. */
  function friendlyReviewer(id: string): string {
    const base = id.includes("/") ? id.split("/").pop()! : id;
    const clean = base.replace(/:free$/i, "");
    if (/gpt|openai/i.test(clean)) return "ChatGPT";
    if (/claude|anthropic/i.test(clean)) return "Claude";
    if (/gemini|google/i.test(clean)) return "Gemini";
    if (/llama|meta/i.test(clean)) return "Llama";
    if (/deepseek/i.test(clean)) return "DeepSeek";
    if (/qwen/i.test(clean)) return "Qwen";
    if (/mistral/i.test(clean)) return "Mistral";
    if (/gemma/i.test(clean)) return "Gemma";
    if (/glm/i.test(clean)) return "GLM";
    if (/grok/i.test(clean)) return "Grok";
    if (/auto/i.test(clean)) return "Auto";
    return clean.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) || id;
  }

  /** Full model name for a reviewer popover: resolves a friendly name back to
   *  the run's raw model id ("ChatGPT" → "GPT 5.6 Sol") and prettifies it. */
  function reviewerPopover(value: string, rawModels: string[] | undefined): string {
    const raw = (rawModels ?? []).find(
      (m) => friendlyReviewer(m).toLowerCase() === value.toLowerCase() || m.toLowerCase() === value.toLowerCase(),
    );
    return modelLabel(raw ?? value);
  }
  function nextRunLabel(c: ReviewConfig): string | null {
    if (!c.enabled || c.intervalValue <= 0 || !schedulerEnabled) return null;
    const unitMs = c.intervalUnit === "hours" ? 3_600_000 : c.intervalUnit === "days" ? 86_400_000 : 604_800_000;
    const next = (c.lastRunAt ? Date.parse(c.lastRunAt) : 0) + c.intervalValue * unitMs;
    const mins = Math.round((next - Date.now()) / 60_000);
    if (mins <= 0) return "due now";
    if (mins < 60) return `next in ${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `next in ${hours}h`;
    return `next in ${Math.round(hours / 24)}d`;
  }

  const TIER_OPTIONS: { id: ReviewTier; icon: typeof IconBolt; label: string; desc: string }[] = [
    { id: "free", icon: IconBolt, label: "Free", desc: "OpenRouter free" },
    { id: "paid", icon: IconCoin, label: "Paid", desc: "Frontier models" },
    { id: "all", icon: IconStack, label: "All", desc: "Free + paid" },
  ];

  let availableModels = $derived.by(() => {
    const base = editing?.modelTier === "paid" ? paidModels
      : editing?.modelTier === "free" ? freeModels
      : [...freeModels, ...paidModels];
    // Sort by popularity when "popular" is selected (default for paid).
    // Models with no popularity data sort last but keep their relative order.
    if (modelSort === "popular" && popularity.size > 0) {
      return [...base].sort((a, b) => {
        const pa = modelPopularity(a.id) ?? 0;
        const pb = modelPopularity(b.id) ?? 0;
        // Popular first; ties keep catalog order (stable sort).
        if (pb !== pa) return pb - pa;
        return base.indexOf(a) - base.indexOf(b);
      });
    }
    return base;
  });

  /** Look up the popularity (7-day total tokens) for a model id. The
   *  rankings-daily dataset uses canonical permaslugs, so we try exact match
   *  first, then prefix match (catalog ids often have date suffixes). */
  function modelPopularity(id: string): number | undefined {
    if (popularity.size === 0) return undefined;
    if (popularity.has(id)) return popularity.get(id);
    // Try prefix match — e.g. "openai/gpt-4o" matches "openai/gpt-4o-2024-05-13".
    for (const [slug, tokens] of popularity) {
      if (slug.startsWith(id + "-") || id.startsWith(slug + "-")) return tokens;
    }
    return undefined;
  }

  /** Format a token count as a compact popularity label (e.g. "12.3M", "450k"). */
  function fmtPopularity(tokens: number | undefined): string {
    if (tokens == null) return "";
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
    return `${tokens}`;
  }

  let modelSearch = $state("");

  // Reset the search whenever the model tier changes (different model set).
  let filteredModels = $derived.by(() => {
    const q = modelSearch.trim().toLowerCase();
    if (!q) return availableModels;
    return availableModels.filter((m) =>
      m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q),
    );
  });

  function toggleReviewerModel(id: string) {
    if (!editing) return;
    if (editing.reviewerModels.includes(id)) {
      editing.reviewerModels = editing.reviewerModels.filter((m) => m !== id);
    } else {
      editing.reviewerModels = [...editing.reviewerModels, id];
    }
  }

  function rerunJudgeForRawResult() {
    if (!rawResult) return;
    const r = rawResult;
    // Map non-error reviewer outputs to uploadReviewers
    const entries = Object.entries(r.rawOutputs ?? {}).filter(([, text]) => text && !text.startsWith("[REVIEWER ERROR:"));
    if (entries.length === 0) return;
    uploadReviewers = entries.map(([name, text]) => ({ name, text }));
    uploadConfigId = r.configId;
    uploadMode = true;
    rawResult = null;
  }

  // --- Upload analysis mode --------------------------------------------------
  function addUploadReviewer() {
    uploadReviewers = [...uploadReviewers, { name: `reviewer-${uploadReviewers.length + 1}`, text: "" }];
  }
  function removeUploadReviewer(idx: number) {
    uploadReviewers = uploadReviewers.filter((_, i) => i !== idx);
  }
  function updateUploadReviewer(idx: number, field: "name" | "text", value: string) {
    uploadReviewers = uploadReviewers.map((r, i) => i === idx ? { ...r, [field]: value } : r);
  }

  /** Known model families — a bare line only counts as a model separator when
   *  it mentions one (or uses vendor/model form). Keeps junk lines like
   *  "dirty-bot-natured" or "stdout.log" from becoming fake reviewers. */
  const MODEL_FAMILY_RE = /(gpt|openai|claude|anthropic|gemini|llama|deepseek|qwen|mistral|gemma|glm|grok|kimi|olmo|hunyuan|phi[-._]|command[-_]?r|ministral)/i;

  /** Detect a line that names a model and therefore separates pasted analyses:
   *  "Reviewer: X", "Model: X", or a bare model id line ("claude-sonnet-5",
   *  "deepseek/deepseek-v3.2:free", "gpt-5.2"). Returns the name or null. */
  function detectModelLine(line: string): string | null {
    const t = line.trim();
    if (!t || t.length > 80) return null;
    let m = t.match(/^={0,3}\s*reviewer\s*[:：]\s*(.+?)\s*={0,3}$/i);
    if (m) return m[1].trim();
    m = t.match(/^\*{0,2}model\*{0,2}\s*[:：]\s*(.+)$/i);
    if (m) return m[1].trim().replace(/\*+/g, "");
    m = t.match(/^([a-z0-9]+(?:[\/._-][a-z0-9._-]+)+(?::free)?)$/i);
    if (
      m && m[1].length >= 6 && /[a-z]/i.test(m[1]) && !/^v?\d/.test(m[1])
      && (m[1].includes("/") || MODEL_FAMILY_RE.test(m[1]))
    ) return m[1];
    return null;
  }

  /** Parse pasted text into individual reviewer outputs. Supports explicit
   *  "=== Reviewer: model-id ===" separators and model-name lines separating
   *  each pasted analysis (so reviewers get real names like claude-sonnet-5
   *  instead of "reviewer-1"). */
  function parseBulkPaste(text: string) {
    const sections = text.split(/\n=== Reviewer:\s*(.+?)\s*===\n/);
    if (sections.length > 2) {
      // Has separator format: ["before", "model-1", "output-1", "model-2", "output-2", ...]
      const reviewers: { name: string; text: string }[] = [];
      for (let i = 1; i < sections.length; i += 2) {
        reviewers.push({ name: sections[i].trim(), text: sections[i + 1]?.trim() ?? "" });
      }
      if (reviewers.length > 0) {
        uploadReviewers = reviewers;
        return;
      }
    }

    // Split on model-name lines. Content before the first model line is
    // treated as preamble and dropped (usually UI chrome from a screen copy).
    const reviewers: { name: string; text: string }[] = [];
    let current: { name: string; text: string } | null = null;
    for (const line of text.split("\n")) {
      const name = detectModelLine(line);
      if (name) {
        if (current && current.text.trim().length >= 100) reviewers.push(current);
        current = { name, text: "" };
        continue;
      }
      if (current) current.text += line + "\n";
    }
    if (current && current.text.trim().length >= 100) reviewers.push(current);
    if (reviewers.length > 0) {
      // Dedupe repeated model names (e.g. two sections from the same model).
      const seen = new Map<string, number>();
      uploadReviewers = reviewers.map((r) => {
        const n = (seen.get(r.name) ?? 0) + 1;
        seen.set(r.name, n);
        return n > 1 ? { ...r, name: `${r.name} (${n})` } : r;
      });
      return;
    }

    // No separators — put everything in a single reviewer.
    uploadReviewers = [{ name: "pasted-analysis", text }];
  }

  async function runAggregateOnly() {
    function collectOutputs(): Record<string, string> {
      const outputs: Record<string, string> = {};
      for (const r of uploadReviewers) {
        if (r.text.trim()) outputs[r.name || `reviewer-${Object.keys(outputs).length + 1}`] = r.text;
      }
      return outputs;
    }

    if (!workspaceRoot) {
      error = "No workspace open.";
      return;
    }

    // Build the request body — either use a saved config or a preset.
    let reqBody: Record<string, unknown>;

    if (uploadConfigId) {
      const config = configs.find((c) => c.id === uploadConfigId);
      if (!config) {
        error = "Selected config not found.";
        return;
      }
      reqBody = {
        configId: config.id,
        workspaceRoot,
        reviewerOutputs: collectOutputs(),
        aggregatorModel: config.aggregatorModel,
      };
    } else if (uploadPresetId) {
      const preset = presets.find((p) => p.id === uploadPresetId);
      if (!preset) {
        error = "Selected preset not found.";
        return;
      }
      // Build an inline config from the preset — the endpoint will auto-save it.
      reqBody = {
        config: {
          id: "",
          name: `${preset.name} (uploaded)`,
          lenses: preset.lenses.map((l) => ({ ...l })),
          expertise: "top-1%",
          modelTier: "all",
          reviewerModels: [],
          aggregatorModel: "openrouter/auto",
          intervalValue: 0,
          intervalUnit: "hours",
          workspaceRoot: workspaceRoot ?? undefined,
          createGitHubIssues: false,
          writeTasksFile: false,
          enabled: false,
        },
        workspaceRoot,
        reviewerOutputs: collectOutputs(),
      };
    } else {
      error = "Select a config or preset.";
      return;
    }

    if (Object.keys(reqBody.reviewerOutputs as Record<string, string>).length === 0) {
      error = "No reviewer outputs provided.";
      return;
    }

    running = true;
    cancelling = false;
    error = null;
    runLog = "Starting aggregation…";
    reviewerCards = [];
    reviewerTexts = {};
    aggregatorReasoning = "";
    aggregatorStarted = false;
    uploadMode = false;

    try {
      const res = await fetch("/api/review/aggregate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      const finalResultId = await consumeRunStream(res);
      if (!res.ok || !res.body) { running = false; return; }
      await settleAfterRun(finalResultId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      running = false;
      cancelling = false;
    }
  }

  let openTasks = $derived(selectedResult ? selectedResult.tasks.filter((t) => !t.resolved) : []);
  let resolvedTasks = $derived(selectedResult ? selectedResult.tasks.filter((t) => t.resolved) : []);
  let taskStats = $derived({
    p0: openTasks.filter((t) => t.priority === "P0").length,
    p1: openTasks.filter((t) => t.priority === "P1").length,
    p2: openTasks.filter((t) => t.priority === "P2").length,
    p3: openTasks.filter((t) => t.priority === "P3").length,
    open: openTasks.length,
    resolved: resolvedTasks.length,
  });

  // --- Task table: filter + sort state ---------------------------------------
  type SortKey = "priority" | "issue" | "lenses" | "reviewers" | "impact" | "firstSeen" | "status";
  let sortKey = $state<SortKey>("priority");
  let sortDir = $state<"asc" | "desc">("asc");
  let filterPriority = $state<string>("all"); // all | P0 | P1 | P2 | P3
  let filterLens = $state<string>("all"); // all | <lens-id>
  let filterStatus = $state<string>("open"); // all | open | resolved
  let taskSearch = $state<string>("");

  /** All lenses present in the current result (for the filter dropdown). */
  let availableLenses = $derived(
    selectedResult
      ? [...new Set(selectedResult.tasks.flatMap((t) => t.lenses))].sort()
      : [],
  );

  const PRIO_WEIGHT: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

  /** Filtered + sorted task list for the table. */
  let displayTasks = $derived.by(() => {
    if (!selectedResult) return [];
    let tasks = selectedResult.tasks;

    // Filter by status
    if (filterStatus === "open") tasks = tasks.filter((t) => !t.resolved);
    else if (filterStatus === "resolved") tasks = tasks.filter((t) => t.resolved);

    // Filter by priority
    if (filterPriority !== "all") tasks = tasks.filter((t) => t.priority === filterPriority);

    // Filter by lens
    if (filterLens !== "all") tasks = tasks.filter((t) => t.lenses.includes(filterLens));

    // Filter by search text
    if (taskSearch.trim()) {
      const q = taskSearch.toLowerCase();
      tasks = tasks.filter((t) =>
        t.issue.toLowerCase().includes(q) ||
        t.mainFinding.toLowerCase().includes(q) ||
        t.fix.toLowerCase().includes(q) ||
        t.impact.toLowerCase().includes(q),
      );
    }

    // Sort
    const sorted = [...tasks];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "priority": cmp = PRIO_WEIGHT[a.priority] - PRIO_WEIGHT[b.priority]; break;
        case "issue": cmp = a.issue.localeCompare(b.issue); break;
        case "lenses": cmp = a.lenses.length - b.lenses.length; break;
        case "reviewers": cmp = a.reviewers.length - b.reviewers.length; break;
        case "impact": cmp = a.impact.localeCompare(b.impact); break;
        case "firstSeen": cmp = (a.firstSeenAt ?? "").localeCompare(b.firstSeenAt ?? ""); break;
        case "status": cmp = Number(a.resolved ?? false) - Number(b.resolved ?? false); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  });

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = "asc";
    }
  }

  /** Interactive lens legends (emoji + code + count) for each task view. */
  let reviewLensLegend = $derived(selectedResult ? buildLensLegend(selectedResult.tasks) : []);
  let workLensLegend = $derived(buildLensLegend(allTasks));

  // --- Work tab: filter + sort state -----------------------------------------
  type WorkSortKey = "priority" | "issue" | "mainFinding" | "fix" | "impact" | "lenses" | "reviewers" | "config" | "date" | "status";
  let workSortKey = $state<WorkSortKey>("priority");
  let workSortDir = $state<"asc" | "desc">("asc");
  let workFilterPriority = $state<string>("all");
  let workFilterLens = $state<string>("all");
  let workFilterReviewer = $state<string>("all");
  let workFilterStatus = $state<string>("open");
  let workSearch = $state<string>("");

  function toggleWorkSort(key: WorkSortKey) {
    if (workSortKey === key) {
      workSortDir = workSortDir === "asc" ? "desc" : "asc";
    } else {
      workSortKey = key;
      workSortDir = "asc";
    }
  }

  let workDisplayTasks = $derived.by(() => {
    let tasks = allTasks;
    if (workFilterStatus === "open") tasks = tasks.filter((t) => !t.resolved);
    else if (workFilterStatus === "resolved") tasks = tasks.filter((t) => t.resolved);
    if (workFilterPriority !== "all") tasks = tasks.filter((t) => t.priority === workFilterPriority);
    if (workFilterLens !== "all") tasks = tasks.filter((t) => t.lenses.includes(workFilterLens));
    if (workFilterReviewer !== "all") tasks = tasks.filter((t) => t.reviewers.includes(workFilterReviewer));
    if (workSearch.trim()) {
      const q = workSearch.toLowerCase();
      tasks = tasks.filter((t) =>
        t.issue.toLowerCase().includes(q) ||
        (t.mainFinding || "").toLowerCase().includes(q) ||
        (t.fix || "").toLowerCase().includes(q) ||
        (t.impact || "").toLowerCase().includes(q),
      );
    }
    const sorted = [...tasks];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (workSortKey) {
        case "priority": cmp = PRIO_WEIGHT[a.priority] - PRIO_WEIGHT[b.priority]; break;
        case "issue": cmp = a.issue.localeCompare(b.issue); break;
        case "mainFinding": cmp = (a.mainFinding || "").localeCompare(b.mainFinding || ""); break;
        case "fix": cmp = (a.fix || "").localeCompare(b.fix || ""); break;
        case "impact": cmp = (a.impact || "").localeCompare(b.impact || ""); break;
        case "lenses": cmp = a.lenses.length - b.lenses.length; break;
        case "reviewers": cmp = a.reviewers.length - b.reviewers.length; break;
        case "config": cmp = (a.configName || "").localeCompare(b.configName || ""); break;
        case "date": cmp = (a.reviewDate || a.lastSeenAt || "").localeCompare(b.reviewDate || b.lastSeenAt || ""); break;
        case "status": cmp = Number(a.resolved ?? false) - Number(b.resolved ?? false); break;
      }
      return workSortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  });

  /** Minimal markdown → HTML for issue bodies (headings, bold, lists,
   *  checkboxes, code blocks, inline code). Good enough for GitHub issue
   *  bodies — not a full markdown parser. */
  function renderMarkdown(md: string): string {
    // Extract code blocks first so their content isn't mangled by inline rules.
    const codeBlocks: string[] = [];
    let working = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
      return `\x00CODEBLOCK${idx}\x00`;
    });

    // Escape HTML in the remaining text.
    working = working
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Headings
    working = working.replace(/^## (.+)$/gm, '<h4 class="md-h">$1</h4>');
    working = working.replace(/^### (.+)$/gm, '<h5 class="md-h">$1</h5>');

    // Inline code (after HTML escape so backticks are still intact)
    working = working.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    working = working.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Checkboxes
    working = working.replace(/^- \[ \] (.+)$/gm, '<div class="md-check"><input type="checkbox" disabled /> $1</div>');
    working = working.replace(/^- \[x\] (.+)$/gim, '<div class="md-check"><input type="checkbox" checked disabled /> $1</div>');

    // Bullet lists
    working = working.replace(/^- (.+)$/gm, '<div class="md-li">• $1</div>');

    // Paragraphs (lines not already wrapped)
    working = working.split("\n").map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (/^<(h4|h5|div|strong|code|pre)/.test(trimmed)) return trimmed;
      if (/^\x00CODEBLOCK/.test(trimmed)) return trimmed;
      return `<p class="md-p">${trimmed}</p>`;
    }).join("\n");

    // Restore code blocks
    working = working.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, idx) =>
      `<pre><code>${codeBlocks[+idx]}</code></pre>`);

    return working;
  }
</script>

<div class="monitor-view">
  <!-- Left rail: configs + presets -->
  <aside class="panel-enter pane pane-bracketed monitor-rail rounded-lg">
    <div class="pane-header">
      <div class="pane-title"><span class="pane-title-bar"></span>Reviews</div>
      <button class="icon-btn" onclick={newConfig} title="New review config" aria-label="New review config">
        <IconPlus size={15} />
      </button>
    </div>
    <div class="rail-body">
      <div class="rail-label">Configs</div>
      {#if configs.length === 0}
        <div class="rail-empty">No configs yet — clone a preset below.</div>
      {/if}
      {#each configs as c (c.id)}
        <div
          class="cfg-card"
          class:selected={c.id === selectedConfigId}
          role="button"
          tabindex="0"
          onclick={() => selectConfig(c.id)}
          onkeydown={(e) => { if (e.key === "Enter") selectConfig(c.id); }}
          transition:fly={{ y: 16, duration: 300, easing: cubicInOut }}
        >
          <div class="cfg-top">
            <span class="cfg-name">{c.name}</span>
            {#if c.enabled && c.intervalValue > 0}
              <span class="cfg-interval">{intervalLabel(c)}</span>
            {/if}
          </div>
          <div class="cfg-meta">
            <span class="tier-pill tier-{c.modelTier}">{tierLabel(c.modelTier)}</span>
            <span>{c.lenses.length} lenses</span>
            <span>{c.expertise}</span>
          </div>
          <div class="cfg-meta cfg-schedule">
            {#if c.lastRunAt}<span>ran {fmtDate(c.lastRunAt)}</span>{/if}
            {#if nextRunLabel(c)}<span class="cfg-next">{nextRunLabel(c)}</span>{/if}
          </div>
          <div class="cfg-actions">
            <button class="btn btn-xs" onclick={(e) => { e.stopPropagation(); runReviewNow(c); }} disabled={running}>
              <IconPlayerPlay size={11} /> Run
            </button>
            <button class="btn btn-xs btn-ghost" onclick={(e) => { e.stopPropagation(); editConfig(c); }}>Edit</button>
            <button class="btn btn-xs btn-ghost cfg-delete" onclick={(e) => { e.stopPropagation(); deletingId = c.id; }} aria-label="Delete config">
              <IconTrash size={11} />
            </button>
          </div>
        </div>
      {/each}

      <div class="rail-label">Presets</div>
      {#each presets as p (p.id)}
        <div class="preset-card" transition:fly={{ y: 16, duration: 300, delay: 30, easing: cubicInOut }}>
          <div class="preset-head" role="button" tabindex="0" onclick={() => clonePreset(p)} onkeydown={(e) => { if (e.key === "Enter") clonePreset(p); }}>
            <span class="preset-name">
              {#if p.smokeTest}<IconBolt size={12} class="smoke-icon" />{/if}
              {p.name}
            </span>
            <span class="preset-lens-count">{p.lenses.length}</span>
          </div>
          <div class="preset-desc">{p.description}</div>
          <details class="preset-details">
            <summary><IconChevronRight size={11} /> Lenses</summary>
            <div class="preset-lenses">
              {#each p.lenses as lens (lens.id)}
                <span class="lens-chip">{lens.emoji} {lens.label}</span>
              {/each}
            </div>
            <button class="btn btn-xs" onclick={() => clonePreset(p)}>
              <IconPlus size={11} /> Clone
            </button>
          </details>
        </div>
      {/each}
    </div>
  </aside>

  <!-- Main pane: the living task list -->
  <main class="panel-enter pane pane-bracketed monitor-main rounded-lg">
    <div class="pane-header">
      <div class="pane-title">
        <span class="pane-title-bar"></span>Task List
        <span class="kicker-tag">// {taskStats.open} open{#if taskStats.resolved > 0} · {taskStats.resolved} resolved{/if}</span>
      </div>
      <div class="header-actions">
        <button
          class="icon-btn {schedulerEnabled ? "active" : ""}"
          onclick={toggleScheduler}
          title="Background scheduler {schedulerEnabled ? "on — reviews run on their configs' intervals" : "off"}"
          aria-label="Toggle background scheduler"
          aria-pressed={schedulerEnabled}
        >
          <IconClock size={15} />
        </button>
        <button class="icon-btn" onclick={loadAll} disabled={running} title="Refresh" aria-label="Refresh">
          <IconRefresh size={15} class={running || backgroundRunning ? "spin" : ""} />
        </button>
        <button
          class="icon-btn"
          onclick={() => (showStartFresh = true)}
          disabled={running || (configs.length === 0 && results.length === 0)}
          title="Start fresh — erase monitoring data"
          aria-label="Start fresh"
        >
          <IconTrash size={15} />
        </button>
        {#if selectedConfig}
          {#if running}
            <button class="btn btn-sm btn-danger" onclick={cancelRun} disabled={cancelling}>
              {#if cancelling}Cancelling…{:else}<IconSquare size={13} /> Cancel{/if}
            </button>
          {:else}
            <button class="btn btn-sm btn-primary" onclick={() => runReviewNow(selectedConfig!)} disabled={!workspaceRoot}>
              <IconPlayerPlay size={13} /> Run now
            </button>
          {/if}
        {/if}
      </div>
    </div>

    <div class="main-body">
      <!-- View tabs -->
      <div class="monitor-tabs">
        <button class="monitor-tab" class:active={monitorView === "reviews"} onclick={() => { monitorView = "reviews"; }}>
          <IconHistory size={14} /> Reviews
        </button>
        <button class="monitor-tab" class:active={monitorView === "work"} onclick={() => { monitorView = "work"; void loadAllTasks(); }}>
          <IconListCheck size={14} /> Work to Do
        </button>
      </div>

      <!-- View-mode switcher (only in Reviews tab) -->
      {#if monitorView === "reviews"}
        <div class="view-mode-bar">
          {#each VIEW_MODES as vm (vm.id)}
            <button
              class="view-mode-btn"
              class:active={reviewViewMode === vm.id}
              onclick={() => { reviewViewMode = vm.id; }}
              title="{vm.label} view"
              aria-pressed={reviewViewMode === vm.id}
            >
              <vm.icon size={13} />
              <span>{vm.label}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if error}
        <div class="monitor-error" transition:fade>
          <IconAlertTriangle size={13} /> {error}
          <button class="icon-btn error-close" onclick={() => (error = null)} aria-label="Dismiss"><IconX size={12} /></button>
        </div>
      {/if}

      {#if monitorView === "work"}
        <!-- Work to Do: consolidated cross-config task list with filters -->
        {#if allTasks.length === 0}
          <div class="main-empty" transition:fade>
            <IconListCheck size={32} />
            <div>No tasks across any config.</div>
            <div class="empty-hint">Run a review or upload analysis to generate tasks.</div>
          </div>
        {:else}
          {@const openAll = allTasks.filter((t) => !t.resolved)}
          {@const resolvedAll = allTasks.filter((t) => t.resolved)}
          {@const workStats = { p0: openAll.filter((t) => t.priority === "P0").length, p1: openAll.filter((t) => t.priority === "P1").length, p2: openAll.filter((t) => t.priority === "P2").length, p3: openAll.filter((t) => t.priority === "P3").length, open: openAll.length, resolved: resolvedAll.length }}
          {@const openWithoutIssue = openAll.filter((t) => !t.githubUrl)}
          <div class="result-header" transition:fade>
            <div class="result-header-left">
              <div class="result-title">Work to Do</div>
              <div class="result-meta">{openAll.length} open · {resolvedAll.length} resolved · across {new Set(allTasks.map((t) => t.configId)).size} config{new Set(allTasks.map((t) => t.configId)).size != 1 ? "s" : ""}</div>
            </div>
            <div class="result-header-right">
              {#if openWithoutIssue.length > 0}
                <button class="btn btn-sm btn-primary" onclick={bulkCreateIssues} disabled={bulkCreating}>
                  {#if bulkCreating}<IconRefresh size={13} class="spin" /> Creating… ({bulkCreatedCount}/{openWithoutIssue.length}){:else}<IconBrandGithub size={13} /> Create GitHub issues ({openWithoutIssue.length}){/if}
                </button>
              {/if}
            </div>
          </div>
          {#if workStats.open > 0}
            <div class="priority-bar" transition:fade>
              {#each ["P0", "P1", "P2", "P3"] as p (p)}
                {@const count = (workStats as any)[p.toLowerCase()]}
                {#if count > 0}
                  <div class="priority-seg {p.toLowerCase()}" style="flex: {count}">
                    <span class="seg-label">{p}</span>
                    <span class="seg-count">{count}</span>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}

          <!-- Lens legend — click a lens to filter by it -->
          {#if workLensLegend.length > 0}
            <div class="lens-legend" transition:fade>
              {#each workLensLegend as l (l.key)}
                <button
                  class="lens-legend-item {workFilterLens === l.key ? "active" : ""}"
                  onclick={() => { workFilterLens = workFilterLens === l.key ? "all" : l.key; }}
                  title="{l.label} — {l.count} open task{l.count === 1 ? "" : "s"}"
                  aria-pressed={workFilterLens === l.key}
                >
                  <span class="lens-legend-emoji">{l.emoji}</span>
                  {l.key}
                  {#if l.count > 0}<span class="lens-legend-count">{l.count}</span>{/if}
                </button>
              {/each}
            </div>
          {/if}

          <!-- Filter bar -->
          <div class="task-toolbar" transition:fade>
            <div class="task-filter-group">
              <select class="task-filter-select" bind:value={workFilterPriority} aria-label="Filter by priority">
                <option value="all">All priorities</option>
                <option value="P0">P0</option>
                <option value="P1">P1</option>
                <option value="P2">P2</option>
                <option value="P3">P3</option>
              </select>
                <select class="task-filter-select" bind:value={workFilterLens} aria-label="Filter by lens">
                  <option value="all">All lenses</option>
                  {#each [...new Set(allTasks.flatMap((t) => t.lenses))].sort() as lens (lens)}
                    <option value={lens}>{lensShortLabel(lens)}</option>
                  {/each}
                </select>
              <select class="task-filter-select" bind:value={workFilterReviewer} aria-label="Filter by reviewer">
                <option value="all">All reviewers</option>
                {#each [...new Set(allTasks.flatMap((t) => t.reviewers))].sort() as rev (rev)}
                  <option value={rev}>{modelLabel(rev)}</option>
                {/each}
              </select>
              <select class="task-filter-select" bind:value={workFilterStatus} aria-label="Filter by status">
                <option value="open">Open</option>
                <option value="resolved">Resolved</option>
                <option value="all">All</option>
              </select>
            </div>
            <div class="task-search-group">
              <IconSearch size={13} class="search-icon" />
              <input class="task-search-input" type="text" placeholder="Search tasks…" bind:value={workSearch} />
            </div>
            <span class="task-count-badge">{workDisplayTasks.length} / {allTasks.length}</span>
          </div>

          <div class="task-table-wrap work-table-wrap" transition:fade>
            <table class="task-table work-table">
              <thead>
                <tr>
                  <th class="col-prio" onclick={() => toggleWorkSort("priority")} role="button" tabindex="0">
                    Priority
                    {#if workSortKey === "priority"}<IconArrowsSort size={11} class="sort-icon {workSortDir}" />{/if}
                  </th>
                  <th class="col-issue" onclick={() => toggleWorkSort("issue")} role="button" tabindex="0">
                    Issue
                    {#if workSortKey === "issue"}<IconArrowsSort size={11} class="sort-icon {workSortDir}" />{/if}
                  </th>
                  <th class="col-finding" onclick={() => toggleWorkSort("mainFinding")} role="button" tabindex="0">
                    Main finding
                    {#if workSortKey === "mainFinding"}<IconArrowsSort size={11} class="sort-icon {workSortDir}" />{/if}
                  </th>
                  <th class="col-fix" onclick={() => toggleWorkSort("fix")} role="button" tabindex="0">
                    Fix
                    {#if workSortKey === "fix"}<IconArrowsSort size={11} class="sort-icon {workSortDir}" />{/if}
                  </th>
                  <th class="col-impact" onclick={() => toggleWorkSort("impact")} role="button" tabindex="0">
                    Impact
                    {#if workSortKey === "impact"}<IconArrowsSort size={11} class="sort-icon {workSortDir}" />{/if}
                  </th>
                  <th class="col-lenses" onclick={() => toggleWorkSort("lenses")} role="button" tabindex="0">
                    Lenses
                    {#if workSortKey === "lenses"}<IconArrowsSort size={11} class="sort-icon {workSortDir}" />{/if}
                  </th>
                  <th class="col-reviewers" onclick={() => toggleWorkSort("reviewers")} role="button" tabindex="0">
                    Reviewers
                    {#if workSortKey === "reviewers"}<IconArrowsSort size={11} class="sort-icon {workSortDir}" />{/if}
                  </th>
                  <th class="col-gh">GitHub</th>
                </tr>
              </thead>
              <tbody>
                {#each workDisplayTasks as task, i (task.fingerprint ?? i)}
                  {@const PI = priorityIcon(task.priority)}
                  <tr
                    class="task-row {task.priority.toLowerCase()} {task.resolved ? "resolved" : ""}"
                    role="button"
                    tabindex="0"
                    onclick={() => openTaskDetail(task)}
                    onkeydown={(e) => { if (e.key === "Enter") openTaskDetail(task); }}
                  >
                    <td class="col-prio">
                      <span class="task-prio {task.priority.toLowerCase()}">
                        <PI size={12} />
                        {task.priority}
                      </span>
                    </td>
                    <td class="col-issue"><span class="task-issue-text">{task.issue}</span></td>
                    <td class="col-finding"><span class="task-full-cell">{task.mainFinding || "—"}</span></td>
                    <td class="col-fix"><span class="task-full-cell">{task.fix || "—"}</span></td>
                    <td class="col-impact"><span class="task-full-cell">{task.impact || "—"}</span></td>
                    <td class="col-lenses">
                      <div class="task-tags-cell">
                        {#each task.lenses as lens (lens)}
                          <span class="task-lens-tag" title={lensLabel(lens, task.configId)}>{lensEmoji(lens)} {lens}</span>
                        {/each}
                      </div>
                    </td>
                    <td class="col-reviewers">
                      <div class="rev-chips" title={task.reviewers.map((r: string) => reviewerPopover(r, task.reviewerModels)).join(", ")}>
                        {#each task.reviewers as r (r)}
                          <span class="rev-chip">
                            <i class="rev-dot" style="background: {reviewerDot(friendlyReviewer(r))}"></i>
                            {friendlyReviewer(r)}
                          </span>
                        {:else}
                          <span class="gh-none">—</span>
                        {/each}
                      </div>
                    </td>
                    <td class="col-gh" onclick={(e) => e.stopPropagation()}>
                      {#if task.githubUrl}
                        <a href={task.githubUrl} target="_blank" rel="noopener" class="gh-badge" title={task.githubUrl}>
                          <IconBrandGithub size={12} /> linked
                        </a>
                      {:else}
                        <span class="gh-none">—</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
            {#if workDisplayTasks.length === 0}
              <div class="task-empty">
                <IconFilter size={20} />
                <div>No tasks match the current filters.</div>
              </div>
            {/if}
          </div>
        {/if}
      {:else}
      {#if reviewViewMode === "cards"}
      <!-- Cards view: table of all review runs with status/details -->

      {#if running}
        <div class="run-progress" transition:slide={{ duration: 300 }}>
          <div class="run-banner">
            <span class="dot"></span>
            <span>{runLog || "Running…"}</span>
            <div class="run-banner-right">
              {#if reviewerCards.length > 0}
                <button
                  class="icon-btn {detailedReviewers ? "active" : ""}"
                  onclick={() => (detailedReviewers = !detailedReviewers)}
                  title={detailedReviewers ? "Streaming text view" : "Simple status view"}
                  aria-label="Toggle reviewer detail"
                  aria-pressed={detailedReviewers}
                >
                  {#if detailedReviewers}<IconMessage2 size={13} />{:else}<IconLayoutGrid size={13} />{/if}
                </button>
              {/if}
              <button class="btn btn-xs btn-danger" onclick={cancelRun} disabled={cancelling}>
                {#if cancelling}Cancelling…{:else}<IconSquare size={11} /> Cancel{/if}
              </button>
            </div>
          </div>
          {#if reviewerCards.length > 0}
            <div class="reviewer-grid">
              {#each reviewerCards as card (card.model + "-" + card.index)}
                <div class="reviewer-card {card.status}" class:aggregator-card={card.isAggregator}>
                  <div class="reviewer-card-head">
                    {#if card.status === "running"}
                      <IconRefresh size={14} class="spin" />
                    {:else if card.status === "queued"}
                      <IconClock size={14} class="pulse" />
                    {:else if card.status === "done"}
                      <IconCheck size={14} />
                    {:else}
                      <IconAlertTriangle size={14} />
                    {/if}
                    <span class="reviewer-model">{card.isAggregator ? "Aggregator" : modelLabel(card.model)}</span>
                    {#if card.isAggregator}<span class="reviewer-sub-model">{modelLabel(card.model)}</span>{/if}
                    <span class="reviewer-status-tag">{card.status}</span>
                  </div>
                  {#if detailedReviewers}
                    <div class="reviewer-text">
                      {#if card.status === "error" && card.error}
                        <span class="reviewer-error-msg">{card.error}</span>
                      {:else if card.isAggregator}
                        {aggregatorReasoning || "(no reasoning stream — producing JSON output…)"}
                      {:else if card.status === "done" && !(reviewerTexts[card.model] ?? "").trim()}
                        <span class="reviewer-error-msg">No output — model returned empty response</span>
                      {:else if card.status === "queued"}
                        <span class="reviewer-queued-msg">Queued at provider — waiting for a slot…</span>
                      {:else}
                        {reviewerTexts[card.model] ?? ""}
                      {/if}
                      {#if card.status === "running" || card.status === "queued"}<span class="caret-blink"></span>{/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else if backgroundRunning}
        <div class="run-banner" transition:slide={{ duration: 300 }}>
          <span class="dot"></span>
          <span>A scheduled review is running in the background…</span>
          <button class="btn btn-xs btn-danger" onclick={cancelRun} disabled={cancelling} style="margin-left: auto;">
            {#if cancelling}Cancelling…{:else}<IconSquare size={11} /> Cancel{/if}
          </button>
        </div>
      {/if}

      {#if configResults.length === 0 && !running}
        <div class="main-empty" transition:fade>
          <IconEye size={32} />
          <div>{selectedConfig ? `No reviews yet for “${selectedConfig.name}”.` : "No reviews yet."}</div>
          <div class="empty-hint">{selectedConfig ? "Run it or upload analysis to generate tasks." : "Select a config on the left and run it, or upload an external analysis."}</div>
          <div class="empty-actions">
            {#if selectedConfig}
              <button class="btn btn-sm btn-primary" onclick={() => runReviewNow(selectedConfig!)} disabled={!workspaceRoot}>
                <IconPlayerPlay size={13} /> Run now
              </button>
            {/if}
            <button class="btn btn-sm" onclick={() => { uploadConfigId = selectedConfigId ?? (configs.length > 0 ? configs[0].id : null); uploadPresetId = null; uploadMode = true; }} disabled={!workspaceRoot}>
              <IconUpload size={13} /> Upload analysis
            </button>
          </div>
        </div>
      {:else}
        <!-- Reviews table (filtered by selected config) -->
        <div class="task-table-wrap" transition:fade>
          <table class="task-table">
            <thead>
              <tr>
                <th class="col-status">Status</th>
                <th class="col-date">Date</th>
                <th class="col-trigger">Trigger</th>
                <th class="col-judge">Judge</th>
                <th class="col-tasks">Tasks</th>
                <th class="col-cost">Cost</th>
                <th class="col-actions"></th>
              </tr>
            </thead>
            <tbody>
              {#each configResults as r (r.id)}
                <tr
                  class="task-row {r.status}"
                  class:selected={r.id === selectedResultId}
                  role="button"
                  tabindex="0"
                  onclick={() => loadResult(r.id)}
                  onkeydown={(e) => { if (e.key === "Enter") loadResult(r.id); }}
                >
                  <td class="col-status">
                    <span class="status-tag {r.status}">
                      {#if r.status === "running"}<IconRefresh size={11} class="spin" />
                      {:else if r.status === "complete"}<IconCircleCheck size={11} />
                      {:else if r.status === "error" || r.status === "interrupted"}<IconAlertTriangle size={11} />
                      {:else}<IconSquare size={11} />{/if}
                      {r.status}
                    </span>
                  </td>
                  <td class="col-date"><span class="task-date-cell">{fmtDate(r.startedAt)}</span></td>
                  <td class="col-trigger"><span class="task-reviewers-cell">{r.triggeredBy}</span></td>
                  <td class="col-judge">
                    <span class="task-reviewers-cell">{modelLabel(r.aggregatorModel)}</span>
                  </td>
                  <td class="col-tasks">
                    {#if r.status === "complete"}
                      <span class="task-count-cell">
                        {#if r.p0 > 0}<span class="stat-pill p0">{r.p0} P0</span>{/if}
                        {#if r.p1 > 0}<span class="stat-pill p1">{r.p1} P1</span>{/if}
                        {#if r.p2 > 0}<span class="stat-pill p2">{r.p2} P2</span>{/if}
                        {#if r.p3 > 0}<span class="stat-pill p3">{r.p3} P3</span>{/if}
                        {#if !r.p0 && !r.p1 && !r.p2 && !r.p3}—{/if}
                      </span>
                    {:else}
                      <span class="task-reviewers-cell">—</span>
                    {/if}
                  </td>
                  <td class="col-cost">
                    {#if r.actualCost != null && r.actualCost > 0}
                      <span class="task-reviewers-cell font-bold" title="Actual cost billed by OpenRouter">{fmtCost(r.actualCost)}</span>
                    {:else if r.estimatedCost != null && r.estimatedCost > 0}
                      <span class="task-reviewers-cell opacity-70" title="Estimated cost">{fmtCost(r.estimatedCost)}</span>
                    {:else}
                      <span class="task-reviewers-cell">free</span>
                    {/if}
                  </td>
                  <td class="col-actions">
                    <div class="task-row-actions">
                      {#if r.status === "interrupted" && r.canResume}
                        <button
                          class="icon-btn resume-btn"
                          onclick={(e) => { e.stopPropagation(); void resumeRunNow(r.id); }}
                          title="Resume — reuses completed reviewer outputs, re-runs only the missing ones"
                          aria-label="Resume run"
                          disabled={running}
                        >
                          <IconPlayerPlay size={13} />
                        </button>
                      {/if}
                      {#if r.status === "complete" && r.taskCount > 0}
                        <button
                          class="icon-btn {selectedResultId === r.id ? "active" : ""}"
                          onclick={(e) => { e.stopPropagation(); toggleResult(r.id); }}
                          title={selectedResultId === r.id ? "Hide tasks" : "View tasks"}
                          aria-label={selectedResultId === r.id ? "Hide tasks" : "View tasks"}
                          aria-pressed={selectedResultId === r.id}
                        >
                          <IconListCheck size={13} />
                        </button>
                      {/if}
                      {#if r.status !== "running"}
                        <button class="icon-btn" onclick={(e) => { e.stopPropagation(); void openRawOutput(r.id); }} title="Raw reviewer + judge output" aria-label="Raw output" disabled={rawLoading}>
                          <IconFileText size={13} />
                        </button>
                      {/if}
                    </div>
                  </td>
                </tr>
                {/each}
              </tbody>
            </table>
          </div>

          <!-- Selected run's task list (living list) -->
          {#if selectedResult}
            <div class="result-header selected-result-header" transition:fade>
              <div class="result-header-left">
                <div class="result-title">Tasks · {fmtDate(selectedResult.startedAt)}</div>
                <div class="result-meta">
                  {taskStats.open} open · {taskStats.resolved} resolved
                  {#if selectedResult.mergeStats}
                    · +{selectedResult.mergeStats.added} new · {selectedResult.mergeStats.autoResolved} auto-resolved
                  {/if}
                </div>
              </div>
              <div class="result-header-right">
                {#if selectedResult.mergeStats}
                  <span class="merge-badge">
                    +{selectedResult.mergeStats.added} new · {selectedResult.mergeStats.carried} carried · {selectedResult.mergeStats.autoResolved} resolved
                  </span>
                {/if}
                {#if selectedResult.actualCost != null && selectedResult.actualCost > 0}
                  <span class="cost-badge" title="Actual cost billed by OpenRouter"><IconCoin size={11} /> {fmtCost(selectedResult.actualCost)}</span>
                {:else if selectedResult.estimatedCost != null && selectedResult.estimatedCost > 0}
                  <span class="cost-badge" title="Estimated cost"><IconCoin size={11} /> {fmtCost(selectedResult.estimatedCost)}</span>
                {/if}
                {#if selectedResult.actualTokens}
                  <span class="token-badge" title="Actual tokens"><IconStack size={11} /> {selectedResult.actualTokens.toLocaleString()} tok</span>
                {:else if selectedResult.estimatedTokens}
                  <span class="token-badge" title="Estimated tokens"><IconStack size={11} /> {selectedResult.estimatedTokens.toLocaleString()} tok</span>
                {/if}
              </div>
            </div>

            {#if taskStats.open > 0}
              <div class="priority-bar" transition:fade>
                {#each ["P0", "P1", "P2", "P3"] as p (p)}
                  {@const count = taskStats[p.toLowerCase() as "p0" | "p1" | "p2" | "p3"]}
                  {#if count > 0}
                    <div class="priority-seg {p.toLowerCase()}" style="flex: {count}">
                      <span class="seg-label">{p}</span>
                      <span class="seg-count">{count}</span>
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}

            <!-- Lens legend — click a lens to filter by it -->
            {#if reviewLensLegend.length > 0}
              <div class="lens-legend" transition:fade>
                {#each reviewLensLegend as l (l.key)}
                  <button
                    class="lens-legend-item {filterLens === l.key ? "active" : ""}"
                    onclick={() => { filterLens = filterLens === l.key ? "all" : l.key; }}
                    title="{l.label} — {l.count} open task{l.count === 1 ? "" : "s"}"
                    aria-pressed={filterLens === l.key}
                  >
                    <span class="lens-legend-emoji">{l.emoji}</span>
                    {l.key}
                    {#if l.count > 0}<span class="lens-legend-count">{l.count}</span>{/if}
                  </button>
                {/each}
              </div>
            {/if}

            <div class="task-toolbar" transition:fade>
              <div class="task-filter-group">
                <select class="task-filter-select" bind:value={filterPriority} aria-label="Filter by priority">
                  <option value="all">All priorities</option>
                  <option value="P0">P0</option>
                  <option value="P1">P1</option>
                  <option value="P2">P2</option>
                  <option value="P3">P3</option>
                </select>
                <select class="task-filter-select" bind:value={filterLens} aria-label="Filter by lens">
                  <option value="all">All lenses</option>
                  {#each availableLenses as lens (lens)}
                    <option value={lens}>{lensShortLabel(lens)}</option>
                  {/each}
                </select>
                <select class="task-filter-select" bind:value={filterStatus} aria-label="Filter by status">
                  <option value="open">Open</option>
                  <option value="resolved">Resolved</option>
                  <option value="all">All</option>
                </select>
              </div>
              <div class="task-search-group">
                <IconSearch size={13} class="search-icon" />
                <input class="task-search-input" type="text" placeholder="Search tasks…" bind:value={taskSearch} />
              </div>
              <span class="task-count-badge">{displayTasks.length} / {selectedResult.tasks.length}</span>
            </div>

            <div class="task-table-wrap" transition:fade>
              <table class="task-table">
                <thead>
                  <tr>
                    <th class="col-check"></th>
                    <th class="col-prio" onclick={() => toggleSort("priority")} role="button" tabindex="0">
                      Priority
                      {#if sortKey === "priority"}<IconArrowsSort size={11} class="sort-icon {sortDir}" />{/if}
                    </th>
                    <th class="col-issue" onclick={() => toggleSort("issue")} role="button" tabindex="0">
                      Issue
                      {#if sortKey === "issue"}<IconArrowsSort size={11} class="sort-icon {sortDir}" />{/if}
                    </th>
                    <th class="col-finding">Main finding</th>
                    <th class="col-fix">Fix</th>
                    <th class="col-impact" onclick={() => toggleSort("impact")} role="button" tabindex="0">
                      Impact
                      {#if sortKey === "impact"}<IconArrowsSort size={11} class="sort-icon {sortDir}" />{/if}
                    </th>
                    <th class="col-lenses" onclick={() => toggleSort("lenses")} role="button" tabindex="0">
                      Lenses
                      {#if sortKey === "lenses"}<IconArrowsSort size={11} class="sort-icon {sortDir}" />{/if}
                    </th>
                    <th class="col-reviewers" onclick={() => toggleSort("reviewers")} role="button" tabindex="0">
                      Reviewers
                      {#if sortKey === "reviewers"}<IconArrowsSort size={11} class="sort-icon {sortDir}" />{/if}
                    </th>
                    <th class="col-gh">GitHub</th>
                  </tr>
                </thead>
                <tbody>
                  {#each displayTasks as task, i (task.fingerprint ?? i)}
                    {@const PI = priorityIcon(task.priority)}
                    <tr class="task-row {task.priority.toLowerCase()} {task.resolved ? "resolved" : ""}">
                      <td class="col-check">
                        <button
                          class="task-check {task.resolved ? "checked" : ""}"
                          onclick={() => toggleTaskResolved(task)}
                          title={task.resolved ? "Reopen task" : "Resolve task"}
                          aria-label={task.resolved ? "Reopen task" : "Resolve task"}
                        >
                          {#if task.resolved}<IconCircleCheck size={14} />{:else}<IconCheck size={13} />{/if}
                        </button>
                      </td>
                      <td class="col-prio">
                        <span class="task-prio {task.priority.toLowerCase()}">
                          <PI size={12} />
                          {task.priority}
                        </span>
                      </td>
                      <td class="col-issue"><span class="task-issue-text">{task.issue}</span></td>
                      <td class="col-finding"><span class="task-full-cell">{task.mainFinding || "—"}</span></td>
                      <td class="col-fix"><span class="task-full-cell">{task.fix || "—"}</span></td>
                      <td class="col-impact"><span class="task-full-cell">{task.impact || "—"}</span></td>
                      <td class="col-lenses">
                        <div class="task-tags-cell">
                          {#each task.lenses as lens (lens)}
                            <span class="task-lens-tag" title={lensLabel(lens, selectedConfigId)}>{lensEmoji(lens)} {lens}</span>
                          {/each}
                        </div>
                      </td>
                      <td class="col-reviewers">
                        <div class="rev-chips" title={task.reviewers.map((r: string) => reviewerPopover(r, selectedResult?.reviewerModels)).join(", ")}>
                          {#each task.reviewers as r (r)}
                            <span class="rev-chip">
                              <i class="rev-dot" style="background: {reviewerDot(friendlyReviewer(r))}"></i>
                              {friendlyReviewer(r)}
                            </span>
                          {:else}
                            <span class="gh-none">—</span>
                          {/each}
                        </div>
                      </td>
                      <td class="col-gh">
                        {#if task.githubUrl}
                          <a href={task.githubUrl} target="_blank" rel="noopener" class="gh-badge" title={task.githubUrl}>
                            <IconBrandGithub size={12} /> linked
                          </a>
                        {:else if !task.resolved}
                          <button
                            class="icon-btn gh-create"
                            onclick={() => createIssue(selectedResult!.id, selectedResult!.tasks.indexOf(task))}
                            disabled={creatingIssueIdx !== null}
                            title="Create GitHub issue"
                            aria-label="Create GitHub issue"
                          >
                            <IconBrandGithub size={13} />
                          </button>
                        {:else}
                          <span class="gh-none">—</span>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              {#if displayTasks.length === 0}
                <div class="task-empty">
                  <IconFilter size={20} />
                  <div>{selectedResult.tasks.length === 0 ? "This run produced no tasks." : "No tasks match the current filters."}</div>
                </div>
              {/if}
            </div>
          {/if}
        {/if}
      {:else if reviewViewMode === "kanban"}
        <!-- ===== KANBAN VIEW ===== -->
        {#if running || backgroundRunning}
          <div class="run-banner" transition:slide={{ duration: 300 }}>
            <span class="dot"></span>
            <span>{runLog || "Running…"}</span>
            {#if running}<button class="btn btn-xs btn-danger" onclick={cancelRun} disabled={cancelling} style="margin-left:auto;">{#if cancelling}Cancelling…{:else}<IconSquare size={11} /> Cancel{/if}</button>{/if}
          </div>
        {/if}
        {#if !selectedResult && !running}
          <div class="main-empty" transition:fade>
            <IconColumns size={32} />
            <div>{selectedConfig ? `No reviews yet for "${selectedConfig.name}".` : "Select a config on the left."}</div>
            {#if selectedConfig}<div class="empty-actions"><button class="btn btn-sm btn-primary" onclick={() => runReviewNow(selectedConfig!)} disabled={!workspaceRoot}><IconPlayerPlay size={13} /> Run now</button></div>{/if}
          </div>
        {:else if selectedResult}
          {@const ktasks = selectedResult.tasks}
          {@const kopen = ktasks.filter((t) => !t.resolved)}
          {@const kresolved = ktasks.filter((t) => t.resolved)}
          <div class="kanban-board" transition:fade>
            {#each ["P0", "P1", "P2", "P3"] as col (col)}
              {@const colTasks = kopen.filter((t) => t.priority === col)}
              <div class="kanban-col kanban-{col.toLowerCase()}">
                <div class="kanban-col-header">
                  <span class="kanban-col-prio {col.toLowerCase()}">{col}</span>
                  <span class="kanban-col-count">{colTasks.length}</span>
                </div>
                <div class="kanban-col-body">
                  {#each colTasks as task, i (task.fingerprint ?? i)}
                    {@const PI = priorityIcon(task.priority)}
                    <div class="kanban-card {col.toLowerCase()}">
                      <button class="task-check" onclick={() => toggleTaskResolved(task)} title="Resolve task" aria-label="Resolve task"><IconCheck size={13} /></button>
                      <div class="kanban-card-issue">{task.issue}</div>
                      {#if task.fix}<div class="kanban-card-fix">{task.fix}</div>{/if}
                      <div class="kanban-card-tags">
                        {#each task.lenses as lens (lens)}<span class="task-lens-tag" title={lensLabel(lens, selectedConfigId)}>{lensEmoji(lens)} {lens}</span>{/each}
                      </div>
                      {#if task.githubUrl}<a href={task.githubUrl} target="_blank" rel="noopener" class="gh-badge"><IconBrandGithub size={11} /> linked</a>{/if}
                    </div>
                  {/each}
                  {#if colTasks.length === 0}<div class="kanban-col-empty">—</div>{/if}
                </div>
              </div>
            {/each}
            <!-- Resolved column -->
            <div class="kanban-col kanban-resolved">
              <div class="kanban-col-header">
                <span class="kanban-col-prio resolved"><IconCircleCheck size={13} /> Resolved</span>
                <span class="kanban-col-count">{kresolved.length}</span>
              </div>
              <div class="kanban-col-body">
                {#each kresolved as task, i (task.fingerprint ?? i)}
                  <div class="kanban-card resolved">
                    <button class="task-check checked" onclick={() => toggleTaskResolved(task)} title="Reopen task" aria-label="Reopen task"><IconCircleCheck size={14} /></button>
                    <div class="kanban-card-issue">{task.issue}</div>
                  </div>
                {/each}
                {#if kresolved.length === 0}<div class="kanban-col-empty">No resolved tasks</div>{/if}
              </div>
            </div>
          </div>
          <div class="kanban-run-info">
            {fmtDate(selectedResult.startedAt)} · {taskStats.open} open · {taskStats.resolved} resolved
            {#if selectedResult.estimatedCost != null && selectedResult.estimatedCost > 0}· <IconCoin size={11} /> {fmtCost(selectedResult.estimatedCost)}{/if}
          </div>
        {/if}

      {:else if reviewViewMode === "theater"}
        <!-- ===== THEATER VIEW ===== -->
        {#if running || backgroundRunning}
          <div class="theater-stage" transition:fade>
            <div class="theater-banner">
              <span class="dot"></span>
              <span>{runLog || "Running…"}</span>
              <div class="theater-banner-right">
                <button class="btn btn-xs btn-danger" onclick={cancelRun} disabled={cancelling}>{#if cancelling}Cancelling…{:else}<IconSquare size={11} /> Cancel{/if}</button>
              </div>
            </div>
            {#if reviewerCards.length > 0}
              <div class="theater-grid">
                {#each reviewerCards as card (card.model + "-" + card.index)}
                  <div class="theater-card {card.status}" class:aggregator={card.isAggregator}>
                    <div class="theater-card-head">
                      {#if card.status === "running"}<IconRefresh size={14} class="spin" />
                      {:else if card.status === "queued"}<IconClock size={14} class="pulse" />
                      {:else if card.status === "done"}<IconCheck size={14} />
                      {:else}<IconAlertTriangle size={14} />{/if}
                      <span class="theater-card-model">{card.isAggregator ? "Aggregator" : modelLabel(card.model)}</span>
                      {#if card.isAggregator}<span class="theater-card-sub">{modelLabel(card.model)}</span>{/if}
                      <span class="theater-card-status">{card.status}</span>
                    </div>
                    <div class="theater-card-text">
                      {#if card.isAggregator}{aggregatorReasoning || "(producing JSON output…)"}{:else if card.status === "queued"}<span class="reviewer-queued-msg">Queued at provider — waiting for a slot…</span>{:else}{reviewerTexts[card.model] ?? ""}{/if}
                      {#if card.status === "running" || card.status === "queued"}<span class="caret-blink"></span>{/if}
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="theater-waiting">{runPhase === "context" ? "Gathering context…" : runPhase === "cost" ? "Estimating cost…" : "Starting committee…"}</div>
            {/if}
          </div>
        {:else if selectedResult}
          <!-- Post-run: tasks grouped by lens -->
          <div class="theater-results" transition:fade>
            <div class="theater-results-header">
              <div class="result-title">Committee verdict · {fmtDate(selectedResult.startedAt)}</div>
              <div class="result-meta">{taskStats.open} open · {taskStats.resolved} resolved · {selectedResult.reviewerModels?.length ?? 0} reviewers</div>
            </div>
            {#if tasksByLens.length === 0}
              <div class="main-empty"><IconBroadcast size={32} /><div>This run produced no tasks.</div></div>
            {:else}
          <div class="theater-lens-list">
            {#each tasksByLens as group (group.lens)}
              <details class="theater-lens-section" open>
                <summary class="theater-lens-summary">
                  <span class="theater-lens-emoji">{lensEmoji(group.lens)}</span>
                  <span class="theater-lens-name">{lensLabel(group.lens, selectedConfigId)}</span>
                  <span class="theater-lens-count">{group.tasks.filter((t) => !t.resolved).length} open</span>
                  <IconChevronDown size={14} class="theater-chevron" />
                </summary>
                <div class="theater-lens-tasks">
                  {#each group.tasks as task, i (task.fingerprint ?? i)}
                    {@const PI = priorityIcon(task.priority)}
                    <div class="theater-task {task.priority.toLowerCase()} {task.resolved ? "resolved" : ""}">
                      <button class="task-check {task.resolved ? "checked" : ""}" onclick={() => toggleTaskResolved(task)} title={task.resolved ? "Reopen" : "Resolve"} aria-label={task.resolved ? "Reopen" : "Resolve"}>{#if task.resolved}<IconCircleCheck size={14} />{:else}<IconCheck size={13} />{/if}</button>
                      <span class="task-prio {task.priority.toLowerCase()}"><PI size={12} /> {task.priority}</span>
                      <span class="theater-task-issue">{task.issue}</span>
                      {#if task.fix}<span class="theater-task-fix">→ {task.fix}</span>{/if}
                    </div>
                  {/each}
                </div>
              </details>
            {/each}
          </div>
        {/if}
          </div>
        {:else}
          <div class="main-empty" transition:fade>
            <IconBroadcast size={32} />
            <div>{selectedConfig ? `No reviews yet for "${selectedConfig.name}".` : "Select a config on the left."}</div>
            {#if selectedConfig}<div class="empty-actions"><button class="btn btn-sm btn-primary" onclick={() => runReviewNow(selectedConfig!)} disabled={!workspaceRoot}><IconPlayerPlay size={13} /> Run now</button></div>{/if}
          </div>
        {/if}

      {:else if reviewViewMode === "tracker"}
        <!-- ===== TRACKER VIEW ===== -->
        {#if running || backgroundRunning}
          <div class="run-banner" transition:slide={{ duration: 300 }}>
            <span class="dot"></span>
            <span>{runLog || "Running…"}</span>
            {#if running}<button class="btn btn-xs btn-danger" onclick={cancelRun} disabled={cancelling} style="margin-left:auto;">{#if cancelling}Cancelling…{:else}<IconSquare size={11} /> Cancel{/if}</button>{/if}
          </div>
        {/if}
        {#if !selectedResult && !running}
          <div class="main-empty" transition:fade>
            <IconListCheck size={32} />
            <div>{selectedConfig ? `No reviews yet for "${selectedConfig.name}".` : "Select a config on the left."}</div>
            {#if selectedConfig}<div class="empty-actions"><button class="btn btn-sm btn-primary" onclick={() => runReviewNow(selectedConfig!)} disabled={!workspaceRoot}><IconPlayerPlay size={13} /> Run now</button></div>{/if}
          </div>
        {:else if selectedResult}
          <div class="tracker-layout" transition:fade>
            <div class="tracker-list">
              <div class="tracker-filters">
                <select class="task-filter-select" bind:value={filterPriority} aria-label="Filter by priority">
                  <option value="all">All priorities</option><option value="P0">P0</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option>
                </select>
                <select class="task-filter-select" bind:value={filterLens} aria-label="Filter by lens">
                  <option value="all">All lenses</option>
                  {#each availableLenses as lens (lens)}<option value={lens}>{lensShortLabel(lens)}</option>{/each}
                </select>
                <select class="task-filter-select" bind:value={filterStatus} aria-label="Filter by status">
                  <option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option>
                </select>
                <div class="task-search-group">
                  <IconSearch size={13} class="search-icon" />
                  <input class="task-search-input" type="text" placeholder="Search…" bind:value={taskSearch} />
                </div>
                <span class="task-count-badge">{displayTasks.length} / {selectedResult.tasks.length}</span>
              </div>
              <div class="tracker-rows">
                {#each displayTasks as task, i (task.fingerprint ?? i)}
                  {@const PI = priorityIcon(task.priority)}
                  <div
                    class="tracker-row {task.priority.toLowerCase()} {task.resolved ? "resolved" : ""} {trackerDetailTask === task ? "selected" : ""}"
                    role="button" tabindex="0"
                    onclick={() => { trackerDetailTask = task; if (!task.resolved) creatingIssueIdx ?? null; }}
                    onkeydown={(e) => { if (e.key === "Enter") trackerDetailTask = task; }}
                  >
                    <button class="task-check {task.resolved ? "checked" : ""}" onclick={(e) => { e.stopPropagation(); toggleTaskResolved(task); }} title={task.resolved ? "Reopen" : "Resolve"} aria-label={task.resolved ? "Reopen" : "Resolve"}>{#if task.resolved}<IconCircleCheck size={14} />{:else}<IconCheck size={13} />{/if}</button>
                    <span class="task-prio {task.priority.toLowerCase()}"><PI size={12} /> {task.priority}</span>
                    <span class="tracker-row-issue">{task.issue}</span>
                    <span class="tracker-row-lenses">{#each task.lenses as lens (lens)}{lensEmoji(lens)}{/each}</span>
                    {#if task.githubUrl}<a href={task.githubUrl} target="_blank" rel="noopener" class="gh-badge" onclick={(e) => e.stopPropagation()}><IconBrandGithub size={11} /></a>{/if}
                  </div>
                {/each}
                {#if displayTasks.length === 0}<div class="task-empty"><IconFilter size={20} /><div>No tasks match the current filters.</div></div>{/if}
              </div>
            </div>
            {#if trackerDetailTask}
              {@const dt = trackerDetailTask}
              {@const DPI = priorityIcon(dt.priority)}
              <div class="tracker-detail" transition:fly={{ x: 30, duration: 300 }}>
                <div class="tracker-detail-header">
                  <span class="result-title">Task detail</span>
                  <button class="icon-btn" onclick={() => { trackerDetailTask = null; }} aria-label="Close detail"><IconX size={15} /></button>
                </div>
                <div class="tracker-detail-body">
                  <div class="tracker-detail-prio"><span class="task-prio {dt.priority.toLowerCase()}"><DPI size={14} /> {dt.priority}</span> {#if dt.resolved}<span class="status-tag complete"><IconCircleCheck size={11} /> resolved</span>{/if}</div>
                  <div class="tracker-detail-issue">{dt.issue}</div>
                  {#if dt.mainFinding}<div class="tracker-detail-section"><span class="field-label">Main finding</span><div>{dt.mainFinding}</div></div>{/if}
                  {#if dt.fix}<div class="tracker-detail-section"><span class="field-label">Fix</span><div>{dt.fix}</div></div>{/if}
                  {#if dt.impact}<div class="tracker-detail-section"><span class="field-label">Impact</span><div>{dt.impact}</div></div>{/if}
                  <div class="tracker-detail-section"><span class="field-label">Lenses</span><div class="tracker-detail-tags">{#each dt.lenses as lens (lens)}<span class="task-lens-tag" title={lensLabel(lens, selectedConfigId)}>{lensEmoji(lens)} {lensLabel(lens, selectedConfigId)}</span>{/each}</div></div>
                  <div class="tracker-detail-section"><span class="field-label">Reviewers</span><div class="rev-chips">{#each dt.reviewers as r (r)}<span class="rev-chip"><i class="rev-dot" style="background: {reviewerDot(friendlyReviewer(r))}"></i>{friendlyReviewer(r)}</span>{/each}</div></div>
                  <div class="tracker-detail-actions">
                    <button class="btn btn-sm {dt.resolved ? "" : "btn-ghost"}" onclick={() => toggleTaskResolved(dt)}>{#if dt.resolved}Reopen{:else}Resolve{/if}</button>
                    {#if dt.githubUrl}<a href={dt.githubUrl} target="_blank" rel="noopener" class="btn btn-sm"><IconBrandGithub size={13} /> View issue</a>{:else if !dt.resolved}<button class="btn btn-sm btn-primary" onclick={() => createIssue(selectedResult!.id, selectedResult!.tasks.indexOf(dt))} disabled={creatingIssueIdx !== null}><IconBrandGithub size={13} /> Create issue</button>{/if}
                  </div>
                </div>
              </div>
            {:else}
              <div class="tracker-detail-empty">
                <IconPoint size={24} />
                <div>Select a task to view details</div>
              </div>
            {/if}
          </div>
        {/if}

      {:else if reviewViewMode === "scorecard"}
        <!-- ===== SCORECARD VIEW ===== -->
        {#if running || backgroundRunning}
          <div class="run-banner" transition:slide={{ duration: 300 }}>
            <span class="dot"></span>
            <span>{runLog || "Running…"}</span>
            {#if running}<button class="btn btn-xs btn-danger" onclick={cancelRun} disabled={cancelling} style="margin-left:auto;">{#if cancelling}Cancelling…{:else}<IconSquare size={11} /> Cancel{/if}</button>{/if}
          </div>
        {/if}
        {#if !selectedResult && !running}
          <div class="main-empty" transition:fade>
            <IconChartBar size={32} />
            <div>{selectedConfig ? `No reviews yet for "${selectedConfig.name}".` : "Select a config on the left."}</div>
            {#if selectedConfig}<div class="empty-actions"><button class="btn btn-sm btn-primary" onclick={() => runReviewNow(selectedConfig!)} disabled={!workspaceRoot}><IconPlayerPlay size={13} /> Run now</button></div>{/if}
          </div>
        {:else if selectedResult}
          <div class="scorecard" transition:fade>
            <!-- Health score -->
            <div class="scorecard-hero">
              <div class="scorecard-score {healthScore >= 75 ? "good" : healthScore >= 50 ? "ok" : "bad"}">
                <span class="scorecard-score-num">{healthScore}</span>
                <span class="scorecard-score-max">/100</span>
              </div>
              <div class="scorecard-trend">
                {#if netDelta !== null}
                  <span class="scorecard-delta {netDelta < 0 ? "good" : netDelta > 0 ? "bad" : ""}">
                    {#if netDelta < 0}<IconTrendingDown size={16} /> {netDelta} tasks{:else if netDelta > 0}<IconTrendingUp size={16} /> +{netDelta} tasks{:else}no change{/if}
                  </span>
                  <span class="scorecard-delta-sub">vs {fmtDate(runDeltas!.prev.startedAt)}</span>
                {/if}
              </div>
            </div>

            <!-- Sparkline -->
            {#if sparklineData.length > 1}
              <div class="scorecard-sparkline" transition:fade>
                <div class="sparkline-label">Task count trend ({sparklineData.length} runs)</div>
                <div class="sparkline-chart">
                  {#each sparklineData as d (d.id)}
                    <div class="sparkline-bar" title="{fmtDate(d.date)}: {d.total} tasks (P0:{d.p0} P1:{d.p1} P2:{d.p2} P3:{d.p3})" style="height: {Math.max((d.total / sparklineMaxVal) * 100, 3)}%">
                      <div class="sparkline-seg p0" style="flex: {d.p0}"></div>
                      <div class="sparkline-seg p1" style="flex: {d.p1}"></div>
                      <div class="sparkline-seg p2" style="flex: {d.p2}"></div>
                      <div class="sparkline-seg p3" style="flex: {d.p3}"></div>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Lens grades -->
            {#if lensGrades.length > 0}
              <div class="scorecard-grades" transition:fade>
                <div class="sparkline-label">Lens health grades</div>
                <div class="grade-grid">
                  {#each lensGrades as g (g.lens)}
                    <div class="grade-card {g.grade.startsWith("A") ? "good" : g.grade.startsWith("B") ? "ok" : "bad"}">
                      <span class="grade-emoji">{lensEmoji(g.lens)}</span>
                      <span class="grade-label">{lensLabel(g.lens, selectedConfigId)}</span>
                      <span class="grade-letter">{g.grade}</span>
                      <span class="grade-detail">P0:{g.counts.P0} P1:{g.counts.P1} P2:{g.counts.P2} P3:{g.counts.P3}</span>
                    </div>
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Top P0 issues -->
            {#if topP0Tasks.length > 0}
              <div class="scorecard-top-issues" transition:fade>
                <div class="sparkline-label">Top P0 issues ({topP0Tasks.length})</div>
                {#each topP0Tasks.slice(0, 5) as task, i (task.fingerprint ?? i)}
                  <div class="scorecard-issue-row p0">
                    <button class="task-check" onclick={() => toggleTaskResolved(task)} title="Resolve" aria-label="Resolve"><IconCheck size={13} /></button>
                    <IconFlame size={13} class="p0-icon" />
                    <span class="scorecard-issue-text">{task.issue}</span>
                    <span class="scorecard-issue-lenses">{#each task.lenses as lens (lens)}{lensEmoji(lens)}{/each}</span>
                  </div>
                {/each}
                {#if topP0Tasks.length > 5}<div class="scorecard-more">+{topP0Tasks.length - 5} more P0 — switch to Cards/Tracker for full list</div>{/if}
              </div>
            {/if}
          </div>
        {/if}

      {:else if reviewViewMode === "timeline"}
        <!-- ===== TIMELINE VIEW ===== -->
        {#if running || backgroundRunning}
          <div class="run-banner" transition:slide={{ duration: 300 }}>
            <span class="dot"></span>
            <span>{runLog || "Running…"}</span>
            {#if running}<button class="btn btn-xs btn-danger" onclick={cancelRun} disabled={cancelling} style="margin-left:auto;">{#if cancelling}Cancelling…{:else}<IconSquare size={11} /> Cancel{/if}</button>{/if}
          </div>
        {/if}
        <div class="timeline-feed" transition:fade>
          {#if configResults.length === 0 && !running}
            <div class="main-empty">
              <IconHistory size={32} />
              <div>{selectedConfig ? `No reviews yet for "${selectedConfig.name}".` : "Select a config on the left."}</div>
            </div>
          {:else}
            {#each configResults as r (r.id)}
              <div class="timeline-msg {r.status}" transition:fly={{ y: 16, duration: 300, easing: cubicInOut }}>
                <div class="timeline-msg-avatar">
                  {#if r.status === "running"}<IconRefresh size={16} class="spin" />
                  {:else if r.status === "complete"}<IconCircleCheck size={16} />
                  {:else}<IconAlertTriangle size={16} />{/if}
                </div>
                <div class="timeline-msg-body">
                  <div class="timeline-msg-header">
                    <span class="timeline-msg-date">{fmtDate(r.startedAt)}</span>
                    <span class="timeline-msg-trigger">{r.triggeredBy}</span>
                    <span class="timeline-msg-models">{modelLabel(r.aggregatorModel)}</span>
                    {#if r.status === "complete"}
                      <span class="timeline-msg-stats">
                        {#if r.p0 > 0}<span class="stat-pill p0">{r.p0} P0</span>{/if}
                        {#if r.p1 > 0}<span class="stat-pill p1">{r.p1} P1</span>{/if}
                        {#if r.p2 > 0}<span class="stat-pill p2">{r.p2} P2</span>{/if}
                        {#if r.p3 > 0}<span class="stat-pill p3">{r.p3} P3</span>{/if}
                      </span>
                    {/if}
                    {#if r.actualCost != null && r.actualCost > 0}
                      <span class="cost-badge" title="Actual cost billed by OpenRouter"><IconCoin size={10} /> {fmtCost(r.actualCost)}</span>
                    {:else if r.estimatedCost != null && r.estimatedCost > 0}
                      <span class="cost-badge" title="Estimated cost"><IconCoin size={10} /> {fmtCost(r.estimatedCost)}</span>
                    {/if}
                    {#if r.status === "interrupted" && r.canResume}
                      <button class="btn btn-xs timeline-resume-btn" onclick={() => void resumeRunNow(r.id)} disabled={running} title="Resume — reuses completed reviewer outputs, re-runs only the missing ones">
                        <IconPlayerPlay size={11} /> Resume
                      </button>
                    {/if}
                  </div>
                  {#if r.status === "interrupted"}
                    <div class="timeline-msg-note">{r.error ?? "Interrupted — the run can be resumed."}</div>
                  {/if}
                  {#if r.status === "complete" && r.taskCount > 0}
                    <details class="timeline-msg-details">
                      <summary class="timeline-msg-summary">View {r.taskCount} task{r.taskCount === 1 ? "" : "s"}</summary>
                      {#if selectedResultId === r.id && selectedResult}
                        <div class="timeline-msg-tasks">
                          {#each selectedResult.tasks.filter((t) => !t.resolved).slice(0, 10) as task, i (task.fingerprint ?? i)}
                            <div class="timeline-task {task.priority.toLowerCase()}">
                              <button class="task-check" onclick={() => toggleTaskResolved(task)} title="Resolve" aria-label="Resolve"><IconCheck size={13} /></button>
                              <span class="task-prio {task.priority.toLowerCase()}">{task.priority}</span>
                              <span class="timeline-task-issue">{task.issue}</span>
                            </div>
                          {/each}
                          {#if selectedResult.tasks.filter((t) => !t.resolved).length > 10}
                            <div class="timeline-more">+{selectedResult.tasks.filter((t) => !t.resolved).length - 10} more — switch to Cards/Tracker for full list</div>
                          {/if}
                        </div>
                      {:else}
                        <button class="btn btn-xs btn-ghost timeline-load-btn" onclick={() => loadResult(r.id)}>Load tasks</button>
                      {/if}
                    </details>
                  {/if}
                </div>
              </div>
            {/each}
            <!-- Composer row -->
            <div class="timeline-composer">
              {#if selectedConfig}
                <button class="btn btn-sm btn-primary" onclick={() => runReviewNow(selectedConfig!)} disabled={!workspaceRoot || running}>
                  <IconPlayerPlay size={13} /> Run "{selectedConfig.name}"
                </button>
              {/if}
              {#each presets.slice(0, 4) as p (p.id)}
                <button class="btn btn-xs btn-ghost" onclick={() => clonePresetAndRun(p)} disabled={!workspaceRoot || running} title={p.description}>
                  {p.name}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {/if}
    </div>
  </main>
</div>

<!-- Upload analysis modal -->
{#if uploadMode}
  <div class="modal-backdrop" transition:fade={{ duration: 200 }} onclick={() => (uploadMode = false)} onkeydown={(e) => { if (e.key === "Escape") uploadMode = false; }} role="presentation">
    <div class="modal modal-wide" transition:fly={{ y: 30, duration: 400, easing: cubicInOut }} onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
      <header class="modal-header">
        <span class="modal-title">Upload Analysis — Run Judge Only</span>
        <button class="modal-close" onclick={() => (uploadMode = false)} aria-label="Close"><IconX size={16} /></button>
      </header>
      <div class="modal-body">
        <p class="upload-intro">
          Paste the raw output from external AI reviewers below. The aggregator/judge model
          will merge them into a deduplicated task list. No reviewer models are called — only the judge runs.
        </p>
        <div class="upload-config-select">
          <span class="field-label">Associate with</span>
          <div class="upload-source-tabs">
            <button class="upload-tab" class:active={uploadConfigId !== null} onclick={() => { uploadConfigId = selectedConfigId ?? configs[0]?.id ?? null; uploadPresetId = null; }}>
              Saved configs
            </button>
            <button class="upload-tab" class:active={uploadPresetId !== null} onclick={() => { uploadPresetId = presets[0]?.id ?? null; uploadConfigId = null; }}>
              Presets
            </button>
          </div>
          {#if uploadConfigId !== null}
            {#if configs.length === 0}
              <div class="field-muted">No saved configs yet. Switch to Presets to use one, or create a config first.</div>
            {:else}
              <select class="task-filter-select" bind:value={uploadConfigId} aria-label="Select config">
                {#each configs as c (c.id)}
                  <option value={c.id}>{c.name}</option>
                {/each}
              </select>
            {/if}
          {:else}
            {#if presets.length === 0}
              <div class="field-muted">No presets available.</div>
            {:else}
              <select class="task-filter-select" bind:value={uploadPresetId} aria-label="Select preset">
                {#each presets as p (p.id)}
                  <option value={p.id}>{p.name}{p.smokeTest ? " (smoke test)" : ""}</option>
                {/each}
              </select>
            {/if}
          {/if}
        </div>
        <div class="upload-bulk">
          <span class="field-label">Bulk paste (auto-splits on "=== Reviewer: model-id ===" or "Model: name" separators, or a model id on its own line)</span>
          <textarea
            class="upload-bulk-input"
            placeholder="Paste all reviewer outputs here. Separate them with '=== Reviewer: model-id ===' lines, 'Model: name' lines, or just the model id on its own line (e.g. claude-sonnet-5) — or paste everything as one reviewer."
            oninput={(e) => parseBulkPaste(e.currentTarget.value)}
          ></textarea>
        </div>
        <div class="upload-reviewers">
          <div class="upload-reviewers-header">
            <span class="field-label">Reviewers ({uploadReviewers.length})</span>
            <button class="btn btn-xs" onclick={addUploadReviewer}><IconPlus size={11} /> Add reviewer</button>
          </div>
          {#each uploadReviewers as r, i (i)}
            <div class="upload-reviewer-row">
              <div class="upload-reviewer-head">
                <input class="input upload-reviewer-name" type="text" value={r.name} oninput={(e) => updateUploadReviewer(i, "name", e.currentTarget.value)} placeholder="model-id" />
                {#if uploadReviewers.length > 1}
                  <button class="icon-btn" onclick={() => removeUploadReviewer(i)} title="Remove" aria-label="Remove reviewer"><IconTrash size={13} /></button>
                {/if}
              </div>
              <textarea
                class="upload-reviewer-text"
                placeholder="Paste this reviewer's raw output here…"
                value={r.text}
                oninput={(e) => updateUploadReviewer(i, "text", e.currentTarget.value)}
              ></textarea>
            </div>
          {/each}
        </div>
      </div>
      <footer class="modal-footer">
        <button class="btn" onclick={() => (uploadMode = false)}>Cancel</button>
        <button class="btn btn-primary" onclick={runAggregateOnly} disabled={(!uploadConfigId && !uploadPresetId) || !workspaceRoot || running}>
          <IconPlayerPlay size={13} /> Run Judge Only
        </button>
      </footer>
    </div>
  </div>
{/if}

<!-- Raw output modal — reviewer texts + judge JSON, for debugging -->
{#if rawResult}
  {@const rawOutputs = buildRawOutputs(rawResult)}
  {@const selectedOutput = rawOutputs.find((o) => o.key === rawSelectedKey) ?? rawOutputs[0] ?? null}
  <div class="modal-backdrop" transition:fade={{ duration: 200 }} onclick={() => (rawResult = null)} onkeydown={(e) => { if (e.key === "Escape") rawResult = null; }} role="presentation">
    <div class="modal modal-raw" transition:fly={{ y: 30, duration: 400, easing: cubicInOut }} onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
      <header class="modal-header">
        <span class="modal-title">
          Raw Output — {rawResult.configName}
          <span class="raw-modal-date">{fmtDate(rawResult.startedAt)}</span>
        </span>
        <button class="modal-close" onclick={() => (rawResult = null)} aria-label="Close"><IconX size={16} /></button>
      </header>
      <div class="modal-body">
        {#if rawResult.source === "upload"}
          <div class="raw-hint">
            <IconUpload size={13} />
            This run judged a pasted analysis — the sections below show exactly what was pasted.
          </div>
        {/if}

        <!-- Top: Generation Audit — sortable table with timestamp -->
        {#if rawResult.generationMetadata && Object.keys(rawResult.generationMetadata).length > 0}
          {@const genMeta = rawResult.generationMetadata}
          {@const genEntries = sortGenEntries(Object.entries(genMeta), genSortKey, genSortDir)}
          <details class="raw-section" open={genAuditOpen} ontoggle={(e) => { if (e.currentTarget.open && !genAuditOpen) { genAuditOpen = true; rawOutputOpen = false; } else if (!e.currentTarget.open && genAuditOpen) { genAuditOpen = false; } }}>
            <summary>
              <IconChevronRight size={12} />
              <span class="raw-section-title">Generation Audit · OpenRouter</span>
              <span class="raw-section-len">{genEntries.length} generations</span>
            </summary>
            <div class="gen-audit-table">
              <table>
                <thead>
                  <tr>
                    <th class="sortable" onclick={() => setGenSort("time")}>
                      Time {#if genSortKey === "time"}<span class="sort-arrow">{genSortDir === "asc" ? "▲" : "▼"}</span>{/if}
                    </th>
                    <th class="sortable" onclick={() => setGenSort("role")}>
                      Role {#if genSortKey === "role"}<span class="sort-arrow">{genSortDir === "asc" ? "▲" : "▼"}</span>{/if}
                    </th>
                    <th class="sortable" onclick={() => setGenSort("requested")}>
                      Requested {#if genSortKey === "requested"}<span class="sort-arrow">{genSortDir === "asc" ? "▲" : "▼"}</span>{/if}
                    </th>
                    <th class="sortable" onclick={() => setGenSort("actual")}>
                      Actual Model {#if genSortKey === "actual"}<span class="sort-arrow">{genSortDir === "asc" ? "▲" : "▼"}</span>{/if}
                    </th>
                    <th class="sortable" onclick={() => setGenSort("provider")}>
                      Provider {#if genSortKey === "provider"}<span class="sort-arrow">{genSortDir === "asc" ? "▲" : "▼"}</span>{/if}
                    </th>
                    <th class="num sortable" onclick={() => setGenSort("inTok")}>
                      In tok {#if genSortKey === "inTok"}<span class="sort-arrow">{genSortDir === "asc" ? "▲" : "▼"}</span>{/if}
                    </th>
                    <th class="num sortable" onclick={() => setGenSort("outTok")}>
                      Out tok {#if genSortKey === "outTok"}<span class="sort-arrow">{genSortDir === "asc" ? "▲" : "▼"}</span>{/if}
                    </th>
                    <th class="num sortable" onclick={() => setGenSort("cost")}>
                      Cost {#if genSortKey === "cost"}<span class="sort-arrow">{genSortDir === "asc" ? "▲" : "▼"}</span>{/if}
                    </th>
                    <th class="sortable" onclick={() => setGenSort("finish")}>
                      Finish {#if genSortKey === "finish"}<span class="sort-arrow">{genSortDir === "asc" ? "▲" : "▼"}</span>{/if}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {#each genEntries as [key, meta] (key)}
                    {@const parsed = parseGenerationKey(key, rawResult.aggregatorModel)}
                    {@const mismatch = isRealFailover(parsed.requestedModel, meta.model)}
                    <tr>
                      <td class="mono">{fmtTime(meta.createdAt)}</td>
                      <td>{parsed.role === "aggregator" ? "Judge" : "Reviewer"}</td>
                      <td class="mono">{modelLabel(parsed.requestedModel)}</td>
                      <td class="mono {mismatch ? 'mismatch' : ''}">{modelLabel(meta.model)}{#if mismatch} <span class="failover-badge">failover</span>{/if}</td>
                      <td>{meta.providerName ?? "—"}</td>
                      <td class="num">{meta.tokensPrompt.toLocaleString()}</td>
                      <td class="num">{meta.tokensCompletion.toLocaleString()}</td>
                      <td class="num {meta.totalCost > 0 ? 'paid' : 'free'}">{meta.totalCost > 0 ? `$${meta.totalCost.toFixed(5)}` : "free"}</td>
                      <td>{meta.finishReason ?? "—"}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </details>
        {/if}

        <!-- Bottom: reviewer/judge picker + raw output — one merged card -->
        <div class="raw-output-card">
          {#if rawOutputs.length > 0}
            <div class="raw-output-picker">
              <select class="task-filter-select raw-output-select" value={selectedOutput?.key ?? ""} onchange={(e) => (rawSelectedKey = e.currentTarget.value)}>
                {#each rawOutputs as o (o.key)}
                  <option value={o.key}>{o.label} · {o.text.length.toLocaleString()} chars</option>
                {/each}
              </select>
            </div>
          {/if}
          <details open={rawOutputOpen} ontoggle={(e) => { if (e.currentTarget.open && !rawOutputOpen) { rawOutputOpen = true; genAuditOpen = false; } else if (!e.currentTarget.open && rawOutputOpen) { rawOutputOpen = false; } }}>
            <summary>
              <IconChevronRight size={12} />
              <span class="raw-section-title">Raw Output</span>
              {#if selectedOutput}<span class="raw-section-len">{selectedOutput.text.length.toLocaleString()} chars</span>{/if}
            </summary>
            {#if rawOutputs.length > 0}
              {#if selectedOutput}
                {#if selectedOutput.text}
                  <pre class="raw-pre">{selectedOutput.text}</pre>
                {:else}
                  <div class="raw-empty" style="color: var(--color-error);">No output — this reviewer returned an empty response. It may have hit a context limit, rate limit, or the model may not support the prompt format.</div>
                {/if}
              {/if}
            {:else}
              <div class="raw-empty">No reviewer or judge output was captured for this run.</div>
            {/if}
          </details>
        </div>
      </div>
      <footer class="modal-footer">
        <div class="flex items-center gap-2">
          <button class="btn btn-sm" onclick={refreshGenerationMetadata} disabled={genRefreshing || !rawResult?.generationIds} title="Fetch actual model, provider, tokens, and cost from OpenRouter">
            <IconRefresh size={13} class={genRefreshing ? 'spin' : ''} /> {genRefreshing ? 'Fetching…' : 'Refresh from OpenRouter'}
          </button>
          <button class="btn btn-sm btn-primary" onclick={rerunJudgeForRawResult} disabled={running} title="Rerun only the judge / aggregator using the reviewer outputs from this run">
            <IconPlayerPlay size={13} /> Rerun Judge
          </button>
        </div>
        <div class="flex items-center gap-2">
          <button class="btn btn-sm" onclick={dumpRawToMarkdown} disabled={!rawResult?.rawOutputs && !rawResult?.aggregatorOutput}>
            <IconDownload size={13} /> Dump to MD
          </button>
          <button class="btn btn-sm" onclick={() => (rawResult = null)}>Close</button>
        </div>
      </footer>
    </div>
  </div>
{/if}

<!-- Task detail modal (Work to Do tab) — GitHub issue preview -->
{#if detailTask}
  <div class="modal-backdrop" transition:fade={{ duration: 200 }} onclick={() => (detailTask = null)} onkeydown={(e) => { if (e.key === "Escape") detailTask = null; }} role="presentation">
    <div class="modal modal-wide" transition:fly={{ y: 30, duration: 400, easing: cubicInOut }} onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
      <header class="modal-header">
        <span class="modal-title">
          <span class="task-prio {detailTask.priority.toLowerCase()}">{#if detailTask.priority === "P0"}<IconFlame size={14} /> {:else if detailTask.priority === "P1"}<IconAlertTriangle size={14} /> {:else if detailTask.priority === "P2"}<IconCircleDot size={14} /> {:else}<IconCircleCheck size={14} />{/if} {detailTask.priority}</span>
          {detailTask.issue}
        </span>
        <button class="modal-close" onclick={() => (detailTask = null)} aria-label="Close"><IconX size={16} /></button>
      </header>
      <div class="modal-body">
        <!-- Issue preview header — like a GitHub issue -->
        <div class="issue-preview-header">
          <div class="issue-preview-title">
            <IconBrandGithub size={16} />
            <span>{detailTask.issue}</span>
            {#if detailTask.githubUrl}
              <a href={detailTask.githubUrl} target="_blank" rel="noopener" class="issue-preview-link">#{detailTask.githubUrl.match(/issues\/(\d+)/)?.[1] ?? "link"}</a>
            {/if}
          </div>
          <div class="issue-preview-labels">
            <span class="issue-label priority-{detailTask.priority.toLowerCase()}">{detailTask.priority}</span>
            {#if detailTask.type}
              <span class="issue-label type-label">{detailTask.type}</span>
            {/if}
            {#if detailTask.confidence}
              <span class="issue-label confidence-label">{detailTask.confidence} confidence</span>
            {/if}
            {#each detailTask.lenses as lens (lens)}
              <span class="issue-label lens-label">{lensEmoji(lens)} {lensLabel(lens, detailTask.configId)}</span>
            {/each}
            {#each detailTask.labels as lbl (lbl)}
              {#if !lbl.startsWith("priority:") && !lbl.startsWith("lens:") && !lbl.startsWith("type:") && !lbl.startsWith("confidence:")}
                <span class="issue-label">{lbl}</span>
              {/if}
            {/each}
          </div>
        </div>

        <!-- Issue body — the main content, rendered as markdown -->
        {#if detailTask.issueBody}
          <div class="issue-preview-body">
            {@html renderMarkdown(detailTask.issueBody)}
          </div>
        {:else}
          <!-- Fallback: build a body from the structured fields -->
          <div class="issue-preview-body">
            <h2>Summary</h2>
            <p>{detailTask.mainFinding || detailTask.issue}</p>
            <h2>Current behavior</h2>
            <p>The code currently exhibits: {detailTask.mainFinding || detailTask.issue}.</p>
            <p>Impact: {detailTask.impact || "—"}</p>
            <h2>Expected behavior</h2>
            <p>After the fix: {detailTask.fix || "—"}</p>
            <h2>Affected code</h2>
            <p><strong>Lens(es):</strong> {detailTask.lenses.map((l: string) => `${lensEmoji(l)} ${lensLabel(l, detailTask.configId)}`).join(", ") || "—"}</p>
            <p><strong>Reviewer(s):</strong> {detailTask.reviewers.map((r: string) => reviewerPopover(r, detailTask.reviewerModels)).join(", ") || "—"}</p>
            <h2>Acceptance criteria</h2>
            <ul>
              <li>- [ ] The issue described in the Summary is resolved</li>
              <li>- [ ] No new regressions introduced</li>
              <li>- [ ] Tests pass and cover the fix</li>
            </ul>
            <h2>References</h2>
            <ul>
              <li><strong>Lenses:</strong> {detailTask.lenses.map((l: string) => `${lensEmoji(l)} ${lensLabel(l, detailTask.configId)}`).join(", ") || "—"}</li>
              <li><strong>Reviewers:</strong> {detailTask.reviewers.map((r: string) => reviewerPopover(r, detailTask.reviewerModels)).join(", ") || "—"}</li>
              <li><strong>Priority:</strong> {detailTask.priority}</li>
            </ul>
          </div>
        {/if}

        <!-- Meta sidebar -->
        <div class="issue-preview-meta">
          <div class="meta-row">
            <span class="meta-key">Reviewers</span>
            <span class="meta-val">
              {detailTask.reviewers.map((r: string) => reviewerPopover(r, detailTask.reviewerModels)).join(", ") || "—"}
            </span>
          </div>
          <div class="meta-row">
            <span class="meta-key">Config</span>
            <span class="meta-val">{detailTask.configName}</span>
          </div>
          <div class="meta-row">
            <span class="meta-key">Date</span>
            <span class="meta-val">{fmtDate(detailTask.reviewDate || detailTask.lastSeenAt)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-key">Status</span>
            <span class="meta-val">{detailTask.resolved ? "resolved" : "open"}</span>
          </div>
        </div>
      </div>
      <footer class="modal-footer">
        {#if detailTask.githubUrl}
          <a href={detailTask.githubUrl} target="_blank" rel="noopener" class="btn btn-sm">
            <IconBrandGithub size={13} /> View on GitHub
          </a>
        {:else}
          <button class="btn btn-sm btn-primary" onclick={createIssueFromDetail} disabled={creatingIssueIdx !== null}>
            {#if creatingIssueIdx !== null}Creating…{:else}<IconBrandGithub size={13} /> Create GitHub issue{/if}
          </button>
        {/if}
        <button class="btn btn-sm" onclick={() => (detailTask = null)}>Close</button>
      </footer>
    </div>
  </div>
{/if}

<!-- Config editor modal -->
{#if editing}
  <div class="modal-backdrop" transition:fade={{ duration: 200 }} onclick={() => (editing = null)} onkeydown={(e) => { if (e.key === "Escape") editing = null; }} role="presentation">
    <div class="modal" transition:fly={{ y: 30, duration: 400, easing: cubicInOut }} onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
      <header class="modal-header">
        <span class="modal-title">{editing.id ? "Edit Review" : "New Review"}</span>
        <button class="modal-close" onclick={() => (editing = null)} aria-label="Close"><IconX size={16} /></button>
      </header>
      <div class="modal-body">
        <label class="field">
          <span class="field-label">Name</span>
          <input class="input" bind:value={editing.name} placeholder="Trading Bot Review" />
        </label>

        <!-- Expertise level -->
        <div class="field">
          <span class="field-label">Expertise level</span>
          <div class="expertise-selector">
            {#each ["top-0.1%", "top-1%", "top-10%", "top-25%"] as lvl (lvl)}
              <button
                class="expertise-btn"
                class:selected={editing.expertise === lvl}
                onclick={() => { editing!.expertise = lvl as ExpertiseLevel; }}
              >
                {lvl}
              </button>
            {/each}
          </div>
        </div>

        <!-- Model tier -->
        <div class="field">
          <span class="field-label">Model tier</span>
          <div class="tier-selector">
            {#each TIER_OPTIONS as opt (opt.id)}
              <button
                class="tier-btn"
                class:selected={editing.modelTier === opt.id}
                onclick={() => { editing!.modelTier = opt.id; editing!.reviewerModels = []; modelSearch = ""; }}
              >
                <opt.icon size={15} />
                <span class="tier-btn-label">{opt.label}</span>
                <small>{opt.desc}</small>
              </button>
            {/each}
          </div>
        </div>

        <!-- Reviewer models -->
        <div class="field">
          <span class="field-label">
            Reviewer models ({editing.reviewerModels.length})
            <small class="field-hint">— empty = auto-pick from tier</small>
          </span>
          {#if availableModels.length > 0}
            <div class="model-search-row">
              <input
                class="input model-search-input"
                type="search"
                bind:value={modelSearch}
                placeholder={`Search ${availableModels.length} models…`}
                aria-label="Search reviewer models"
              />
              {#if popularity.size > 0}
                <div class="model-sort-toggle">
                  <button class="model-sort-btn" class:selected={modelSort === "popular"} onclick={() => (modelSort = "popular")} title="Sort by OpenRouter popularity (7-day token usage)">
                    Popular
                  </button>
                  <button class="model-sort-btn" class:selected={modelSort === "all"} onclick={() => (modelSort = "all")} title="Catalog order">
                    All
                  </button>
                </div>
              {/if}
              {#if modelSearch}
                <span class="model-search-count">{filteredModels.length} match{filteredModels.length === 1 ? "" : "es"}</span>
              {/if}
            </div>
            {#if filteredModels.length > 0}
              <div class="model-picker">
                {#each filteredModels as m (m.id)}
                  {@const pop = modelPopularity(m.id)}
                  <button
                    class="model-chip"
                    class:selected={editing.reviewerModels.includes(m.id)}
                    class:popular={pop != null}
                    onclick={() => toggleReviewerModel(m.id)}
                    title={m.id}
                  >
                    {m.name}
                    {#if m.paramSize && m.paramSize !== "unknown"}<span class="model-param-badge">{m.paramSize}</span>{/if}
                    {#if pop != null && pop > 0}
                      <span class="model-pop-badge" title="{fmtPopularity(pop)} tokens used on OpenRouter in the last 7 days">{fmtPopularity(pop)}</span>
                    {/if}
                  </button>
                {/each}
              </div>
            {:else}
              <div class="field-muted">No models match "{modelSearch}".</div>
            {/if}
          {:else}
            <div class="field-muted">Loading models…</div>
          {/if}
        </div>

        <!-- Aggregator -->
        <label class="field">
          <span class="field-label">Aggregator / Judge <small class="field-hint">— empty / "auto" = pick from same tier as reviewers (free→openrouter/free, paid→openrouter/auto)</small></span>
          <AggregatorModelPicker
            value={editing.aggregatorModel}
            {freeModels}
            {paidModels}
            {localModels}
            onSelect={(id) => { if (editing) editing.aggregatorModel = id; }}
          />
        </label>

        <!-- Per-request timeout -->
        <div class="field">
          <span class="field-label">Per-request timeout <small class="field-hint">— hard deadline per LLM call (reviewers + judge)</small></span>
          <div class="schedule-row">
            <input
              type="number"
              min="0"
              step="1"
              value={timeoutMinutes}
              oninput={(e) => { timeoutMinutes = +(e.currentTarget as HTMLInputElement).value; onTimeoutInput(); }}
              class="input schedule-num"
              placeholder="5"
            />
            <span class="schedule-unit" style="font-size: 0.75rem; color: var(--color-muted);">minutes</span>
            <span class="schedule-hint">0 = provider default (3 min)</span>
          </div>
        </div>

        <!-- Schedule -->
        <div class="field">
          <span class="field-label">Schedule</span>
          <div class="schedule-row">
            <input type="number" min="0" step="1" bind:value={editing.intervalValue} class="input schedule-num" />
            <select bind:value={editing.intervalUnit} class="input schedule-unit">
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
            </select>
            <span class="schedule-hint">0 = manual only</span>
          </div>
        </div>

        <div class="field-row">
          <label class="field">
            <span class="field-label">Target path (optional)</span>
            <input class="input" bind:value={editing.targetPath} placeholder="src/" />
          </label>
          <label class="field">
            <span class="field-label">Workspace root</span>
            <input class="input" bind:value={editing.workspaceRoot} placeholder={workspaceRoot ?? "/path/to/project"} />
          </label>
        </div>

        <!-- Toggles -->
        <div class="toggle-list">
          <div class="toggle-row">
            <div>
              <div class="toggle-title">Scheduled</div>
              <div class="toggle-desc">Run automatically every interval when the background scheduler is on.</div>
            </div>
            <button
              class="toggle {editing.enabled ? "on" : ""}"
              onclick={() => { editing!.enabled = !editing!.enabled; }}
              role="switch"
              aria-checked={editing.enabled}
              aria-label="Toggle scheduled"
            >
              <span class="toggle-knob"></span>
            </button>
          </div>
          <div class="toggle-row">
            <div>
              <div class="toggle-title">Write TASKS.md</div>
              <div class="toggle-desc">Export the living task list to TASKS.md in the workspace root after each run.</div>
            </div>
            <button
              class="toggle {editing.writeTasksFile ? "on" : ""}"
              onclick={() => { editing!.writeTasksFile = !editing!.writeTasksFile; }}
              role="switch"
              aria-checked={editing.writeTasksFile}
              aria-label="Toggle TASKS.md export"
            >
              <span class="toggle-knob"></span>
            </button>
          </div>
          <div class="toggle-row">
            <div>
              <div class="toggle-title">Auto-create GitHub issues</div>
              <div class="toggle-desc">File P0/P1 findings as GitHub issues (uses the gh CLI). Never re-files an issue that already has a URL.</div>
            </div>
            <button
              class="toggle {editing.createGitHubIssues ? "on" : ""}"
              onclick={() => { editing!.createGitHubIssues = !editing!.createGitHubIssues; }}
              role="switch"
              aria-checked={editing.createGitHubIssues}
              aria-label="Toggle GitHub issue creation"
            >
              <span class="toggle-knob"></span>
            </button>
          </div>
        </div>

        <!-- Lenses -->
        <div class="lenses-section">
          <div class="lenses-header">
            <span class="field-label">Lenses ({editing.lenses.length})</span>
            <button class="btn btn-xs" onclick={addLens}><IconPlus size={12} /> Add lens</button>
          </div>
          {#each editing.lenses as lens, i (i)}
            <div class="lens-row">
              <input class="input lens-emoji" bind:value={lens.emoji} maxlength={4} />
              <input class="input lens-code" bind:value={lens.code} placeholder="CODE" maxlength={8} title="Short code used to match tasks to this lens (e.g. STAT). Empty = derived from the label." />
              <input class="input lens-label" bind:value={lens.label} placeholder="Label (e.g. Statistician)" />
              <button class="icon-btn lens-delete" onclick={() => removeLens(i)} aria-label="Remove lens"><IconTrash size={12} /></button>
            </div>
          {/each}
        </div>
      </div>
      <footer class="modal-footer">
        <button class="btn btn-sm" onclick={() => (editing = null)}>Cancel</button>
        <div class="footer-right">
          <button class="btn btn-sm" onclick={runFromEditor} disabled={running || !workspaceRoot}>
            <IconPlayerPlay size={13} /> Run now
          </button>
          <button class="btn btn-sm btn-primary" onclick={saveConfig}><IconCheck size={13} /> Save</button>
        </div>
      </footer>
    </div>
  </div>
{/if}

<!-- Start Fresh modal — selectively wipe monitoring data -->
{#if showStartFresh}
  <div
    class="delete-confirm-overlay"
    onclick={() => !startFreshBusy && (showStartFresh = false)}
    onkeydown={(e) => { if (e.key === "Escape" && !startFreshBusy) showStartFresh = false; }}
    role="button"
    tabindex="-1"
    aria-label="Cancel start fresh"
  >
    <div
      class="delete-confirm-dialog start-fresh-dialog"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Start fresh"
      aria-modal="true"
      tabindex="-1"
    >
      <div class="flex items-center gap-2 mb-3">
        <IconTrash size={18} class="flex-shrink-0" style="color: var(--color-error);" />
        <span class="font-bold text-sm">Start fresh?</span>
      </div>
      <p class="text-xs opacity-70 mb-4">
        Selectively erase monitoring data. This cannot be undone. Any in-flight runs will be cancelled.
      </p>
      <div class="start-fresh-options">
        <label class="start-fresh-option">
          <input type="checkbox" bind:checked={startFreshOpts.configs} disabled={startFreshBusy} />
          <div class="start-fresh-option-text">
            <div class="start-fresh-option-label">Configs</div>
            <div class="start-fresh-option-desc">{configs.length} config{configs.length === 1 ? "" : "s"} — review definitions, lenses, schedules</div>
          </div>
        </label>
        <label class="start-fresh-option">
          <input type="checkbox" bind:checked={startFreshOpts.results} disabled={startFreshBusy} />
          <div class="start-fresh-option-text">
            <div class="start-fresh-option-label">Reviews</div>
            <div class="start-fresh-option-desc">{results.length} run{results.length === 1 ? "" : "s"} — run history, raw outputs, costs</div>
          </div>
        </label>
        <label class="start-fresh-option">
          <input type="checkbox" bind:checked={startFreshOpts.taskLists} disabled={startFreshBusy} />
          <div class="start-fresh-option-text">
            <div class="start-fresh-option-label">Tasks</div>
            <div class="start-fresh-option-desc">Living task lists — all tasks across all configs (any status)</div>
          </div>
        </label>
      </div>
      <div class="flex items-center justify-end gap-2 mt-4">
        <button class="btn text-xs px-3 py-1.5" onclick={() => (showStartFresh = false)} disabled={startFreshBusy}>Cancel</button>
        <button
          class="btn-danger text-xs px-3 py-1.5"
          onclick={startFresh}
          disabled={startFreshBusy || (!startFreshOpts.configs && !startFreshOpts.results && !startFreshOpts.taskLists)}
        >
          {#if startFreshBusy}Erasing…{:else}Erase selected{/if}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Delete confirmation — matches the global delete-confirm pattern -->
{#if deletingId}
  <div
    class="delete-confirm-overlay"
    onclick={() => (deletingId = null)}
    onkeydown={(e) => { if (e.key === "Escape") deletingId = null; }}
    role="button"
    tabindex="-1"
    aria-label="Cancel delete"
  >
    <div
      class="delete-confirm-dialog"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Confirm delete"
      aria-modal="true"
      tabindex="-1"
    >
      <div class="flex items-center gap-2 mb-3">
        <IconTrash size={18} class="flex-shrink-0" style="color: var(--color-error);" />
        <span class="font-bold text-sm">Delete this review config?</span>
      </div>
      <p class="text-xs opacity-70 mb-4">Its living task list is deleted too. Run history is kept.</p>
      <div class="flex items-center justify-end gap-2">
        <button class="btn text-xs px-3 py-1.5" onclick={() => (deletingId = null)}>Cancel</button>
        <button class="btn-danger text-xs px-3 py-1.5" onclick={confirmDelete}>Delete</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Mode container — matches editor/agent mode shells. */
  /* Monitor view tabs */
  .monitor-tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.3rem 0;
    flex-shrink: 0;
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--color-surface, rgba(var(--surface-rgb), 0.95));
    backdrop-filter: blur(8px);
  }
  .monitor-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.7rem;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-muted);
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    font-family: var(--font-mono, monospace);
  }
  .monitor-tab:hover { border-color: var(--color-border-accent); color: var(--color-text); }
  .monitor-tab.active {
    border-color: var(--color-accent);
    background: rgba(var(--accent-rgb), 0.12);
    color: var(--color-accent);
    box-shadow: 0 0 8px rgba(var(--accent-rgb), 0.15);
  }
  .empty-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .task-config-cell { font-size: 0.6875rem; color: var(--color-muted); white-space: nowrap; }
  .task-table .col-config { width: 7rem; white-space: nowrap; }
  .task-table .col-finding { min-width: 12rem; max-width: 20rem; }
  .task-table .col-fix { min-width: 10rem; max-width: 18rem; }
  .task-table .col-judge { width: 7rem; white-space: nowrap; }
  .task-table .col-tasks { white-space: nowrap; }
  .task-table .col-cost { width: 4rem; white-space: nowrap; }
  .task-table .col-trigger { width: 5rem; white-space: nowrap; }
  .task-table .col-date { width: 6rem; white-space: nowrap; }
  .task-table .col-reviewers { min-width: 7rem; max-width: 12rem; }
  .task-finding-cell, .task-fix-cell {
    font-size: 0.6875rem;
    color: var(--color-text);
    opacity: 0.75;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  /* Work to Do table: full content, no truncation */
  .work-table-wrap { overflow-x: auto; }
  .work-table { table-layout: auto; }
  .work-table .col-prio { width: 4rem; white-space: nowrap; }
  .work-table .col-issue { min-width: 8rem; max-width: 14rem; }
  .work-table .col-finding { min-width: 14rem; max-width: 22rem; }
  .work-table .col-fix { min-width: 12rem; max-width: 20rem; }
  .work-table .col-impact { min-width: 10rem; max-width: 16rem; }
  .work-table .col-lenses { min-width: 8rem; max-width: 14rem; }
  .work-table .col-reviewers { min-width: 7rem; max-width: 12rem; }
  .work-table .col-gh { width: 5rem; white-space: nowrap; }
  .task-full-cell {
    font-size: 0.6875rem;
    color: var(--color-text);
    opacity: 0.85;
    line-height: 1.5;
    white-space: normal;
    word-break: break-word;
  }
  .gh-none { color: var(--color-muted); opacity: 0.4; }
  .gh-badge { display: inline-flex; align-items: center; gap: 0.2rem; font-size: 0.625rem; color: var(--color-success); }
  /* Task detail modal — GitHub issue preview */
  .issue-preview-header {
    padding-bottom: 0.6rem;
    border-bottom: 1px solid rgba(var(--border-rgb), 0.3);
    margin-bottom: 0.6rem;
  }
  .issue-preview-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    font-weight: 700;
    color: var(--color-text);
    margin-bottom: 0.4rem;
  }
  .issue-preview-link {
    font-size: 0.6875rem;
    color: var(--color-muted);
    text-decoration: none;
    font-weight: 400;
  }
  .issue-preview-link:hover { color: var(--color-accent); }
  .issue-preview-labels {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .issue-label {
    display: inline-block;
    padding: 0.1rem 0.4rem;
    border-radius: 12px;
    font-size: 0.625rem;
    font-weight: 600;
    background: rgba(var(--muted-rgb), 0.2);
    color: var(--color-muted);
  }
  .issue-label.priority-p0 { background: rgba(var(--error-rgb), 0.2); color: var(--color-error); }
  .issue-label.priority-p1 { background: rgba(var(--warning-rgb), 0.2); color: var(--color-warning); }
  .issue-label.priority-p2 { background: rgba(var(--accent-rgb), 0.15); color: var(--color-accent); }
  .issue-label.priority-p3 { background: rgba(var(--muted-rgb), 0.2); color: var(--color-muted); }
  .issue-label.lens-label { background: rgba(var(--accent-2-rgb), 0.15); color: var(--color-accent-2); }
  .issue-label.type-label { background: rgba(var(--error-rgb), 0.12); color: var(--color-error); }
  .issue-label.confidence-label { background: rgba(var(--muted-rgb), 0.15); color: var(--color-muted); }
  .issue-preview-body {
    font-size: 0.75rem;
    line-height: 1.7;
    color: var(--color-text);
    max-height: 400px;
    overflow-y: auto;
    padding: 0.6rem;
    border-radius: 8px;
    background: rgba(var(--surface-1-rgb), 0.3);
    border: 1px solid rgba(var(--border-rgb), 0.2);
  }
  .issue-preview-body h1, .issue-preview-body h2, .issue-preview-body h3 {
    font-size: 0.8rem;
    font-weight: 700;
    margin: 0.6rem 0 0.3rem 0;
    color: var(--color-text);
  }
  .issue-preview-body h1:first-child, .issue-preview-body h2:first-child { margin-top: 0; }
  .issue-preview-body p { margin: 0.3rem 0; }
  .issue-preview-body ul, .issue-preview-body ol { margin: 0.3rem 0; padding-left: 1.2rem; }
  .issue-preview-body li { margin: 0.15rem 0; }
  .issue-preview-body code {
    font-family: var(--font-mono, monospace);
    font-size: 0.6875rem;
    background: rgba(var(--surface-2-rgb), 0.4);
    padding: 0.1rem 0.3rem;
    border-radius: 4px;
  }
  .issue-preview-body pre {
    background: rgba(var(--surface-2-rgb), 0.4);
    padding: 0.5rem;
    border-radius: 6px;
    overflow-x: auto;
    margin: 0.4rem 0;
  }
  .issue-preview-body pre code { background: transparent; padding: 0; }
  .issue-preview-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.8rem;
    padding-top: 0.6rem;
    margin-top: 0.6rem;
    border-top: 1px solid rgba(var(--border-rgb), 0.3);
  }
  .meta-row { display: flex; flex-direction: column; gap: 0.1rem; }
  .meta-key { font-size: 0.625rem; text-transform: uppercase; color: var(--color-muted); font-weight: 600; }
  .meta-val { font-size: 0.6875rem; color: var(--color-text); opacity: 0.85; }
  .task-count-cell { display: flex; gap: 0.2rem; flex-wrap: wrap; }
  .status-tag.running { color: var(--color-accent); background: rgba(var(--accent-rgb), 0.1); }
  .status-tag.error { color: var(--color-error); background: rgba(var(--error-rgb), 0.1); }
  .status-tag.interrupted { color: var(--color-warning); background: rgba(var(--warning-rgb), 0.1); }
  .status-tag.cancelled { color: var(--color-muted); background: rgba(var(--muted-rgb), 0.1); }
  .icon-btn.resume-btn { color: var(--color-warning); border-color: rgba(var(--warning-rgb), 0.35); }
  .icon-btn.resume-btn:hover:not(:disabled) { background: rgba(var(--warning-rgb), 0.12); }
  .task-row.selected { background: rgba(var(--accent-rgb), 0.08); }
  .task-row.selected:hover { background: rgba(var(--accent-rgb), 0.12); }

  /* Upload analysis modal */
  .modal-wide { max-width: 800px; }
  /* Start Fresh modal */
  .start-fresh-dialog { max-width: 420px; }
  .start-fresh-options { display: flex; flex-direction: column; gap: 0.5rem; }
  .start-fresh-option {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem 0.6rem;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.3);
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .start-fresh-option:hover { border-color: var(--color-border-accent); }
  .start-fresh-option input[type="checkbox"] {
    margin-top: 0.15rem;
    accent-color: var(--color-error);
    cursor: pointer;
    flex-shrink: 0;
  }
  .start-fresh-option-text { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
  .start-fresh-option-label { font-size: 0.75rem; font-weight: 700; color: var(--color-text); }
  .start-fresh-option-desc { font-size: 0.625rem; color: var(--color-muted); line-height: 1.4; }
  .upload-intro {
    font-size: 0.75rem;
    color: var(--color-muted);
    line-height: 1.6;
    margin-bottom: 0.8rem;
  }
  .upload-bulk { margin-bottom: 0.8rem; }
  .upload-config-select {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-bottom: 0.8rem;
  }
  .upload-config-select .task-filter-select { max-width: 20rem; }
  .upload-source-tabs { display: flex; gap: 0.25rem; }
  .upload-tab {
    padding: 0.2rem 0.55rem;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-muted);
    font-size: 0.6875rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    font-family: var(--font-mono, monospace);
  }
  .upload-tab:hover { border-color: var(--color-border-accent); color: var(--color-text); }
  .upload-tab.active {
    border-color: var(--color-accent);
    background: rgba(var(--accent-rgb), 0.12);
    color: var(--color-accent);
  }
  .upload-bulk-input {
    width: 100%;
    min-height: 80px;
    max-height: 150px;
    padding: 0.4rem 0.5rem;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.5);
    color: var(--color-text);
    font-size: 0.6875rem;
    font-family: var(--font-mono, monospace);
    resize: vertical;
  }
  .upload-bulk-input:focus { outline: none; border-color: var(--color-accent); }
  .upload-reviewers { display: flex; flex-direction: column; gap: 0.5rem; }
  .upload-reviewers-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.2rem;
  }
  .upload-reviewer-row {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 0.4rem;
    background: rgba(var(--surface-1-rgb), 0.3);
  }
  .upload-reviewer-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.3rem;
  }
  .upload-reviewer-name { flex: 1; font-size: 0.6875rem; }
  .upload-reviewer-text {
    width: 100%;
    min-height: 120px;
    max-height: 300px;
    padding: 0.4rem 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: rgba(var(--bg-deep-rgb), 0.3);
    color: var(--color-text);
    font-size: 0.6875rem;
    font-family: var(--font-mono, monospace);
    resize: vertical;
  }
  .upload-reviewer-text:focus { outline: none; border-color: var(--color-accent); }

  /* Raw output modal */
  .modal-raw {
    width: 960px;
    max-width: 96vw;
    height: 90vh;
    max-height: 90vh;
  }
  .modal-raw .modal-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .raw-modal-date {
    font-size: 0.6875rem;
    font-weight: 400;
    color: var(--color-muted);
    margin-left: 0.4rem;
  }
  .raw-hint {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.6875rem;
    color: var(--color-accent);
    background: rgba(var(--accent-rgb), 0.08);
    border: 1px solid rgba(var(--accent-rgb), 0.2);
    border-radius: 8px;
    padding: 0.4rem 0.6rem;
    margin-bottom: 0.6rem;
    line-height: 1.5;
  }
  .raw-section {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    margin-bottom: 0.5rem;
    background: rgba(var(--surface-1-rgb), 0.3);
    overflow: hidden;
    flex-shrink: 0;
  }
  .raw-section summary {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.6rem;
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text);
    list-style: none;
  }
  .raw-section summary::-webkit-details-marker { display: none; }
  .raw-section summary :global(svg:first-child) { color: var(--color-muted); transition: transform 0.2s; flex-shrink: 0; }
  .raw-section[open] summary :global(svg:first-child) { transform: rotate(90deg); }
  .raw-section-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .raw-section-len {
    margin-left: auto;
    font-size: 0.625rem;
    color: var(--color-muted);
    font-weight: 400;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .raw-pre {
    margin: 0;
    padding: 0.75rem;
    font-family: var(--font-mono, monospace);
    font-size: 0.6875rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--color-text);
    opacity: 0.9;
    border-top: 1px solid rgba(var(--border-rgb), 0.2);
    background: rgba(var(--bg-deep-rgb), 0.35);
  }
  .raw-empty {
    padding: 0.5rem 0.6rem;
    font-size: 0.6875rem;
    color: var(--color-muted);
    border-top: 1px solid rgba(var(--border-rgb), 0.2);
  }

  /* Generation audit table */
  .gen-audit-table { overflow-x: auto; }
  .gen-audit-table table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.6875rem;
  }
  .gen-audit-table th {
    background: rgba(var(--bg-deep-rgb), 0.5);
    border: 1px solid var(--color-border);
    padding: 0.35rem 0.4rem;
    text-align: left;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-size: 0.625rem;
    color: var(--color-muted);
    white-space: nowrap;
  }
  .gen-audit-table td {
    border: 1px solid var(--color-border);
    padding: 0.3rem 0.4rem;
    white-space: nowrap;
  }
  .gen-audit-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .gen-audit-table td.mono { font-family: var(--font-mono, "JetBrains Mono", monospace); font-size: 0.625rem; }
  .gen-audit-table td.mismatch { color: var(--color-warning); }
  .gen-audit-table td.paid { color: var(--color-warning); font-weight: 700; }
  .gen-audit-table td.free { color: var(--color-success); }
  .gen-audit-table th.sortable {
    cursor: pointer;
    user-select: none;
    transition: color 0.15s, background 0.15s;
  }
  .gen-audit-table th.sortable:hover { color: var(--color-text); background: rgba(var(--accent-rgb), 0.1); }
  .sort-arrow {
    font-size: 0.5rem;
    margin-left: 0.15rem;
    color: var(--color-accent);
  }

  /* Merged Raw Output card: picker + collapsible in one bordered container. */
  .raw-output-card {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    margin-bottom: 0.5rem;
    background: rgba(var(--surface-1-rgb), 0.3);
    overflow: hidden;
    flex-shrink: 0;
  }
  .raw-output-picker {
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    background: rgba(var(--bg-deep-rgb), 0.3);
    flex-shrink: 0;
  }
  .raw-output-picker select {
    width: 100%;
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'><path d='M2 4 L5 7 L8 4' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
    background-repeat: no-repeat;
    background-position: right 0.45rem center;
    padding-right: 1.4rem;
  }
  .raw-output-picker select:focus { outline: 2px solid var(--color-accent); outline-offset: -1px; }
  .raw-output-card > details { margin: 0; }
  .raw-output-card > details > summary {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.6rem;
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text);
    list-style: none;
  }
  .raw-output-card > details > summary::-webkit-details-marker { display: none; }
  .raw-output-card > details > summary :global(svg:first-child) { color: var(--color-muted); transition: transform 0.2s; flex-shrink: 0; }
  .raw-output-card > details[open] > summary :global(svg:first-child) { transform: rotate(90deg); }

  .failover-badge {
    display: inline-block;
    padding: 0.05rem 0.3rem;
    border-radius: 999px;
    font-size: 0.5625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: rgba(var(--warning-rgb), 0.15);
    color: var(--color-warning);
    margin-left: 0.25rem;
  }

  .monitor-view {
    flex: 1;
    display: flex;
    overflow: hidden;
    gap: 0.25rem;
    padding: 0.25rem;
    background: rgba(var(--bg-deep-rgb), 0.4);
    min-height: 0;
  }

  .monitor-rail {
    width: 280px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
  }
  .monitor-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .header-actions { display: flex; gap: 0.35rem; align-items: center; }

  .rail-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.6rem;
    min-height: 0;
  }
  .main-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.6rem;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .spin { animation: mon-spin 0.8s linear infinite; }
  @keyframes mon-spin { to { transform: rotate(360deg); } }

  .monitor-error {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--color-error);
    padding: 0.45rem 0.7rem;
    font-size: 0.75rem;
    border-radius: 8px;
    border: 1px solid rgba(var(--error-rgb), 0.3);
    background: rgba(var(--error-rgb), 0.08);
    flex-shrink: 0;
  }
  .error-close {
    width: 1.3rem;
    height: 1.3rem;
    margin-left: auto;
    border-radius: 5px;
  }

  /* === Left rail === */
  .rail-label {
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--color-muted);
    margin: 0.6rem 0 0.4rem;
    padding-left: 0.2rem;
  }
  .rail-label:first-child { margin-top: 0; }
  .rail-empty {
    font-size: 0.6875rem;
    color: var(--color-muted);
    padding: 0.4rem 0.2rem;
    opacity: 0.6;
    line-height: 1.5;
  }

  .cfg-card, .preset-card {
    border-radius: 10px;
    padding: 0.55rem 0.65rem;
    margin-bottom: 0.4rem;
    border: 1px solid var(--color-border);
    background: linear-gradient(165deg, rgba(var(--surface-1-rgb), 0.55), rgba(var(--surface-2-rgb), 0.65));
    transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
    cursor: pointer;
  }
  .cfg-card:hover, .preset-card:hover { border-color: var(--color-border-accent); }
  .cfg-card.selected {
    border-color: var(--color-accent);
    background: rgba(var(--accent-rgb), 0.1);
    box-shadow: var(--glow-accent);
  }
  .cfg-top { display: flex; align-items: center; justify-content: space-between; gap: 0.3rem; }
  .cfg-name { font-weight: 700; font-size: 0.78125rem; }
  .cfg-interval {
    font-size: 0.625rem;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    background: rgba(var(--accent-rgb), 0.15);
    color: var(--color-accent);
    font-weight: 700;
    white-space: nowrap;
  }
  .cfg-meta {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.6875rem;
    color: var(--color-muted);
    margin-top: 0.2rem;
  }
  .cfg-schedule { margin-bottom: 0.35rem; }
  .cfg-next { color: var(--color-accent); }
  .cfg-actions { display: flex; gap: 0.25rem; position: relative; z-index: 1; }
  .cfg-delete:hover:not(:disabled) {
    color: var(--color-error);
    border-color: rgba(var(--error-rgb), 0.4);
  }

  .tier-pill {
    padding: 0.08rem 0.4rem;
    border-radius: 999px;
    font-size: 0.625rem;
    font-weight: 700;
  }
  .tier-free { background: rgba(var(--success-rgb), 0.15); color: var(--color-success); }
  .tier-paid { background: rgba(var(--warning-rgb), 0.15); color: var(--color-warning); }
  .tier-all { background: rgba(var(--muted-rgb), 0.15); color: var(--color-muted); }

  /* Preset cards */
  .preset-head { display: flex; align-items: center; justify-content: space-between; cursor: pointer; }
  .preset-name {
    font-weight: 700;
    font-size: 0.78125rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .smoke-icon { color: var(--color-success); }
  .preset-lens-count {
    font-size: 0.625rem;
    padding: 0.1rem 0.35rem;
    border-radius: 999px;
    background: rgba(var(--accent-rgb), 0.12);
    color: var(--color-accent);
    font-weight: 700;
  }
  .preset-desc {
    font-size: 0.6875rem;
    color: var(--color-muted);
    margin: 0.2rem 0;
    line-height: 1.4;
  }
  .preset-details { margin-top: 0.3rem; }
  .preset-details summary {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.6875rem;
    color: var(--color-muted);
    cursor: pointer;
    list-style: none;
  }
  .preset-details summary::-webkit-details-marker { display: none; }
  .preset-details[open] summary :global(svg) { transform: rotate(90deg); }
  .preset-details summary :global(svg) { transition: transform 0.2s; }
  .preset-lenses {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin: 0.4rem 0;
  }
  .lens-chip {
    font-size: 0.6875rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: rgba(var(--accent-rgb), 0.1);
    border: 1px solid var(--color-border);
  }

  /* === Main area === */
  .run-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.7rem;
    border-radius: 8px;
    background: rgba(var(--accent-rgb), 0.1);
    border: 1px solid var(--color-border-accent);
    font-size: 0.75rem;
    color: var(--color-accent);
    flex-shrink: 0;
  }
  .run-banner .dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--color-accent);
    box-shadow: 0 0 8px var(--color-accent);
    animation: dot-pulse 1.5s ease-in-out infinite;
    flex-shrink: 0;
  }
  @keyframes dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

  .run-progress {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .run-banner-right {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-left: auto;
  }
  .reviewer-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.5rem;
  }
  @media (min-width: 900px) {
    .reviewer-grid { grid-template-columns: repeat(3, 1fr); }
  }
  @media (min-width: 1400px) {
    .reviewer-grid { grid-template-columns: repeat(4, 1fr); }
  }
  .reviewer-card {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.65rem;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(var(--bg-deep-rgb), 0.4);
    transition: border-color 0.2s, box-shadow 0.2s;
    min-width: 0;
  }
  .reviewer-card.running {
    border-color: rgba(var(--accent-rgb), 0.3);
  }
  .reviewer-card.queued {
    border-color: rgba(var(--warning-rgb), 0.3);
  }
  .reviewer-card.done {
    border-color: rgba(var(--success-rgb), 0.3);
  }
  .reviewer-card.error {
    border-color: rgba(var(--error-rgb), 0.3);
  }
  .reviewer-card-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }
  .reviewer-card.running .reviewer-card-head { color: var(--color-accent); }
  .reviewer-card.queued .reviewer-card-head { color: var(--color-warning); }
  .reviewer-card.done .reviewer-card-head { color: var(--color-success); }
  .reviewer-card.error .reviewer-card-head { color: var(--color-error); }
  .reviewer-model {
    font-size: 0.75rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .reviewer-status-tag {
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-muted);
    flex-shrink: 0;
  }
  .reviewer-card.running .reviewer-status-tag { color: var(--color-accent); }
  .reviewer-card.queued .reviewer-status-tag { color: var(--color-warning); }
  .reviewer-card.done .reviewer-status-tag { color: var(--color-success); }
  .reviewer-card.error .reviewer-status-tag { color: var(--color-error); }
  .reviewer-text {
    font-size: 0.6875rem;
    line-height: 1.5;
    color: var(--color-text);
    opacity: 0.7;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 280px;
    overflow-y: auto;
    padding-right: 0.2rem;
  }
  .reviewer-card.done .reviewer-text { opacity: 0.55; }
  .reviewer-card.error .reviewer-text { opacity: 0.4; }
  .reviewer-error-msg {
    color: var(--color-error);
    font-weight: 600;
    opacity: 0.9;
  }
  .reviewer-queued-msg {
    color: var(--color-warning);
    font-weight: 600;
    opacity: 0.9;
  }
  .pulse {
    animation: pulse-fade 1.4s ease-in-out infinite;
  }
  @keyframes pulse-fade {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
  .reviewer-card.aggregator-card {
    grid-column: 1 / -1;
    border-color: rgba(var(--accent-2-rgb), 0.3);
    background: rgba(var(--accent-2-rgb), 0.05);
  }
  .reviewer-card.aggregator-card.running {
    border-color: rgba(var(--accent-2-rgb), 0.4);
    box-shadow: 0 0 12px rgba(var(--accent-2-rgb), 0.15);
  }
  .reviewer-card.aggregator-card.queued {
    border-color: rgba(var(--warning-rgb), 0.4);
    box-shadow: 0 0 12px rgba(var(--warning-rgb), 0.12);
  }
  .reviewer-card.aggregator-card .reviewer-card-head { color: var(--color-accent-secondary); }
  .reviewer-sub-model {
    font-size: 0.625rem;
    color: var(--color-muted);
    font-weight: 400;
  }
  .reviewer-card.aggregator-card .reviewer-text { max-height: 400px; }

  .main-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    flex: 1;
    padding: 3rem 1rem;
    color: var(--color-muted);
    gap: 0.5rem;
  }
  .main-empty > :first-child { opacity: 0.5; }
  .empty-hint { font-size: 0.6875rem; opacity: 0.6; max-width: 26rem; line-height: 1.5; }

  .selected-result-header { margin-top: 0.75rem; }
  .gh-create { color: var(--color-muted); }
  .gh-create:hover:not(:disabled) {
    color: var(--color-success);
    border-color: rgba(var(--success-rgb), 0.4);
  }

  /* Lens legend — emoji + code chips that teach the codes and filter on click */
  .lens-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    flex-shrink: 0;
  }
  .lens-legend-item {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.4);
    color: var(--color-muted);
    font-size: 0.6875rem;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s;
    font-family: var(--font-mono, monospace);
  }
  .lens-legend-item:hover { border-color: var(--color-border-accent); color: var(--color-text); }
  .lens-legend-item.active {
    border-color: var(--color-accent);
    background: rgba(var(--accent-rgb), 0.12);
    color: var(--color-accent);
    box-shadow: 0 0 8px rgba(var(--accent-rgb), 0.15);
  }
  .lens-legend-emoji { font-family: initial; }
  .lens-legend-count {
    font-size: 0.5625rem;
    padding: 0.02rem 0.3rem;
    border-radius: 999px;
    background: rgba(var(--accent-rgb), 0.15);
    color: var(--color-accent);
    font-weight: 800;
  }
  .lens-legend-item.active .lens-legend-count { background: rgba(var(--accent-rgb), 0.25); }

  /* Reviewer chips — friendly name + vendor color dot */
  .rev-chips { display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: center; }
  .rev-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
    font-size: 0.6875rem;
    color: var(--color-text);
    opacity: 0.85;
    white-space: nowrap;
  }
  .rev-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    flex-shrink: 0;
    box-shadow: 0 0 5px currentColor;
  }

  /* Result header */
  .result-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.55rem 0.7rem;
    border-radius: 10px;
    background: linear-gradient(165deg, rgba(var(--surface-1-rgb), 0.6), rgba(var(--surface-2-rgb), 0.7));
    border: 1px solid var(--color-border);
    flex-shrink: 0;
  }
  .result-title { font-size: 0.9rem; font-weight: 800; color: var(--color-text); }
  .result-meta { font-size: 0.6875rem; color: var(--color-muted); margin-top: 0.1rem; }
  .meta-sched { color: var(--color-accent); }
  .result-header-right { display: flex; gap: 0.35rem; align-items: center; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
  .cost-badge, .token-badge, .merge-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-weight: 600;
    white-space: nowrap;
  }
  .cost-badge {
    background: rgba(var(--warning-rgb), 0.12);
    color: var(--color-warning);
    border: 1px solid rgba(var(--warning-rgb), 0.25);
  }
  .token-badge {
    background: rgba(var(--accent-3-rgb), 0.1);
    color: var(--color-accent-cyan);
    border: 1px solid rgba(var(--accent-3-rgb), 0.2);
  }
  .merge-badge {
    background: rgba(var(--accent-rgb), 0.1);
    color: var(--color-accent);
    border: 1px solid var(--color-border-accent);
  }

  /* Priority bar — theme tokens: P0 error, P1 warning, P2 success, P3 muted. */
  .priority-bar {
    display: flex;
    gap: 2px;
    border-radius: 8px;
    overflow: hidden;
    height: 26px;
    flex-shrink: 0;
  }
  .priority-seg {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    font-size: 0.6875rem;
    font-weight: 700;
    transition: flex 0.3s;
    min-width: 0;
  }
  .priority-seg.p0 { background: rgba(var(--error-rgb), 0.3); color: var(--color-error); }
  .priority-seg.p1 { background: rgba(var(--warning-rgb), 0.3); color: var(--color-warning); }
  .priority-seg.p2 { background: rgba(var(--success-rgb), 0.3); color: var(--color-success); }
  .priority-seg.p3 { background: rgba(var(--muted-rgb), 0.25); color: var(--color-muted); }
  .seg-label { font-weight: 800; }
  .seg-count { opacity: 0.8; }

  .all-clear {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.8rem;
    border-radius: 10px;
    border: 1px solid rgba(var(--success-rgb), 0.3);
    background: rgba(var(--success-rgb), 0.08);
    color: var(--color-success);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  /* Task cards */
  .task-list { display: flex; flex-direction: column; gap: 0.4rem; }
  .task-card {
    --p-rgb: var(--muted-rgb);
    --p-color: var(--color-muted);
    border-radius: 10px;
    border: 1px solid var(--color-border);
    background: linear-gradient(165deg, rgba(var(--surface-1-rgb), 0.55), rgba(var(--surface-2-rgb), 0.65));
    overflow: hidden;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .task-card:hover { border-color: var(--color-border-accent); }
  .task-card.p0 { --p-rgb: var(--error-rgb); --p-color: var(--color-error); }
  .task-card.p1 { --p-rgb: var(--warning-rgb); --p-color: var(--color-warning); }
  .task-card.p2 { --p-rgb: var(--success-rgb); --p-color: var(--color-success); }
  .task-card.p3 { --p-rgb: var(--muted-rgb); --p-color: var(--color-muted); }
  .task-card { border-left: 3px solid rgba(var(--p-rgb), 0.8); }

  .task-card-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.65rem;
    cursor: pointer;
  }
  .task-check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--color-muted);
    cursor: pointer;
    opacity: 0.6;
    transition: all 0.15s;
    flex-shrink: 0;
    padding: 0;
  }
  .task-check:hover {
    opacity: 1;
    color: var(--color-success);
    background: rgba(var(--success-rgb), 0.12);
  }
  .task-check.checked { color: var(--color-success); opacity: 1; }

  .task-prio {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.12rem 0.45rem;
    border-radius: 5px;
    font-size: 0.6875rem;
    font-weight: 800;
    flex-shrink: 0;
    background: rgba(var(--p-rgb), 0.15);
    color: var(--p-color);
  }
  .task-issue {
    font-weight: 700;
    font-size: 0.78125rem;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .badge-new {
    font-size: 0.5625rem;
    padding: 0.08rem 0.35rem;
    border-radius: 999px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    background: rgba(var(--accent-rgb), 0.15);
    color: var(--color-accent);
    border: 1px solid var(--color-border-accent);
    flex-shrink: 0;
  }
  .task-tags { display: flex; gap: 0.2rem; flex-shrink: 0; }
  .task-lens-tag {
    font-size: 0.625rem;
    padding: 0.08rem 0.35rem;
    border-radius: 999px;
    background: rgba(var(--accent-rgb), 0.08);
    color: var(--color-muted);
    white-space: nowrap;
  }
  .gh-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.625rem;
    color: var(--color-success);
    text-decoration: none;
    flex-shrink: 0;
  }
  .gh-badge:hover { text-decoration: underline; }
  .task-chevron {
    color: var(--color-muted);
    transition: transform 0.2s;
    flex-shrink: 0;
  }
  .task-chevron.open { transform: rotate(180deg); }

  .task-card-body {
    padding: 0 0.65rem 0.6rem 2.65rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .task-field { display: flex; flex-direction: column; gap: 0.1rem; }
  .task-field-label {
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .task-field-value { font-size: 0.75rem; color: var(--color-text); line-height: 1.5; }
  .task-field-row { display: flex; gap: 1rem; flex-wrap: wrap; }
  .task-field-row .task-field { flex: 1; min-width: 8rem; }
  .task-actions { display: flex; gap: 0.4rem; align-items: center; margin-top: 0.2rem; }

  /* Resolved tasks */
  .resolved-section { flex-shrink: 0; }
  .resolved-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    padding: 0.35rem 0.2rem;
    border: none;
    background: transparent;
    color: var(--color-muted);
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    cursor: pointer;
    transition: color 0.15s;
  }
  .resolved-toggle:hover { color: var(--color-text); }
  .resolved-chevron { transition: transform 0.2s; }
  .resolved-chevron.open { transform: rotate(90deg); }
  .resolved-card { opacity: 0.55; }
  .resolved-card:hover { opacity: 0.8; }
  .resolved-issue { text-decoration: line-through; text-decoration-color: rgba(var(--muted-rgb), 0.5); }

  /* Task table — filterable/sortable */
  .task-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0;
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .task-filter-group { display: flex; gap: 0.35rem; }
  .task-filter-select {
    padding: 0.2rem 0.45rem;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.5);
    color: var(--color-text);
    font-size: 0.6875rem;
    cursor: pointer;
    font-family: var(--font-mono, monospace);
  }
  .task-filter-select:hover { border-color: var(--color-border-accent); }
  .task-search-group {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    flex: 1;
    min-width: 10rem;
    max-width: 20rem;
  }
  .search-icon { color: var(--color-muted); flex-shrink: 0; }
  .task-search-input {
    flex: 1;
    padding: 0.2rem 0.45rem;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.5);
    color: var(--color-text);
    font-size: 0.6875rem;
    font-family: var(--font-mono, monospace);
  }
  .task-search-input:focus { outline: none; border-color: var(--color-accent); }
  .task-count-badge {
    font-size: 0.625rem;
    color: var(--color-muted);
    font-weight: 600;
    flex-shrink: 0;
  }
  .task-table-wrap {
    flex: 1;
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: rgba(var(--surface-1-rgb), 0.3);
  }
  .task-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75rem;
  }
  .task-table thead {
    position: sticky;
    top: 0;
    z-index: 2;
    background: rgba(var(--surface-2-rgb), 0.9);
    backdrop-filter: blur(8px);
  }
  .task-table thead th {
    padding: 0.4rem 0.5rem;
    text-align: left;
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-muted);
    border-bottom: 1px solid var(--color-border);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
    transition: color 0.15s;
  }
  .task-table thead th:hover { color: var(--color-text); }
  .sort-icon { vertical-align: middle; margin-left: 0.2rem; }
  .sort-icon.desc { transform: rotate(180deg); }
  .task-table tbody tr {
    border-bottom: 1px solid rgba(var(--border-rgb), 0.3);
    transition: background 0.15s;
  }
  .task-table tbody tr:hover { background: rgba(var(--surface-1-rgb), 0.4); }
  .task-row.expanded { background: rgba(var(--accent-rgb), 0.05); }
  .task-row.p0 { --p-rgb: var(--error-rgb); --p-color: var(--color-error); }
  .task-row.p1 { --p-rgb: var(--warning-rgb); --p-color: var(--color-warning); }
  .task-row.p2 { --p-rgb: var(--success-rgb); --p-color: var(--color-success); }
  .task-row.p3 { --p-rgb: var(--muted-rgb); --p-color: var(--color-muted); }
  .task-row.resolved { opacity: 0.5; }
  .task-row.resolved .task-issue-text { text-decoration: line-through; text-decoration-color: rgba(var(--muted-rgb), 0.5); }
  .task-table td {
    padding: 0.4rem 0.5rem;
    vertical-align: middle;
    cursor: pointer;
  }
  .task-table .col-prio { width: 3.5rem; white-space: nowrap; }
  .task-table .col-issue { min-width: 10rem; }
  .task-table .col-lenses { width: 8rem; }
  .task-table .col-reviewers { width: 7rem; }
  .task-table .col-impact { width: 9rem; }
  .task-table .col-check { width: 2rem; text-align: center; }
  .task-table .col-status { width: 5rem; white-space: nowrap; }
  .task-table .col-first { width: 6rem; white-space: nowrap; }
  .task-table .col-actions { width: 3.5rem; white-space: nowrap; text-align: right; }
  .task-issue-text {
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .task-tags-cell { display: flex; gap: 0.2rem; flex-wrap: wrap; }
  .task-reviewers-cell, .task-impact-cell, .task-date-cell {
    font-size: 0.6875rem;
    color: var(--color-text);
    opacity: 0.75;
  }
  .status-tag {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.625rem;
    font-weight: 700;
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
  }
  .status-tag.open { color: var(--color-accent); background: rgba(var(--accent-rgb), 0.1); }
  .status-tag.resolved { color: var(--color-success); background: rgba(var(--success-rgb), 0.1); }
  .status-tag small { font-weight: 400; opacity: 0.7; }
  .task-row-actions { display: flex; gap: 0.25rem; align-items: center; justify-content: flex-end; }
  .task-detail-row > td { padding: 0 !important; border-bottom: 1px solid rgba(var(--border-rgb), 0.3); }
  .task-detail {
    padding: 0.6rem 0.8rem;
    background: rgba(var(--bg-deep-rgb), 0.3);
    border-top: 1px solid rgba(var(--accent-rgb), 0.15);
  }
  .task-detail-body {
    font-size: 0.75rem;
    line-height: 1.6;
    color: var(--color-text);
  }
  .task-detail-body :global(.md-h) {
    font-size: 0.78125rem;
    font-weight: 700;
    margin: 0.6rem 0 0.25rem;
    color: var(--color-accent);
    letter-spacing: 0.02em;
  }
  .task-detail-body :global(.md-h:first-child) { margin-top: 0; }
  .task-detail-body :global(.md-p) { margin: 0.2rem 0; }
  .task-detail-body :global(.md-li) { margin: 0.15rem 0; padding-left: 0.5rem; }
  .task-detail-body :global(.md-check) { margin: 0.15rem 0; padding-left: 0.5rem; display: flex; align-items: center; gap: 0.3rem; }
  .task-detail-body :global(.md-check input) { accent-color: var(--color-accent); }
  .task-detail-fields { display: flex; flex-direction: column; gap: 0.4rem; }
  .task-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.4rem;
    padding: 2rem;
    color: var(--color-muted);
    font-size: 0.78125rem;
  }

  /* Run history */
  .result-card {
    border-radius: 10px;
    padding: 0.45rem 0.65rem;
    border: 1px solid var(--color-border);
    background: linear-gradient(165deg, rgba(var(--surface-1-rgb), 0.55), rgba(var(--surface-2-rgb), 0.65));
    cursor: pointer;
    transition: border-color 0.2s;
  }
  .result-card:hover { border-color: var(--color-border-accent); }
  .result-card.selected { border-color: var(--color-accent); }
  .result-card-top { display: flex; align-items: center; gap: 0.5rem; }
  .result-card-status {
    font-size: 0.625rem;
    padding: 0.08rem 0.4rem;
    border-radius: 999px;
    font-weight: 700;
  }
  .result-card-status.complete { background: rgba(var(--success-rgb), 0.15); color: var(--color-success); }
  .result-card-status.error { background: rgba(var(--error-rgb), 0.15); color: var(--color-error); }
  .result-card-status.running { background: rgba(var(--warning-rgb), 0.15); color: var(--color-warning); }
  .result-card-meta { font-size: 0.625rem; color: var(--color-muted); }
  .result-card-stats { display: flex; gap: 0.3rem; align-items: center; margin-top: 0.3rem; }
  .stat-pill {
    font-size: 0.625rem;
    padding: 0.08rem 0.35rem;
    border-radius: 999px;
    font-weight: 700;
  }
  .stat-pill.p0 { background: rgba(var(--error-rgb), 0.15); color: var(--color-error); }
  .stat-pill.p1 { background: rgba(var(--warning-rgb), 0.15); color: var(--color-warning); }
  .stat-pill.p2 { background: rgba(var(--success-rgb), 0.15); color: var(--color-success); }
  .stat-pill.p3 { background: rgba(var(--muted-rgb), 0.2); color: var(--color-muted); }
  .stat-cost { font-size: 0.625rem; color: var(--color-warning); margin-left: auto; }

  /* === Modal === */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(var(--backdrop-rgb), 0.55);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal {
    background: linear-gradient(165deg, rgba(var(--surface-1-rgb), 0.95), rgba(var(--surface-2-rgb), 0.98));
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid var(--color-border-accent);
    border-radius: 14px;
    width: 720px;
    max-width: 92vw;
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 24px 60px rgba(var(--shadow-rgb), 0.5);
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--color-border);
  }
  .modal-title { font-weight: 800; font-size: 0.9rem; }
  .modal-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 6px;
    color: var(--color-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    opacity: 0.5;
    transition: all 0.15s;
  }
  .modal-close:hover { opacity: 1; color: var(--color-error); background: rgba(var(--error-rgb), 0.12); }
  .modal-body { padding: 1rem; overflow-y: auto; display: flex; flex-direction: column; gap: 0.75rem; }
  .modal-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--color-border);
  }
  .footer-right { display: flex; gap: 0.4rem; align-items: center; }

  .field { display: flex; flex-direction: column; gap: 0.25rem; }
  .field-label {
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .field-hint { text-transform: none; font-weight: 400; opacity: 0.6; }
  .field-muted { font-size: 0.75rem; color: var(--color-muted); padding: 0.4rem 0; }
  .field-row { display: flex; gap: 0.6rem; }
  .field-row .field { flex: 1; }

  /* Toggle rows — same pattern as SettingsPanel. */
  .toggle-list { display: flex; flex-direction: column; gap: 0.6rem; }
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .toggle-title { font-size: 0.75rem; font-weight: 600; }
  .toggle-desc { font-size: 0.6875rem; color: var(--color-muted); margin-top: 0.1rem; line-height: 1.4; }
  .toggle {
    position: relative;
    width: 38px;
    height: 22px;
    border-radius: 999px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.6);
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.18s, border-color 0.18s;
    padding: 0;
  }
  .toggle.on {
    background: rgba(var(--accent-rgb), 0.35);
    border-color: var(--color-accent);
    box-shadow: var(--glow-accent);
  }
  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--color-text);
    transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .toggle.on .toggle-knob { transform: translateX(16px); }

  /* Expertise selector */
  .expertise-selector { display: flex; gap: 0.3rem; }
  .expertise-btn {
    flex: 1;
    padding: 0.4rem;
    border-radius: 7px;
    border: 1px solid var(--color-border);
    background: rgba(var(--bg-deep-rgb), 0.4);
    color: var(--color-text);
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 600;
    transition: all 0.15s;
  }
  .expertise-btn:hover { border-color: var(--color-border-accent); }
  .expertise-btn.selected {
    border-color: var(--color-accent);
    background: rgba(var(--accent-rgb), 0.12);
    color: var(--color-accent);
    box-shadow: var(--glow-accent);
  }

  /* Tier selector */
  .tier-selector { display: flex; gap: 0.4rem; }
  .tier-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    padding: 0.5rem;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(var(--bg-deep-rgb), 0.4);
    color: var(--color-text);
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 600;
    transition: all 0.15s;
  }
  .tier-btn small { font-size: 0.625rem; font-weight: 400; color: var(--color-muted); }
  .tier-btn:hover { border-color: var(--color-border-accent); }
  .tier-btn.selected {
    border-color: var(--color-accent);
    background: rgba(var(--accent-rgb), 0.12);
    color: var(--color-accent);
    box-shadow: var(--glow-accent);
  }

  /* Schedule row */
  .schedule-row { display: flex; gap: 0.4rem; align-items: center; }
  .schedule-num { width: 80px; }
  .schedule-unit { width: 100px; }
  .schedule-hint { font-size: 0.6875rem; color: var(--color-muted); }

  /* Model picker */
  .model-search-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  .model-search-input {
    flex: 1;
    min-width: 0;
    font-size: 0.75rem;
    padding: 0.3rem 0.5rem;
  }
  .model-search-count {
    flex-shrink: 0;
    font-size: 0.6875rem;
    color: var(--color-muted);
    white-space: nowrap;
  }
  .model-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    max-height: 140px;
    overflow-y: auto;
    padding: 0.3rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: rgba(var(--bg-deep-rgb), 0.3);
  }
  .model-chip {
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.5);
    color: var(--color-text);
    font-size: 0.6875rem;
    cursor: pointer;
    transition: all 0.15s;
  }
  .model-chip:hover { border-color: var(--color-border-accent); }
  .model-chip.selected {
    border-color: var(--color-accent);
    background: rgba(var(--accent-rgb), 0.15);
    color: var(--color-accent);
    box-shadow: 0 0 8px rgba(var(--accent-rgb), 0.2);
  }
  .model-param-badge {
    display: inline-block;
    margin-left: 0.35rem;
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    background: rgba(var(--bg-deep-rgb), 0.5);
    font-size: 0.5625rem;
    font-weight: 600;
    color: var(--color-muted);
    letter-spacing: 0.02em;
  }
  .model-chip.selected .model-param-badge {
    background: rgba(var(--accent-rgb), 0.2);
    color: var(--color-accent);
  }

  /* Popularity badge — shows 7-day token usage from OpenRouter rankings */
  .model-pop-badge {
    display: inline-block;
    margin-left: 0.35rem;
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    background: rgba(var(--accent-3-rgb), 0.12);
    font-size: 0.5625rem;
    font-weight: 700;
    color: var(--color-accent-cyan);
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
  }
  .model-chip.selected .model-pop-badge {
    background: rgba(var(--accent-3-rgb), 0.25);
  }
  .model-chip.popular {
    border-color: rgba(var(--accent-3-rgb), 0.25);
  }

  /* Popular / All sort toggle */
  .model-sort-toggle {
    display: flex;
    gap: 0;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--color-border);
    flex-shrink: 0;
  }
  .model-sort-btn {
    padding: 0.2rem 0.5rem;
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    background: rgba(var(--bg-deep-rgb), 0.4);
    color: var(--color-muted);
    border: none;
    cursor: pointer;
    transition: all 0.15s;
  }
  .model-sort-btn.selected {
    background: rgba(var(--accent-rgb), 0.15);
    color: var(--color-accent);
  }
  .model-sort-btn:not(.selected):hover {
    color: var(--color-text);
  }

  /* Lenses */
  .lenses-section { margin-top: 0.2rem; }
  .lenses-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem; }
  .lens-row { display: flex; gap: 0.3rem; margin-bottom: 0.3rem; align-items: center; }
  .lens-emoji { width: 42px; text-align: center; flex-shrink: 0; }
  .lens-code {
    width: 5.5rem;
    flex-shrink: 0;
    text-transform: uppercase;
    font-family: var(--font-mono, monospace);
    font-weight: 700;
    letter-spacing: 0.05em;
  }
  .lens-label { flex: 1; }
  .lens-delete { width: 1.7rem; height: 1.7rem; flex-shrink: 0; }
  .lens-delete:hover { color: var(--color-error); border-color: rgba(var(--error-rgb), 0.4); box-shadow: none; }

  /* perf-lite: kill the pulsing dot animation like other decorative motion. */
  :global(html.perf-lite) .run-banner .dot { animation: none; }
  :global(html.perf-lite) .reviewer-card .spin { animation: none; }
  :global(html.perf-lite) .reviewer-text .caret-blink::after { animation: none; }
  :global(html.perf-lite) .theater-card .spin { animation: none; }
  :global(html.perf-lite) .theater-card-text .caret-blink::after { animation: none; }
  @media (prefers-reduced-motion: reduce) {
    .run-banner .dot { animation: none; }
    .reviewer-card .spin { animation: none; }
    .reviewer-text .caret-blink::after { animation: none; }
    .theater-card .spin { animation: none; }
    .theater-card-text .caret-blink::after { animation: none; }
  }

  /* ===== View-mode switcher ===== */
  .view-mode-bar {
    display: flex;
    gap: 0.25rem;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
    overflow-x: auto;
  }
  .view-mode-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.55rem;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--color-muted);
    font-size: 0.6875rem;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
  }
  .view-mode-btn:hover { color: var(--color-text); background: rgba(var(--surface-1-rgb), 0.4); }
  .view-mode-btn.active {
    color: var(--color-accent);
    border-color: var(--color-border-accent);
    background: rgba(var(--accent-rgb), 0.1);
  }

  /* ===== Kanban view ===== */
  .kanban-board {
    display: flex;
    gap: 0.5rem;
    overflow-x: auto;
    padding: 0.5rem;
    flex: 1;
    min-height: 0;
  }
  .kanban-col {
    display: flex;
    flex-direction: column;
    min-width: 200px;
    flex: 1;
    max-width: 280px;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(var(--bg-deep-rgb), 0.25);
  }
  .kanban-col-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--color-border);
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .kanban-col-prio { display: flex; align-items: center; gap: 0.25rem; }
  .kanban-col-prio.p0 { color: var(--color-error); }
  .kanban-col-prio.p1 { color: var(--color-warning); }
  .kanban-col-prio.p2 { color: var(--color-success); }
  .kanban-col-prio.p3 { color: var(--color-muted); }
  .kanban-col-prio.resolved { color: var(--color-muted); }
  .kanban-col-count {
    font-size: 0.625rem;
    padding: 0.05rem 0.35rem;
    border-radius: 999px;
    background: rgba(var(--surface-1-rgb), 0.6);
    color: var(--color-muted);
  }
  .kanban-col-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .kanban-card {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.3rem;
    padding: 0.4rem 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.5);
    font-size: 0.6875rem;
    cursor: default;
  }
  .kanban-card.p0 { border-left: 3px solid var(--color-error); }
  .kanban-card.p1 { border-left: 3px solid var(--color-warning); }
  .kanban-card.p2 { border-left: 3px solid var(--color-success); }
  .kanban-card.p3 { border-left: 3px solid var(--color-muted); }
  .kanban-card.resolved { opacity: 0.5; }
  .kanban-card .task-check { flex-shrink: 0; margin-top: 1px; }
  .kanban-card-issue { flex: 1; min-width: 0; font-weight: 500; line-height: 1.3; }
  .kanban-card-fix { flex-basis: 100%; font-size: 0.625rem; color: var(--color-muted); line-height: 1.3; }
  .kanban-card-tags { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 0.2rem; }
  .kanban-col-empty { text-align: center; color: var(--color-muted); font-size: 0.625rem; padding: 0.8rem; }
  .kanban-run-info {
    padding: 0.4rem 0.6rem;
    font-size: 0.6875rem;
    color: var(--color-muted);
    border-top: 1px solid var(--color-border);
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  /* ===== Theater view ===== */
  .theater-stage { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem; flex: 1; min-height: 0; }
  .theater-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(var(--accent-rgb), 0.08);
    font-size: 0.75rem;
  }
  .theater-banner-right { margin-left: auto; }
  .theater-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0.5rem;
    overflow-y: auto;
    flex: 1;
  }
  .theater-card {
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.5);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 120px;
  }
  .theater-card.running { border-color: var(--color-border-accent); box-shadow: 0 0 12px rgba(var(--accent-rgb), 0.15); }
  .theater-card.queued { border-color: rgba(var(--warning-rgb), 0.4); box-shadow: 0 0 12px rgba(var(--warning-rgb), 0.12); }
  .theater-card.done { border-color: rgba(var(--success-rgb), 0.3); }
  .theater-card.error { border-color: rgba(var(--error-rgb), 0.4); }
  .theater-card.aggregator { border-style: dashed; }
  .theater-card-head {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--color-border);
    font-size: 0.6875rem;
    font-weight: 600;
  }
  .theater-card-model { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .theater-card-sub { font-size: 0.5625rem; color: var(--color-muted); }
  .theater-card-status {
    font-size: 0.5625rem;
    text-transform: uppercase;
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    background: rgba(var(--surface-1-rgb), 0.6);
    color: var(--color-muted);
  }
  .theater-card-text {
    padding: 0.4rem 0.5rem;
    font-size: 0.625rem;
    line-height: 1.4;
    white-space: pre-wrap;
    overflow-y: auto;
    flex: 1;
    max-height: 200px;
    color: var(--color-text);
    opacity: 0.85;
  }
  .theater-waiting {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--color-muted);
    font-size: 0.75rem;
  }
  .theater-results { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.5rem; flex: 1; overflow-y: auto; }
  .theater-results-header { padding: 0 0.2rem; }
  .theater-lens-list { display: flex; flex-direction: column; gap: 0.3rem; }
  .theater-lens-section {
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.3);
    overflow: hidden;
  }
  .theater-lens-summary {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 600;
    list-style: none;
  }
  .theater-lens-summary::-webkit-details-marker { display: none; }
  .theater-lens-emoji { font-size: 0.875rem; }
  .theater-lens-count {
    margin-left: auto;
    font-size: 0.625rem;
    padding: 0.05rem 0.35rem;
    border-radius: 999px;
    background: rgba(var(--surface-1-rgb), 0.6);
    color: var(--color-muted);
  }
  .theater-chevron { color: var(--color-muted); transition: transform 0.2s; }
  details[open] .theater-chevron { transform: rotate(180deg); }
  .theater-lens-tasks { padding: 0.2rem 0.4rem 0.4rem; display: flex; flex-direction: column; gap: 0.2rem; }
  .theater-task {
    display: flex;
    align-items: flex-start;
    gap: 0.35rem;
    padding: 0.3rem 0.4rem;
    border-radius: 6px;
    background: rgba(var(--bg-deep-rgb), 0.2);
    font-size: 0.6875rem;
  }
  .theater-task.resolved { opacity: 0.5; }
  .theater-task-issue { flex: 1; min-width: 0; line-height: 1.3; }
  .theater-task-fix { flex-basis: 100%; font-size: 0.625rem; color: var(--color-muted); margin-left: 1.5rem; }

  /* ===== Tracker view ===== */
  .tracker-layout { display: flex; gap: 0.5rem; flex: 1; min-height: 0; padding: 0.3rem; }
  .tracker-list { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.3rem; overflow: hidden; }
  .tracker-filters {
    display: flex;
    gap: 0.3rem;
    align-items: center;
    flex-wrap: wrap;
    padding: 0.3rem;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(var(--bg-deep-rgb), 0.2);
  }
  .tracker-rows { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 0.15rem; }
  .tracker-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.5rem;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    font-size: 0.6875rem;
    transition: background 0.12s, border-color 0.12s;
  }
  .tracker-row:hover { background: rgba(var(--surface-1-rgb), 0.4); }
  .tracker-row.selected { border-color: var(--color-border-accent); background: rgba(var(--accent-rgb), 0.08); }
  .tracker-row.resolved { opacity: 0.5; }
  .tracker-row.p0 { border-left: 3px solid var(--color-error); }
  .tracker-row.p1 { border-left: 3px solid var(--color-warning); }
  .tracker-row.p2 { border-left: 3px solid var(--color-success); }
  .tracker-row.p3 { border-left: 3px solid var(--color-muted); }
  .tracker-row-issue { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tracker-row-lenses { display: flex; gap: 0.1rem; font-size: 0.625rem; flex-shrink: 0; }
  .tracker-detail {
    width: 320px;
    flex-shrink: 0;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .tracker-detail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--color-border);
  }
  .tracker-detail-body { padding: 0.5rem 0.6rem; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 0.5rem; font-size: 0.75rem; }
  .tracker-detail-prio { display: flex; align-items: center; gap: 0.4rem; }
  .tracker-detail-issue { font-weight: 600; font-size: 0.8125rem; line-height: 1.3; }
  .tracker-detail-section { display: flex; flex-direction: column; gap: 0.2rem; }
  .tracker-detail-section .field-label { font-size: 0.625rem; }
  .tracker-detail-tags { display: flex; flex-wrap: wrap; gap: 0.2rem; }
  .tracker-detail-actions { display: flex; gap: 0.3rem; margin-top: 0.3rem; }
  .tracker-detail-empty {
    width: 320px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    color: var(--color-muted);
    font-size: 0.75rem;
    border-radius: 8px;
    border: 1px dashed var(--color-border);
  }

  /* ===== Scorecard view ===== */
  .scorecard { display: flex; flex-direction: column; gap: 0.6rem; padding: 0.6rem; overflow-y: auto; flex: 1; }
  .scorecard-hero {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.8rem 1rem;
    border-radius: 10px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.3);
  }
  .scorecard-score { display: flex; align-items: baseline; gap: 0.15rem; }
  .scorecard-score-num { font-size: 2.5rem; font-weight: 700; line-height: 1; }
  .scorecard-score-max { font-size: 1rem; color: var(--color-muted); }
  .scorecard-score.good { color: var(--color-success); }
  .scorecard-score.ok { color: var(--color-warning); }
  .scorecard-score.bad { color: var(--color-error); }
  .scorecard-trend { display: flex; flex-direction: column; gap: 0.1rem; }
  .scorecard-delta { display: flex; align-items: center; gap: 0.25rem; font-size: 0.8125rem; font-weight: 600; }
  .scorecard-delta.good { color: var(--color-success); }
  .scorecard-delta.bad { color: var(--color-error); }
  .scorecard-delta-sub { font-size: 0.625rem; color: var(--color-muted); }
  .sparkline-label { font-size: 0.6875rem; font-weight: 600; color: var(--color-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.3rem; }
  .scorecard-sparkline { padding: 0.5rem; border-radius: 8px; border: 1px solid var(--color-border); background: rgba(var(--bg-deep-rgb), 0.2); }
  .sparkline-chart { display: flex; align-items: flex-end; gap: 2px; height: 60px; }
  .sparkline-bar {
    flex: 1;
    min-width: 4px;
    display: flex;
    flex-direction: column-reverse;
    border-radius: 3px 3px 0 0;
    overflow: hidden;
    transition: height 0.3s;
  }
  .sparkline-seg { min-height: 1px; }
  .sparkline-seg.p0 { background: var(--color-error); }
  .sparkline-seg.p1 { background: var(--color-warning); }
  .sparkline-seg.p2 { background: var(--color-success); }
  .sparkline-seg.p3 { background: var(--color-muted); opacity: 0.5; }
  .scorecard-grades { padding: 0.5rem; border-radius: 8px; border: 1px solid var(--color-border); background: rgba(var(--bg-deep-rgb), 0.2); }
  .grade-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 0.4rem; }
  .grade-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    padding: 0.4rem;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.3);
    font-size: 0.625rem;
  }
  .grade-card.good { border-color: rgba(var(--success-rgb), 0.3); }
  .grade-card.ok { border-color: rgba(var(--warning-rgb), 0.3); }
  .grade-card.bad { border-color: rgba(var(--error-rgb), 0.3); }
  .grade-emoji { font-size: 1rem; }
  .grade-label { font-weight: 600; text-align: center; line-height: 1.2; }
  .grade-letter { font-size: 1.125rem; font-weight: 700; }
  .grade-card.good .grade-letter { color: var(--color-success); }
  .grade-card.ok .grade-letter { color: var(--color-warning); }
  .grade-card.bad .grade-letter { color: var(--color-error); }
  .grade-detail { color: var(--color-muted); font-size: 0.5625rem; }
  .scorecard-top-issues { padding: 0.5rem; border-radius: 8px; border: 1px solid var(--color-border); background: rgba(var(--bg-deep-rgb), 0.2); }
  .scorecard-issue-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.4rem;
    border-radius: 6px;
    background: rgba(var(--error-rgb), 0.05);
    font-size: 0.6875rem;
    margin-bottom: 0.2rem;
  }
  .scorecard-issue-row .p0-icon { color: var(--color-error); flex-shrink: 0; }
  .scorecard-issue-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scorecard-issue-lenses { display: flex; gap: 0.1rem; flex-shrink: 0; }
  .scorecard-more { font-size: 0.625rem; color: var(--color-muted); padding: 0.2rem 0.4rem; }

  /* ===== Timeline view ===== */
  .timeline-feed { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.6rem; overflow-y: auto; flex: 1; }
  .timeline-msg {
    display: flex;
    gap: 0.5rem;
    padding: 0.6rem;
    border-radius: 10px;
    border: 1px solid var(--color-border);
    background: rgba(var(--surface-1-rgb), 0.3);
  }
  .timeline-msg.running { border-color: var(--color-border-accent); box-shadow: 0 0 12px rgba(var(--accent-rgb), 0.1); }
  .timeline-msg.error { border-color: rgba(var(--error-rgb), 0.3); }
  .timeline-msg-avatar {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(var(--accent-rgb), 0.1);
    color: var(--color-accent);
  }
  .timeline-msg.complete .timeline-msg-avatar { color: var(--color-success); background: rgba(var(--success-rgb), 0.1); }
  .timeline-msg.error .timeline-msg-avatar { color: var(--color-error); background: rgba(var(--error-rgb), 0.1); }
  .timeline-msg-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .timeline-msg-header { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; font-size: 0.6875rem; }
  .timeline-msg-date { font-weight: 600; }
  .timeline-msg-trigger { color: var(--color-muted); text-transform: capitalize; }
  .timeline-msg-models { color: var(--color-muted); }
  .timeline-msg.interrupted .timeline-msg-avatar { color: var(--color-warning); background: rgba(var(--warning-rgb), 0.1); }
  .timeline-msg-note { font-size: 0.6875rem; color: var(--color-warning); opacity: 0.9; }
  .timeline-resume-btn {
    display: inline-flex; align-items: center; gap: 0.2rem;
    color: var(--color-warning);
    border: 1px solid rgba(var(--warning-rgb), 0.35);
    background: rgba(var(--warning-rgb), 0.08);
  }
  .timeline-resume-btn:hover:not(:disabled) { background: rgba(var(--warning-rgb), 0.15); }
  .timeline-msg-stats { display: flex; gap: 0.2rem; }
  .timeline-msg-details { margin-top: 0.2rem; }
  .timeline-msg-summary {
    cursor: pointer;
    font-size: 0.6875rem;
    color: var(--color-accent);
    padding: 0.2rem 0;
  }
  .timeline-msg-tasks { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.2rem 0; }
  .timeline-task {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.4rem;
    border-radius: 4px;
    background: rgba(var(--bg-deep-rgb), 0.2);
    font-size: 0.625rem;
  }
  .timeline-task.p0 { border-left: 2px solid var(--color-error); }
  .timeline-task.p1 { border-left: 2px solid var(--color-warning); }
  .timeline-task.p2 { border-left: 2px solid var(--color-success); }
  .timeline-task.p3 { border-left: 2px solid var(--color-muted); }
  .timeline-task-issue { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .timeline-more { font-size: 0.5625rem; color: var(--color-muted); padding: 0.15rem 0.4rem; }
  .timeline-load-btn { margin: 0.2rem 0; }
  .timeline-composer {
    display: flex;
    gap: 0.3rem;
    align-items: center;
    flex-wrap: wrap;
    padding: 0.5rem;
    border-radius: 8px;
    border: 1px dashed var(--color-border);
    background: rgba(var(--bg-deep-rgb), 0.15);
    margin-top: 0.3rem;
  }
</style>
