<script lang="ts">
  import { onMount } from "svelte";

  interface Series {
    data: number[];
    color: string;
    fill?: boolean;
  }

  let {
    series = [] as Series[],
    max = 100,
    height = 36,
  }: { series?: Series[]; max?: number; height?: number } = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let ctx: CanvasRenderingContext2D | null = null;
  let cachedAccentRgb = "";

  function draw() {
    if (!ctx || !canvas) return;
    const w = canvas.width / window.devicePixelRatio;
    const h = canvas.height / window.devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    if (series.length === 0) return;

    const m = max || 100;
    if (!cachedAccentRgb) {
      cachedAccentRgb = getComputedStyle(document.documentElement)
        .getPropertyValue("--accent-rgb")
        .trim();
    }
    const accentRgb = cachedAccentRgb;

    for (const s of series) {
      if (s.data.length < 2) continue;
      const step = w / (s.data.length - 1);

      // Fill area
      if (s.fill) {
        const rgb = hexToRgb(s.color) || accentRgb;
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, `rgba(${rgb}, 0.25)`);
        grad.addColorStop(1, `rgba(${rgb}, 0.0)`);
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i < s.data.length; i++) {
          const x = i * step;
          const y = h - (Math.min(s.data[i], m) / m) * h;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }

      // Stroke line
      ctx.beginPath();
      for (let i = 0; i < s.data.length; i++) {
        const x = i * step;
        const y = h - (Math.min(s.data[i], m) / m) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 4;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  function hexToRgb(hex: string): string | null {
    if (!hex.startsWith("#")) return null;
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return `${r}, ${g}, ${b}`;
  }

  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;
    ctx?.setTransform(1, 0, 0, 1, 0, 0);
    ctx?.scale(window.devicePixelRatio, window.devicePixelRatio);
    canvas.style.height = height + "px";
    draw();
  }

  onMount(() => {
    ctx = canvas!.getContext("2d");
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  });

  $effect(() => {
    void series;
    void max;
    draw();
  });
</script>

<canvas class="sparkline" bind:this={canvas}></canvas>

<style>
  .sparkline {
    display: block;
    width: 100%;
  }
</style>
