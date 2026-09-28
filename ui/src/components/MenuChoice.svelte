<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  // One of a Menu's exclusive choices, the chosen one checked.
  let { checked, onchoose, children }: { checked: boolean; onchoose: () => void; children: Snippet } = $props();
</script>

<button class="menu-item" role="menuitemradio" aria-checked={checked} tabindex="-1" onclick={onchoose}>
  <Icon name="check" class="check" />
  {@render children()}
</button>
