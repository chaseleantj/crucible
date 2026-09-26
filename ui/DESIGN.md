# Dashboard design

`crucible ui` is a local, read-mostly dashboard for one person's A/B tests. Its
primary job: show whether anything is running and healthy, and let you open
any result to see the arms side by side with the evidence behind the verdict.
It is a daily tool, so it is dense and quiet.

## Theme and vocabulary

- The theme: Manrope, a cool neutral ground, hairline surfaces with no
  resting shadows, and no hue except semantic ones. Emphasis is inversion
  (the ink colour as a fill), not colour.
- Two themes, one shape: night (near-black ground) and day (cool paper
  ground, white surfaces). Day is designed, not inverted: semantic colours
  are darkened to hold 4.5:1 on every surface, and captures get a firmer
  frame so a white page does not dissolve into the ground. Only colours
  differ, declared once per theme in `app.css`.
- The mark (brand/logo) is the one exception to "no hue": its orange melt
  appears in the mark and nowhere else. The top bar sets the 16 cut beside
  the 15px name, in the theme's tones; the favicon picks the 16 or 32 cut by
  size.
- There is no accent colour. Emphasis is ink: the page's one primary action
  (Open report) is ink-filled like a chosen segment, the current selection
  (the keyboard's row, the run shown in a series) has a 2px ink edge, a
  ticked box is ink-filled, and the winner is inverted. Focus is neutral: a
  2px `--focus` ring (the muted tone) for the keyboard only, and a text
  field, which the browser marks as keyboard-focused even on a click, shows
  focus by a firmer edge instead of a ring. Data is never coloured: margin,
  score, time and token bars are neutral.
- Controls are squared at 6px (`--radius-control`), not pills. A button is
  an outline by default and quiet (no edge until hovered) for chrome: the
  top bar's icons, the pager, menus. Segmented controls are kept for tiny
  exclusive sets (Captures or Live, Desktop or Phone); filters over the list
  are tabs, plain words with the chosen one in ink on an ink rule.
- One menu (`Menu.svelte`) for every choice behind a button: the theme, the
  rows per page, the page of rows, the dates. It opens below its button or
  above when there is more room, stays inside the window, and takes arrows,
  Home, End, a first letter, and Esc.
- Tabular figures for every number that is compared; mono only for numbers.
- A 4-based spacing scale and a small type ramp, declared once as tokens.
- The data model and its words: questions (a series or a lone run), tallies,
  mean totals, "Not judged", the health states and their thresholds.

## Design decisions

- **No side rail, command palette, or icon clusters for paths.** One tool
  needs one top bar. Path actions live once, in a run's detail.
- **A table, not cards.** With 100+ questions, 40px rows with a small
  capture, the title, then verdict, margin (figure and a neutral bar on one
  scale for the whole list), arms, runs, judge and date fit 17 or more per
  screen. Question, margin, arms, runs and date sort from their headers;
  All, Judged, Not judged and Series filter. A narrower window folds arms,
  runs and judge (then the verdict) into a line under the title rather than
  dropping them. The title's link covers its row; the one other control is
  the row's box, which shares the capture's slot (the capture at rest, the
  box under the pointer, on the keyboard's row, and while anything is
  chosen; always the box where captures fold away).
- **Dates filter on the newest run.** One quiet button beside the tabs
  ("Any time", "Last 7 days", "Sep 1 – Sep 21") opens presets (last 7 or 30
  days, this month) and a custom range of whole local days, either end
  open; the panel says it goes by each question's newest run, the table's
  Date. It narrows the list like search: the tabs count what is left, and
  a clear button sits beside it while it is on. In the address as
  `date=7d` or `date=custom&from=…&to=…`; a change starts at page 1.
- **Select, then delete in bulk.** A box per row, shift for a range, the
  header's box for the page, then "Select all N" for every match. While
  anything is chosen the tabs give way to "N selected · Select all N ·
  Delete… · Clear". Paging and sorting keep the selection; a change to what
  matches (search, tab, dates) clears it, so nothing chosen is ever out of
  sight when it is deleted, rather than a count of hidden rows to explain.
  Delete asks the store first (a dry run through the same `deleteEntries`
  policy) and lists each result with what it takes, every archived run and
  run record, and what the store would refuse; Cancel has focus. Each
  result goes whole or not at all: a partial delete says "Deleted 2 of 3",
  names what was kept and why, and leaves it chosen.
- **The verdict leads a question.** One strip: title; the verdict in one
  line, with a series' margin on mean totals and any caveat (a leader missing
  from runs, judges that differ; "leads … runs split" when a series
  disagrees); the task folded to one line; actions on the right.
