<script lang="ts">
  import { onMount } from "svelte";
  import gsap from "gsap";
  import type { Snippet } from "svelte";

  let {
    label,
    index = 0,
    children,
    icon,
  }: { label: string; index?: number; children?: Snippet; icon?: Snippet } = $props();

  let cardEl = $state<HTMLElement | null>(null);

  onMount(() => {
    if (!cardEl) return;
    gsap.from(cardEl, {
      y: 30,
      opacity: 0,
      scale: 0.95,
      duration: 0.6,
      delay: index * 0.08,
      ease: "power3.out",
    });
  });
</script>

<div class="metric-card" bind:this={cardEl}>
  <div class="card-head">
    <div class="card-label">
      <span class="label-bar"></span>
      {label}
    </div>
    {#if icon}
      <span class="card-icon" style="display:flex;align-items:center;">
        {@render icon()}
      </span>
    {/if}
  </div>
  {@render children?.()}
</div>
