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
    // If UI-entered API key was persisted, push it to the server so it
    // overrides the env var for this session.
    const storedKey = settingsStore.settings.openrouterApiKey;
    if (storedKey) {
      fetch("/api/settings/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: storedKey }),
      }).catch(() => {});
    }
    // Check if a local model server is still running from a previous
    // session and reconfigure the provider's local routing. This handles
    // page reloads while using a local model.
    fetch("/api/local/providers")
      .then((r) => r.json())
      .then((data) => {
        const providers = data.providers ?? [];
        for (const p of providers) {
          if (p.serverRunning && p.servedModel) {
            // Reconfigure the local endpoint for the running model
            fetch("/api/local/serve", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                providerId: p.id,
                modelId: p.servedModel,
                singleModel: false, // don't stop other servers on reload
              }),
            }).catch(() => {});
            break;
          }
        }
      })
      .catch(() => {});
    // Animate layout in
    gsap.from(".app-container", { opacity: 0, duration: 0.6, ease: "power2.out" });
  });
</script>

<ThreeBackground enabled={settingsStore.settings.threeEnabled} />

<div class="app-container relative z-10 h-screen w-screen flex flex-col overflow-hidden">
  {@render children()}
</div>
