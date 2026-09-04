<script lang="ts">
  import { onMount } from "svelte";
  import type * as THREE from "three";
  import { themeStore, settingsStore } from "@adaan/core";
  import type { ThemeId, ThreeQuality } from "@adaan/core";

  let canvas: HTMLCanvasElement | null = $state(null);
  let renderer: THREE.WebGLRenderer | null = null;
  let animationId: number | null = null;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let particles: THREE.Points | null = null;
  let grid: THREE.GridHelper | null = null;
  let currentTheme: ThemeId = themeStore.current;
  let currentQuality: ThreeQuality = settingsStore.settings.performance.threeQuality;
  // Cached THREE module + palette — set in init() so we don't re-evaluate per frame.
  let THREE_mod: typeof import("three") | null = null;
  let cachedPalette: Palette | null = null;
  // Guard against concurrent init() calls (async import race when presets
  // are clicked rapidly). Only the most recent init call is allowed to proceed.
  let initToken = 0;

  let { enabled = $bindable(true) } = $props();

  // Snapshot of performance settings that affect the render loop — read
  // from $state in the $effect (reactive) but copied to a plain variable
  // so animate() doesn't touch $state at 60fps.
  let pauseWhenHidden = settingsStore.settings.performance.pauseWhenHidden;

  // Blending constants resolved lazily (THREE is dynamically imported).
  const NORMAL_BLEND = 1;
  const ADDITIVE_BLEND = 2;

  interface Palette {
    colors: number[][];
    weights: number[];
    gridA: number;
    gridB: number;
    gridOpacity: number;
    blending: number; // 1 = normal, 2 = additive
    opacity: number;
    size: number;
    rotSpeed: number;
  }

  // Per-theme visual palette for the 3D background.
  // Retrowave: neon pink/purple/cyan points + additive glow on a dark void.
  // Ghibli: soft sage/sky/gold/cream points + normal blending on a warm sky —
  // a drifting pollen/dust-in-sunlight feel instead of a synthwave grid.
  function paletteFor(theme: ThemeId): Palette {
    if (theme === "ghibli") {
      return {
        colors: [
          [0.29, 0.55, 0.44], // sage green
          [0.42, 0.64, 0.84], // sky blue
          [0.84, 0.63, 0.23], // sunset gold
          [0.94, 0.90, 0.80], // warm cream
        ],
        weights: [0.35, 0.3, 0.2, 0.15],
        gridA: 0x4a8b6f,
        gridB: 0xa89a7a,
        gridOpacity: 0.18,
        blending: NORMAL_BLEND,
        opacity: 0.55,
        size: 0.7,
        rotSpeed: 0.0003,
      };
    }
    if (theme === "fiesta") {
      return {
        colors: [
          [1.0, 0.0, 0.43], // neon pink
          [1.0, 0.75, 0.04], // amber gold
          [0.98, 0.34, 0.03], // blaze orange
          [0.51, 0.22, 0.93], // electric violet
          [0.23, 0.53, 1.0], // azure blue
        ],
        weights: [0.28, 0.22, 0.2, 0.17, 0.13],
        gridA: 0xff006e,
        gridB: 0x8338ec,
        gridOpacity: 0.32,
        blending: ADDITIVE_BLEND,
        opacity: 0.65,
        size: 0.55,
        rotSpeed: 0.0006,
      };
    }
    return {
      colors: [
        [1.0, 0.18, 0.6], // pink
        [0.5, 0.2, 1.0], // purple
        [0.2, 0.9, 1.0], // cyan
      ],
      weights: [0.4, 0.3, 0.3],
      gridA: 0xff2e9a,
      gridB: 0x7a6aa8,
      gridOpacity: 0.3,
      blending: ADDITIVE_BLEND,
      opacity: 0.6,
      size: 0.5,
      rotSpeed: 0.0005,
    };
  }

  function pickWeighted(weights: number[]) {
    const r = Math.random();
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (r <= acc) return i;
    }
    return weights.length - 1;
  }

  // Quality tier → { particleCount, pixelRatioCap, antialias }
  // "high" matches the original code (2000 particles, DPR 2, AA on).
  // "minimal" is the default — barely-there dots, cheap on any GPU.
  function qualityTier(q: ThreeQuality): { particleCount: number; pixelRatioCap: number; antialias: boolean } {
    if (q === "minimal") return { particleCount: 150, pixelRatioCap: 1, antialias: false };
    if (q === "low") return { particleCount: 400, pixelRatioCap: 1, antialias: false };
    if (q === "medium") return { particleCount: 1000, pixelRatioCap: 1.5, antialias: true };
    return { particleCount: 2000, pixelRatioCap: 2, antialias: true };
  }

  async function init() {
    if (!canvas || !enabled) return;

    // Guard against concurrent init() calls — when presets are clicked
    // rapidly, only the most recent call should proceed.
    const token = ++initToken;

    // Dynamic import — keeps ~600 KB out of the initial bundle.
    if (!THREE_mod) THREE_mod = await import("three");

    // If a newer init() call started while we were awaiting, abort.
    if (token !== initToken) return;

    const T = THREE_mod;

    const pal = paletteFor(currentTheme);
    cachedPalette = pal;

    const tier = qualityTier(currentQuality);

    scene = new T.Scene();
    camera = new T.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 50;

    renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: tier.antialias });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier.pixelRatioCap));

    // Particle field — grid of glowing dots
    const particleCount = tier.particleCount;
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount; i++) {
      const i3 = i * 3;
      positions[i3] = (Math.random() - 0.5) * 200;
      positions[i3 + 1] = (Math.random() - 0.5) * 200;
      positions[i3 + 2] = (Math.random() - 0.5) * 200;

      const c = pal.colors[pickWeighted(pal.weights)];
      colors[i3] = c[0];
      colors[i3 + 1] = c[1];
      colors[i3 + 2] = c[2];
    }

    const geometry = new T.BufferGeometry();
    geometry.setAttribute("position", new T.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new T.BufferAttribute(colors, 3));

    const material = new T.PointsMaterial({
      size: pal.size,
      vertexColors: true,
      transparent: true,
      opacity: pal.opacity,
      blending: pal.blending === ADDITIVE_BLEND ? T.AdditiveBlending : T.NormalBlending,
      depthWrite: false,
    });

    particles = new T.Points(geometry, material);
    scene.add(particles);

    // Grid floor — retrowave style for both, tinted per palette
    const gridHelper = new T.GridHelper(200, 40, pal.gridA, pal.gridB);
    gridHelper.position.y = -30;
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = pal.gridOpacity;
    scene.add(gridHelper);
    grid = gridHelper;

    animate();
  }

  function animate() {
    animationId = requestAnimationFrame(animate);

    // Idle-stop: skip rendering when the tab is hidden. Uses the plain
    // snapshot variable, NOT $state, so we don't trigger reactive tracking
    // at 60fps.
    if (pauseWhenHidden && document.hidden) return;

    const pal = cachedPalette;
    if (!pal) return;

    if (particles) {
      particles.rotation.y += pal.rotSpeed;
      particles.rotation.x += pal.rotSpeed * 0.4;
    }

    if (renderer && camera) {
      // Subtle camera drift
      const t = Date.now() * 0.0001;
      camera.position.x = Math.sin(t) * 5;
      camera.position.y = Math.cos(t * 0.7) * 3;
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    }
  }

  function dispose() {
    // Invalidate any in-flight init() so it aborts after the dynamic import.
    initToken++;
    if (animationId) cancelAnimationFrame(animationId);
    animationId = null;
    if (particles) {
      particles.geometry.dispose();
      (particles.material as THREE.Material).dispose();
      particles = null;
    }
    if (grid) {
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      grid = null;
    }
    if (renderer) {
      renderer.dispose();
      renderer = null;
    }
    cachedPalette = null;
  }

  function onResize() {
    if (renderer && camera) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    }
  }

  onMount(() => {
    init();
    window.addEventListener("resize", onResize);

    return () => {
      dispose();
      window.removeEventListener("resize", onResize);
    };
  });

  // Single reactive effect — reads $state here (reactive context) and
  // copies to plain variables for the animate loop. Rebuilds the scene
  // only when enabled/theme/quality actually change.
  $effect(() => {
    const enabledVal = enabled;
    const themeVal = themeStore.current;
    const qualityVal = settingsStore.settings.performance.threeQuality;
    // Snapshot pauseWhenHidden for the animate loop (avoids $state read at 60fps).
    pauseWhenHidden = settingsStore.settings.performance.pauseWhenHidden;

    if (!enabledVal) {
      if (renderer) dispose();
      return;
    }

    const needsRebuild = themeVal !== currentTheme || qualityVal !== currentQuality;

    if (!renderer && canvas) {
      currentTheme = themeVal;
      currentQuality = qualityVal;
      init();
    } else if (renderer && needsRebuild) {
      // Theme or quality changed while running — rebuild the scene.
      dispose();
      currentTheme = themeVal;
      currentQuality = qualityVal;
      init();
    }
  });
</script>

{#if enabled}
  <canvas id="three-bg" bind:this={canvas}></canvas>
{/if}
