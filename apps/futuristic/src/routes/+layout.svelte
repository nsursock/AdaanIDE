<script lang="ts">
  import "@fontsource/jetbrains-mono/400.css";
  import "@fontsource/jetbrains-mono/500.css";
  import "@fontsource/jetbrains-mono/600.css";
  import "@fontsource/jetbrains-mono/700.css";
  import "@fontsource/jetbrains-mono/800.css";
  import "../app.css";
  import { themeStore, settingsStore } from "@adaan/core";
  import { onMount } from "svelte";
  import ThreeBackground from "$lib/components/ThreeBackground.svelte";
  import { gsap } from "gsap";

  let { children } = $props();

  onMount(() => {
    themeStore.init();
    settingsStore.init();
    // Animate layout in
    gsap.from(".app-container", { opacity: 0, duration: 0.6, ease: "power2.out" });
  });
</script>

<ThreeBackground enabled={settingsStore.settings.threeEnabled} />

<div class="app-container relative z-10 h-screen w-screen flex flex-col overflow-hidden">
  {@render children()}
</div>
