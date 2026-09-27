# Changelog

## 0.2.0 (unreleased)

The first public release.

- All agent CLIs run in disposable Linux guests through Harbor and Apple Container. A shared concurrency limit queues work before creating guests; native automatic permission review runs inside the guest boundary (Codex approve-for-me, Claude auto, Cursor auto-review). Existing credential broker authentication remains on the host.
- Arms can override the task prompt and receive their own frozen input files or directories, including reference pictures. Effective prompts and input names are recorded with revealed results.
- Runtime setup pins Harbor and builds the guest image. `sandbox: false` and host `nodeModules` sharing now give explicit migration errors.

- `crucible run` prepares, produces, judges, reports, and archives an experiment in one command. Each step also has its own command.
- One to ten arms per run, varying a candidate skill, a skill variant, a model, an effort level, an agent (Claude Code, Codex, or Cursor), a skill environment, or a tool (settings file, environment variables, setup command, MCP servers).
- Each guest receives only its assigned frozen files, with no mounted host checkout, home directory, or sibling arm. The judge gets a separate guest containing anonymized outputs. The broker substitutes provider credentials for stand-in tokens on supported API routes; existing cloud-provider and Cursor API-key exceptions remain documented in CREDENTIALS.md.
- A blinded judge that screenshots and scores the outputs against a rubric, or `judge: none` to produce and capture the arms without a verdict. Pictures are full height but never wider than the viewport, image outputs are pictured centred and large, and an output that never renders is archived with the judge's reason in place of a picture. A reported run can be judged again until it is cleaned.
- `crucible ui`, a local dashboard for live runs and archived results. Agent-written pages open sandboxed under a path whose token opens only their own entry, with a content policy that lets them load from this server and a few public library and font CDNs alone; its actions need an `X-Crucible` header. Any HTML page or SVG an arm produced opens live in a viewer, on the captured slide, with arm switching on the same page and a phone-width frame. Results filter by the date of their newest run, and can be selected and deleted in bulk.
- `crucible/store`, the archive and run-record reader behind the dashboard, with `storeRoots()` and a stable `key` per question. A run of one arm is scored, not counted as a win, so a series of them goes to the higher mean total.
- `crucible init`, `doctor`, `config`, `status`, `list`, `series`, `check`, `prune`, and `clean`.
- An agent skill in `skills/crucible` for Claude Code, Codex, and Cursor Agent.
