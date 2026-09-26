<script lang="ts">
  import type { Snippet } from "svelte";

  // One of a Menu's exclusive choices, the chosen one checked.
  let { checked, onchoose, children }: { checked: boolean; onchoose: () => void; children: Snippet } = $props();
</script>

<button class="menu-item" role="menuitemradio" aria-checked={checked} tabindex="-1" onclick={onchoose}>
  <svg class="check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" /></svg>
  {@render children()}
</button>
