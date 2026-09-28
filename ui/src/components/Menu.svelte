<script lang="ts">
  import type { Snippet } from "svelte";
  import Icon from "./Icon.svelte";

  // A button that opens a small panel under it: a menu of choices, or a form
  // as small (the date filter's range). The browser's popover does the
  // layering, the outside click and the toggle; this places the panel where
  // it fits, below the button or above it, never past the window's edge, and
  // gives it the keys a menu has. Choices are `.menu-item` elements the
  // caller renders; `close` returns focus to the button.
  let {
    label,
    tip,
    buttonClass = "btn quiet",
    align = "start",
    role = "menu",
    chevron = false,
    button,
    children,
  }: {
    /** The button's accessible name, when its content is not enough. */
    label?: string;
    tip?: string;
    buttonClass?: string;
    /** Which edge of the button the panel lines up with. */
    align?: "start" | "end";
    /** "menu" for a list of choices; "dialog" for a panel with fields in it. */
    role?: "menu" | "dialog";
    /** A text button's down chevron, saying it opens something. */
    chevron?: boolean;
    button: Snippet;
    children: Snippet<[close: () => void]>;
  } = $props();

  const id = $props.id();
  let trigger = $state<HTMLButtonElement | null>(null);
  let panel = $state<HTMLDivElement | null>(null);
  let open = $state(false);

  /** The gap to the button, and the margin kept from the window's edges. */
  const GAP = 4;
  const EDGE = 8;

  function place() {
    if (!trigger || !panel) return;
    const anchor = trigger.getBoundingClientRect();
    panel.style.maxHeight = "";
    const below = innerHeight - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    const height = panel.scrollHeight;
    const up = height > below && above > below;
    panel.style.maxHeight = `${Math.max(120, up ? above : below)}px`;
    const width = panel.offsetWidth;
    const left = align === "end" ? anchor.right - width : anchor.left;
    panel.style.left = `${Math.max(EDGE, Math.min(left, innerWidth - width - EDGE))}px`;
    panel.style.top = up ? `${Math.max(EDGE, anchor.top - GAP - panel.offsetHeight)}px` : `${anchor.bottom + GAP}px`;
  }

  const items = () => [...(panel?.querySelectorAll<HTMLElement>(".menu-item:not([disabled])") ?? [])];

  function ontoggle(event: ToggleEvent) {
    open = event.newState === "open";
    if (!open) return;
    place();
    const all = items();
    (all.find((item) => item.getAttribute("aria-checked") === "true") ?? all[0] ?? panel)?.focus();
  }

  export const focus = () => trigger?.focus();

  function close() {
    panel?.hidePopover();
    trigger?.focus();
  }

  // While open, the panel follows its button through a scroll or a resize.
  $effect(() => {
    if (!open) return;
    addEventListener("scroll", place, true);
    addEventListener("resize", place);
    return () => {
      removeEventListener("scroll", place, true);
      removeEventListener("resize", place);
    };
  });

  function onTriggerKey(event: KeyboardEvent) {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open) {
      event.preventDefault();
      panel?.showPopover();
    }
  }

  /** Focus that leaves for elsewhere on the page takes the panel with it. */
  function onfocusout(event: FocusEvent) {
    const to = event.relatedTarget as Node | null;
    if (to && !panel?.contains(to)) panel?.hidePopover();
  }

  /** Arrows, Home and End move through the choices; a letter jumps to the next that starts with it. */
  function onPanelKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (at + 1) % all.length;
    else if (event.key === "ArrowUp") next = (at - 1 + all.length) % all.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = all.length - 1;
    else if (event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const letter = event.key.toLowerCase();
      const order = [...all.slice(at + 1), ...all.slice(0, at + 1)];
      const match = order.find((item) => item.textContent?.trim().toLowerCase().startsWith(letter));
      if (match) next = all.indexOf(match);
    }
    if (next === null) return;
    event.preventDefault();
    all[next]!.focus();
  }
</script>

<button
  bind:this={trigger}
  class={buttonClass}
  popovertarget="menu-{id}"
  aria-haspopup={role}
  aria-expanded={open}
  aria-controls="menu-{id}"
  aria-label={label}
  data-tip={tip}
  onkeydown={onTriggerKey}
>
  {@render button()}
  {#if chevron}<Icon name="chevron-down" size={12} class="chevron" />{/if}
</button>

<div
  bind:this={panel}
  id="menu-{id}"
  class="menu overlay"
  popover="auto"
  {role}
  aria-label={label ?? tip}
  tabindex="-1"
  {ontoggle}
  onkeydown={onPanelKey}
  {onfocusout}
>
  {@render children(close)}
</div>
