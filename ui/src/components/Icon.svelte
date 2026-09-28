<script lang="ts" module>
  // Every stroked glyph in the dashboard, on one 16 grid and one stroke.
  // 14 inside a control, 12 beside a word. The brand mark and the chart are
  // drawn where they live; the select chevron and checkbox marks are CSS.
  const PATHS = {
    "chevron-left": "M10 3.5 5.5 8l4.5 4.5",
    "chevron-right": "M6 3.5 10.5 8 6 12.5",
    "chevron-down": "M4 6.5 8 10.5 12 6.5",
    "arrow-down": "M8 3v10M3.5 8.5 8 13l4.5-4.5",
    close: "M4 4l8 8M12 4l-8 8",
    reload: "M13.25 8A5.25 5.25 0 1 1 11.7 4.3 M12.5 1.75V4.5H9.75",
    check: "M3.5 8.5 6.5 11.5 12.5 4.5",
    report: "M4 1.75h5.25L12.5 5v9.25H4Z M9 1.75V5h3.5 M6.25 8.5h3.75 M6.25 11h3.75",
    folder: "M1.75 3.75a1 1 0 0 1 1-1h3.5l1.5 1.75h5.5a1 1 0 0 1 1 1v6.75a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1Z",
    trash: "M2.5 4.25h11 M6.25 4.25v-1.5h3.5v1.5 M3.75 4.25l.75 9.25h7l.75-9.25 M6.5 7v4 M9.5 7v4",
    image: "M3.25 2.5h9.5a.75.75 0 0 1 .75.75v9.5a.75.75 0 0 1-.75.75h-9.5a.75.75 0 0 1-.75-.75v-9.5a.75.75 0 0 1 .75-.75Z M2.5 11l3.25-3.25 2.75 2.75 1.75-1.75 3.25 3.25 M9.25 5.75a1 1 0 1 0 2 0a1 1 0 1 0-2 0",
    live: "M4.5 2.5v10.5l2.9-2.75 1.85 3.9 1.7-.8-1.85-3.85h3.9Z",
    keyboard: "M2.25 3.75h11.5a.75.75 0 0 1 .75.75v7a.75.75 0 0 1-.75.75H2.25a.75.75 0 0 1-.75-.75v-7a.75.75 0 0 1 .75-.75Z M4.5 6.5h.01 M7 6.5h.01 M9 6.5h.01 M11.5 6.5h.01 M5 9.5h6",
    desktop: "M2.75 2.75h10.5a.75.75 0 0 1 .75.75v6.75a.75.75 0 0 1-.75.75H2.75a.75.75 0 0 1-.75-.75V3.5a.75.75 0 0 1 .75-.75Z M5.5 13.75h5 M8 11v2.75",
    phone: "M5 1.75h6a.75.75 0 0 1 .75.75v11a.75.75 0 0 1-.75.75H5a.75.75 0 0 1-.75-.75v-11A.75.75 0 0 1 5 1.75Z M7.25 12h1.5",
    expand: "M9.5 2.5h4v4 M13.5 2.5 9 7 M6.5 13.5h-4v-4 M2.5 13.5 7 9",
    external: "M9.5 2.5h4v4 M13.5 2.5 7.5 8.5 M11.5 9.5v3.25a.75.75 0 0 1-.75.75h-7.5a.75.75 0 0 1-.75-.75v-7.5a.75.75 0 0 1 .75-.75H6.5",
    "theme-system": "M8 2.5a5.5 5.5 0 1 0 0 11Z M8 2.5a5.5 5.5 0 1 1 0 11",
    "theme-light": "M8 5.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 1 0 0-5.5Z M8 1.5v1.5 M8 13v1.5 M1.5 8H3 M13 8h1.5 M3.4 3.4l1.06 1.06 M11.54 11.54l1.06 1.06 M3.4 12.6l1.06-1.06 M11.54 4.46l1.06-1.06",
    "theme-dark": "M13.5 9.6A5.5 5.5 0 0 1 6.4 2.5a5.5 5.5 0 1 0 7.1 7.1Z",
  };
  export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
  let { name, size = 14, class: className = "" }: { name: IconName; size?: 14 | 12; class?: string } = $props();
</script>

<svg class={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={PATHS[name]} /></svg>
