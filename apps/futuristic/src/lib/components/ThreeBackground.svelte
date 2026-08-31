<script lang="ts">
  import { onMount } from "svelte";
  import * as THREE from "three";
  import { themeStore } from "@adaan/core";
  import type { ThemeId } from "@adaan/core";

  let canvas: HTMLCanvasElement | null = $state(null);
  let renderer: THREE.WebGLRenderer | null = null;
  let animationId: number | null = null;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let particles: THREE.Points | null = null;
  let grid: THREE.GridHelper | null = null;
  let currentTheme: ThemeId = themeStore.current;

  let { enabled = $bindable(true) } = $props();

  // Per-theme visual palette for the 3D background.
  // Retrowave: neon pink/purple/cyan points + additive glow on a dark void.
  // Ghibli: soft sage/sky/gold/cream points + normal blending on a warm sky —
  // a drifting pollen/dust-in-sunlight feel instead of a synthwave grid.
  function paletteFor(theme: ThemeId) {
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
        blending: THREE.NormalBlending,
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
        blending: THREE.AdditiveBlending,
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
      blending: THREE.AdditiveBlending,
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

  function init() {
    if (!canvas || !enabled) return;

    const pal = paletteFor(currentTheme);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 50;

    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Particle field — grid of glowing dots
    const particleCount = 2000;
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

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: pal.size,
      vertexColors: true,
      transparent: true,
      opacity: pal.opacity,
      blending: pal.blending,
      depthWrite: false,
    });

    particles = new THREE.Points(geometry, material);
    scene.add(particles);

    // Grid floor — retrowave style for both, tinted per palette
    const gridHelper = new THREE.GridHelper(200, 40, pal.gridA, pal.gridB);
    gridHelper.position.y = -30;
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = pal.gridOpacity;
    scene.add(gridHelper);
    grid = gridHelper;

    animate();
  }

  function animate() {
    animationId = requestAnimationFrame(animate);
    const pal = paletteFor(currentTheme);

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
    if (animationId) cancelAnimationFrame(animationId);
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

  $effect(() => {
    const enabledVal = enabled;
    const themeVal = themeStore.current;
    // Read both so the effect re-runs on either change.
    void enabledVal;
    void themeVal;

    if (!enabledVal) {
      if (renderer) dispose();
      return;
    }

    if (!renderer && canvas) {
      init();
    } else if (renderer && themeVal !== currentTheme) {
      // Theme changed while running — rebuild the scene with the new palette.
      dispose();
      currentTheme = themeVal;
      init();
    }
  });
</script>

{#if enabled}
  <canvas id="three-bg" bind:this={canvas}></canvas>
{/if}