- **Each fact once, where a reader looks for it.** Confidence and the judge
  are the run's facts, beside the judge's reasoning. A series dates its runs
  in the runs table (no run heading repeats the date and score); a lone run
  has Reported in its facts. Totals live in the criteria table's last row
  and the runs table, not in the arm headers. The capture opens the viewer,
  so an arm's foot links only what nothing else reaches: Open output for an
  arm with no page, Full window while Live.
- **Scores are evidence.** The criteria table marks each row's best cell
  with weight and a neutral ground, makes the weighted total the strongest
  row, and adds each arm's difference from the reference arm (the first, the
  control). A series adds a dot plot of each arm's totals across runs with
  its mean, the leader in ink and the run shown ringed; it is SVG with a text
  summary and no legend (a dot's tooltip names its run, the tick its mean),
  and the runs table beside it holds every value. The plot shows spread, so
  it appears only when some arm has two scored runs or more.
- **Detail is a page with a URL, not a modal.** `#/q/<key>/<run>` survives a
  reload and the back button, and has room for the arms.
- **Arms side by side, aligned by page.** One page control drives every arm
  while "Sync pages" is on (each column gets its own when it is off), with a
  desktop/phone switch. Columns never wrap: past four arms they scroll
  sideways, a column at a time, under a pinned header strip (name and the winner) that follows them.
  "Sync pages" shows only with two arms or more.
- **Live in place.** "Live" swaps each capture for the page itself, drawn at
  a real window's width and scaled to its column. Synced, the arrow keys and
  the slide buttons (shown only when a capture names a slide or a fragment,
  so an SVG or a cube gets none) turn every deck, and an arrow pressed inside one deck is
  relayed to the rest through the viewer's bridge (see VIEWER_BRIDGE).
- **A keyboard model.** j and k move through the list and through a
  series' runs, Enter opens, x ticks the row's box, Esc clears a selection
  or goes back, the arrows turn pages and slides, / searches, and ? shows
  the sheet of all of them. Opening a result
  from the keyboard and coming back focuses the same row.
- **Running tests are visible from every page.** A pill in the top bar
  counts them, its dot taking the worst agent's state, and links to the
  running section: per run a produce, judge, report stepper and a row per
  agent (state, time, tool calls, last activity), "updated N s ago" above.
- **Live pages in a viewer with a URL, over the question.**
  `#/q/<key>/<run>/view/<arm>/<page>` (`?phone` for the narrow frame)
  survives a reload and can be shared, like the question itself; the
  question stays mounted underneath, so closing keeps its scroll and page
  picker. Opening pushes one history entry; switching arm, page, or width
  rewrites it in place, and closing goes back to the entry it came from
  (found through the Navigation API, since a deck's own hash changes add
  entries), or replaces itself with the question when loaded directly.
  Captures stay the side-by-side overview; a capture opens its page live on
  the captured slide. Switching arms keeps the same page: the other arm's
  capture of it, else the same file, else that arm's main page, with a note.
- **The frame is sandboxed to scripts and forms, never same-origin.** Focus
  moves into it on load so a deck's keys work at once. The one script the
  viewer puts inside a page relays Escape and the files it could not load;
  it is the fragile part (see VIEWER_BRIDGE in src/ui.ts). A page that
  navigates within the frame loses it; the close button still works.
- **Criteria are shown, not folded.** In a dedicated tool the scores are the
  evidence, not a detail.
- **Visible focus.** Focus rings stay on.
- **Theme follows the system until chosen.** One icon button in the top
  bar opens System, Light and Dark; the choice is kept in localStorage; index.html applies it
  before the first paint, so a reload never flashes the other theme.
- **Results page on the client, with the pager above the list.** The
  snapshot already holds every row, so search matches across all of them
  and a page turn costs no request. 20, 50 or 100 per page; the pager
  ("1–20 of 111", a menu of the other pages, previous and next, rows per
  page) is pinned under the top bar and hidden when everything fits on the
  smallest page. A phone keeps the smallest page, so the rows-per-page
  choice goes below 640px rather than crowd the paging off its row. Search and page live in the address (`#/?q=…&page=2&size=50`),
  rewritten in place so back leaves the list instead of stepping through it.
  A new search starts at page 1; a new page size keeps the first row shown.
- **Amber as a semantic colour** so a quiet agent is distinct from a
  stalled one (red).

## Pages

1. **Home** (`#/`). Top bar: mark and name, the running pill when anything
   runs, shortcuts, the theme menu. Results head: search. Then, only when
   present: *Running*, one block per run with its stepper and a row per
   producer and the judge. Then *Results*: the tabs, the dates and the pager
   in one bar pinned above the table (the selection's actions in place of
   the tabs and dates while anything is chosen), then the table, newest first unless sorted. Then
   *Unfinished runs*, folded.
2. **Question** (`#/q/<key>/<runId>`). The verdict strip with the run's
   actions (open report, reveal in Finder, delete); for a series, the runs
   table (mean row strongest) and the score-by-arm plot. Then the chosen run:
   the page control, arms in columns with captures or live pages, then
   criteria and time and tokens, the judge's summary and control guess, the
   run's facts and warnings.
3. **Viewer** (`#/q/<key>/<run>/view/<arm>/<page>`). A full-window layer
   over the question: close, the arm with previous and next, the page
   picker, desktop or phone width, reload, open in a new tab; then the
   page.

## States

| View | Empty | Loading | Error | Partial | Long |
| --- | --- | --- | --- | --- | --- |
| Home | First run: what Crucible is, `crucible init`, `crucible run`, where results will appear. Search, tab or dates with no match: say which, offer to clear each. | Skeleton rows in place, after 150 ms. | What failed and the command to run (`crucible ui` when unreachable, `crucible check` when reading failed), with retry; loaded data stays under a banner saying when it is from. | Reports without result.json: row that opens the report. | 90-char titles wrap to two lines. More than 20 rows page; an address past the end shows the last page. |
| Running | Section absent. | — | Stale poll marked with time of last update. | Agent not started: "waiting to start". | 6 producers + judge. |
| Question | Unknown key: "not found", back link. | Same as home (one fetch). | Same as home. | Unjudged run; arm with no capture or no HTML to run live; no phone capture; no cost; a series with no judged run has no plot. | 7 arms scroll sideways four at a time; arm names wrap at hyphens in table heads; long criteria wrap. |
| Viewer | Arm with no HTML: say so, link its document. Unknown page: say so, offer the arm's main page. | "Loading <page>…" over the frame after 150 ms; the page shows as it arrives. | Files the page could not load, or hosts the sandbox refused, named in a note under the bar. | Arm switch that found no matching page: a note says which page is shown instead. | Page paths truncate in the picker; below 560 px the bar is two rows and the width switch goes. |
| Delete | — | Button busy, dialog stays. | Refusal shown in the dialog. | Active run: disabled, reason shown. | — |
| Bulk delete | — | "Checking…" per result after 150 ms while the store is asked; Delete waits. | A failed request stays in the dialog, nothing removed. | Results the store refuses are listed with the reason and kept; the button says "Delete 2 of 3 results"; afterwards "Deleted 2 of 3" names what stayed. | The list scrolls inside the dialog; long titles wrap. |
