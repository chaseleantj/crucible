# Harbor stress validation — 27 September 2026

All 12 experiments completed and were archived: 40 producer arms, 44 viewable artifacts, and 92 desktop/phone captures. These are tiny workflow checks based on the earlier writing/humanizer and dandelion experiments, not model-quality benchmarks.

## Coverage

| Case | Arms | Run | Coverage |
| --- | ---: | --- | --- |
| 01 | 6 | `ab-4ed6b38d` | Three harnesses × clean/realistic context; write-like-me; short Markdown rewrite |
| 02 | 3 | `ab-59e962b4` | Same task across all three harnesses; exactly two SVGs |
| 03 | 3 | `ab-4821f9a9` | Codex prompt variants and picture/no-picture inputs |
| 04 | 3 | `ab-1055f024` | Claude arms with different tasks and one common rubric |
| 05 | 3 | `ab-f4b1d683` | No skill, miniature writing skill, and an identical-skill replicate |
| 06 | 10 | `ab-901eb6c9` | Ten tiny arms across Claude, Codex, and Cursor |
| 07 | 2 | `ab-6dd8d106` | Claude/Codex interactive Three.js dandelion; local dependency |
| 08 | 2 | `ab-4c763369` | Setup command and environment variable; setup-file withholding |
| 09 | 3 | `ab-bc081e01` | Native subagent calls on all three harnesses |
| 10 | 2 | `ab-335df918` | Unjudged Markdown on Claude and Cursor |
| 11 | 2 | `ab-ad849039` | Baseline skill versus same-name replacement skill |
| 12 | 1 | `ab-804f0fd5` | Unjudged pair of SVGs on Cursor |

Models: Claude Sonnet 5 low, Codex gpt-6-sol low, and Cursor Grok 4.7 low. Native automatic permission review stayed enabled. Judging also exercised all three harnesses. Most guests used one CPU and 2048 MiB; the 3D case used two CPUs and 4096 MiB. The test override allowed six concurrent guests across experiments. Twenty-three samples observed a maximum of six and no excess; the normal two-guest default is unchanged.

## Findings and fixes

- Fixed a worker drain race that could return empty or truncated stdout when a command finished during polling. The affected Cursor arm passed on retry. Model-discovery diagnostics are now saved, and Cursor must resolve the exact requested effort instead of silently falling back.
- Added unjudged Markdown and SVG captures, Markdown viewing in the dashboard, and preservation of unjudged deliverables beyond the preview limit. The affected runs were recaptured and archived.
- Queued guests now display as waiting or preparing instead of appearing stalled before their agent starts.
- One judge omitted `artifact` from its Markdown screenshot entries. Its native capture script was verified to read `answer.md` for every arm; only that metadata was repaired, preserving originals. The judge prompt now explicitly requires the original Markdown filename. Archive validation correctly refused the incomplete metadata.

The setup test has one expected warning: its setup-created file was withheld from the reading copy because the producer did not author it. No other archived run has warnings.

## Verification

- `npm test`: 182 passed, zero skipped; includes CLI/UI builds and browser regressions.
- Python runtime suite: 10 passed. Final CLI compilation and `git diff --check` passed.
- `crucible check` over all 12 entries: zero problems.
- Playwright opened every artifact in the actual Crucible viewer at desktop and phone widths, verified image loading and Markdown content, and verified both 3D canvases change on drag. No page errors. Representative writing, ten-arm comparison, SVG, and 3D screenshots were visually inspected.
- Every arm has recorded wall time and native token counters. Producer totals: 727.441 seconds, 260,698 input tokens, 16,190 output tokens, 1,519,507 cache-read tokens, and 61,023 cache-write tokens. These are native counters with provider-specific semantics, not normalized billing or total experiment cost; judge work and retries are excluded.
- `container list --format json` returned `[]` after completion.

## Evidence availability

These live tests ran on the maintainer's Apple silicon Mac. Reports, outputs, screenshots, frozen inputs, and native transcripts are retained locally; they are not included in this repository. The run IDs above identify those records. This report summarizes the observed results and does not establish successful installation on another machine.
