# Experiment file reference

An experiment file is a YAML file that describes one A/B test: the arms, the project each arm works on, the task, the agents, and the judge. `crucible init` writes a commented starter file (the same as [`example.yaml`](../example.yaml)), and `crucible run <file>` runs it.

This page describes every field. The [README](../README.md) has the short version.

## A complete example

```yaml
name: Frontend skill comparison
# series: frontend-skill       # group repeated runs of one question for `crucible series`

arms:                          # 1 to 6 arms; the first is the one the others are compared against
  - label: without-frontend-design  # label is optional everywhere; the default says what the arm varied
  - label: with-frontend-design
    candidate:
      path: ~/.claude/skills/frontend-design
      dependencies: []
  # - candidate: {path: ./frontend-design-v2, replaces: frontend-design}  # a variant of a baseline skill
  # - producer: {model: <larger-model>}                          # a model or effort override
  # - producer: {agent: codex, model: <codex-model>}             # another harness
  # - environment: clean                                        # this arm alone in clean mode
  # - producer: {settings: ./rtk-hooks.json}                     # hooks for this arm alone
  # - producer: {env: {PATH: /opt/homebrew/bin:$PATH}}           # extra environment variables
  # - producer: {setup: graphify build .}                        # built in the project first

source:
  path: ~/code/example-project
  include:
    - package.json
    - src/**/*
    - public/**/*

task: >-
  Improve the WebGL experience. Preserve the existing product behavior and
  verify the result with the project's normal checks.

producer:
  agent: claude # claude, codex, or cursor; all support frozen subagents
  model: <producer-model>
  effort: high
  timeout: 120m

skills:
  environment: realistic # realistic or clean; the default for arms that do not set their own
  root: ~/.claude/skills # default from your config
  shared: true # the configured shared folders for clean arms too; false for none; or list folders; unset, realistic arms only
  excludeCategories: [] # replaces the configured categories
  exclude: [] # adds to the configured names

subagents:
  root: ~/.claude/agents
  exclude: []

sandbox: true

judge:                         # `judge: none` instead of this block runs the arms without a verdict
  agent: claude
  model: <judge-model>
  effort: high
  timeout: 30m
  rubric: ./rubric.md

archive: true # copy the finished run into the archive; --no-archive skips it for one run
cleanup: manual # manual or automatic
```

## What each arm receives

### The project

`source.include` is an allowlist. Version-control data, agent configuration folders, dependencies, handoffs, rubrics, and old assignment files are excluded even when a broad pattern selects them. A project's `.gitignore` is copied whether or not a pattern selects it, since what the project does not track is not an arm's work either. A project's own `CLAUDE.md` and `AGENTS.md` are copied like any other selected file, and the producer's prompt quotes them from the copy, so instructions a setup step adds are honoured too. The prompt is the only place they reach the model: the producer runs with `--setting-sources ""`, which keeps the CLI from loading `CLAUDE.md` itself, so nothing is shown twice.

### Skills: realistic and clean mode

`skills.environment` decides which of your skills an arm starts with. Realistic mode, the default, gives every arm the same frozen copy of the skills under `skills.root`, the way a normal session would have them. A skill folder linked into the root from elsewhere counts, and is frozen from its target; a link back into the root, or a dangling one, is skipped. Skills can be withheld from every arm by category: `skills.excludeCategories` is read against each skill's own `category` frontmatter, so a new skill in an excluded category is withheld without anyone editing a list. Skills that manage your own setup, including `crucible` itself, are the usual candidates. `skills.exclude` withholds skills by name. Preparation resolves the categories to the names actually withheld and records that merged list in the run's `resolved-config.json`; the report lists it too. Clean mode supplies no baseline skills. In either mode, an arm's candidate and its declared dependencies reach that arm alone. Do not declare an ordinary global skill as a dependency in realistic mode: every arm already has it, and preparation stops rather than hand it to one arm alone.

In clean mode an arm gets its own candidate and that candidate's declared dependencies, and nothing else. There are no baseline skills, no subagents, and no shared folders.

`skills.environment` is the default; an arm may set its own `environment: realistic` or `environment: clean`, which is how one run asks whether the surrounding skills help a skill. Every realistic arm gets the same frozen baseline, and preparation checks that they match; clean arms are checked to have none. A clean arm may name a shared-folder file, ordinary skill, or baseline critic as a candidate dependency even when realistic arms already have it: realistic arms keep their copy, and that file is not treated as the clean arm's leaked material. A realistic arm naming its own baseline is still refused. `result.json` records `environment: mixed` for such a run and each arm's own `environment`, and the report lists them per arm. A `reuse` arm keeps the environment it ran in and may not set one.

### Shared guidance folders

Skills often point at shared guidance kept outside any one skill, such as a folder of writing or code standards and a folder of visual styles. List those folders under `skills.shared` in your config and every realistic arm gets a frozen copy of each, under `shared/<folder name>/` in its context; the producer is told to read each copy in place of the live folder its skills name. Two shared folders may not have the same name. A configured folder that does not exist stops preparation rather than start arms without the guidance their skills point at.

Clean arms get no shared folders. Two things change that. The first is `skills.shared` in the experiment: `true` gives the configured shared folders to every arm, clean ones included, and a list gives exactly those folders to every arm. `false` gives no arm any shared folder, realistic ones included.

The second is a dependency that sits directly inside a folder named like a shared one: with a shared `standards` folder configured, `~/agent-guides/standards/frontend.md` or `~/drafts/standards/frontend.md`. It reaches its own arm alone, under the same `shared/standards/` layout, so the redirect in the frozen skills finds it. The rule is the name of the folder holding the dependency, nothing deeper. This works the same way in realistic mode, where it adds one file or folder on top of the shared snapshot every arm already has. Naming a file that the arm's shared folders already hold stops preparation, the way an ordinary baseline skill does. The producer is told about a redirect only for the shared folders its arm holds, and the report records what shared material each arm ended up with.

### Subagents

Subagents (critic and reviewer agent definitions) follow the same model as skills, following each arm's environment: every realistic arm gets the same baseline definitions from `subagents.root`, a clean arm gets none, and names in `subagents.exclude` are withheld from every arm. A candidate dependency ending in `.md` is treated as a subagent definition and frozen for its own arm only — the way to test a skill together with the critic it uses. Claude producers load these definitions as a session plugin directory (`--plugin-dir`) inside the arm's private runtime folder, so the Task tool sees them as `frozen:<name>`; the arm's model and effort travel in its settings file. Nothing on argv names the arm, because the sandbox hides sibling files but not the process table. Codex producers use native `spawn_agent` with the frozen definition path and a fresh context, inheriting the producer's model and effort. The runner explicitly enables Codex multi-agent tools while keeping user configuration ignored and the arm's sandbox intact. Claude frontmatter tool lists and model aliases are not translated to Codex settings; Codex follows the definition's prose using native tools. Independent review is requested by the prompt, so check the transcript to confirm the candidate actually performed it. Codex collaboration calls appear in events.jsonl as tool calls naming the tool, the receiver threads, and their states; Codex 0.153.4 `exec --json` emits no item for the spawn itself and its wait items list no receivers, so a Codex transcript can show that the producer waited but cannot prove which child answered. Reported Codex usage remains the CLI's parent-stream usage; child usage is not separately collected.

Cursor producers register frozen definitions through an isolated session plugin (`--plugin-dir`) and delegate through the native Task tool using the plain reviewer name. Cursor plugin agents inherit the producer's model and effort; Claude model aliases and tool lists in definition frontmatter do not override them. No subagent exclusions are needed. Check the native transcript for the Task call and its completed child result; a parent's claim to have delegated is not sufficient. Cursor usage is whatever the CLI reports; the runner does not separately collect child usage.

## Comparing two versions of one skill

To compare variants of one skill, point an arm's `candidate.path` at the variant and set `candidate.replaces` to the skill's name. Every other arm keeps the frozen baseline copy from `skills.root`; this arm gets the variant under the same name, so all arms see the same skill list and only its content differs. This works in clean mode too, where the replaced skill is the only one any arm receives. An explicit `candidate.replaces` overrides exclusions for that skill, including configured ones; all unrelated exclusions still apply. The variant must keep the baseline's `name`, and preparation stops if no baseline skill has that name. Because every arm knows the skill by name, the leak checks for a replacement look only for the variant's path and for files that differ from the baseline.

## Reusing a previous output as a fixed benchmark

To hold a previous output fixed, set an arm to `reuse: {run: ab-12345678, arm: previous-label}` instead of `candidate` or `producer`. The experiment needs a judge of its own: a reuse arm in an experiment with `judge: none` is refused when the file loads, since a fixed benchmark means nothing with nothing scored beside it. Preparation then requires a successfully judged historical run and a completed, non-timeout producer with the exact same task and frozen source, and names the run when it was never judged — a run whose own experiment set `judge: none` is one of those. It copies the retained anonymous judge input, verifies it against the manifest recorded before judging, and carries historical identity findings forward. Mutable producer workspaces are never reused. Older runs without that manifest must be rejudged. Prepare before cleaning the historical judge workspace; a prior reused snapshot is sufficient after cleanup only when it matches the judged manifest. The snapshot survives subsequent cleanup; its hash and original producer identity are recorded. No producer or setup runs for this arm, and its old time and tokens are not charged again. Fresh judges still inspect and capture every output anonymously. Reports explicitly call this a fixed historical benchmark, not an independent producer sample; repetitions only resample the fresh arms and judge. Use this deliberately when a fixed benchmark is useful, not as a claim of matched independent A/B evidence.

## Arm labels and series

An arm's `label` names it wherever a result is shown or archived: in `result.json`, the reports, `crucible list`, and the output folders of an archive. The default says what that arm varied: `with-<skill>` for a candidate, `<skill>-variant` for a replaced skill, the agent, model, and effort for a producer override, with `-<environment>` appended when the arm sets its own environment, and `without-<skill>` or `baseline` for an arm that varies nothing. An override that names neither model nor effort is labelled after its settings file without the extension, its first extra variable, or its setup command's own name. Labels must be unique, so two arms whose defaults collide have to be labelled by hand. `series` groups repeated runs of the same question so `crucible series <name>` can tally them; runs in one series should share the task and rubric.

## Comparing models, effort levels, and harnesses

To compare models or effort levels, give each arm a `producer` block with a `model` or `effort` and no candidate. The timeout stays shared, every arm gets the same frozen skills, and the only clue the leak checks look for is the run directory itself.

To compare harnesses, such as Claude Code against Codex, give an arm `producer.agent` along with a model that agent accepts; `start` checks every agent's CLI and login before launching anything. Each arm keeps the shared fields it does not override, so set `model` and `effort` on every arm that changes agent, since model names and effort levels are not portable between CLIs. Agent-specific fields follow the arm: `settings` needs a Claude arm and `mcpServers` a Claude or Codex arm. Blinding stays procedural: an output can still betray its harness through file conventions such as `AGENTS.md`. Usage is whatever each CLI reports, so token counts across harnesses are not strictly comparable. An arm can combine a producer override with a candidate, but then the result cannot separate the two effects.

Two arms may carry the same candidate and the same producer settings: that is a replicate, one way to see how much of a difference is run-to-run variation. Their default labels would collide, so each replicate has to be labelled by hand; the error says so. A run may also have a single arm, which the judge scores against the rubric with no winner to pick: `margin` is null, there is no control guess, and the reports and `crucible series` show one column.

## Testing a tool instead of a skill

To test a tool that is not a skill, an arm's `producer` block takes four more fields. Each is also allowed in the shared `producer` block, for a value that applies to every arm.

- `mcpServers` explicitly enables stdio MCP servers for Claude and Codex producers. It maps server names to `{command, args?, env?}`; use an absolute executable path when possible. Shared and arm mappings merge by server name; an arm replaces the whole same-named server. Omitted servers stay unavailable, and user MCP configuration remains ignored: Claude runs with `--strict-mcp-config` and a private config file in the arm's runtime directory, Codex with `-c mcp_servers.*` overrides. Commands, arguments, and environment values are frozen in the private resolved config; public reports include server names only, and launch logs redact the overrides. Do not publish private run records containing credentials. Cursor rejects this field. Explicit servers are required: a startup failure fails the producer rather than silently running without its assigned tools — Codex marks each server `required`, and a Claude arm stops when the CLI's init event reports a server that did not connect. Codex gives each server 60 seconds to start; packages launched with `uvx` may need network access and a fresh download in the scrubbed home. Pin package versions for reproducibility.

  ```yaml
  arms:
    - label: no-blender
    - label: blender
      producer:
        mcpServers:
          blender:
            command: /opt/homebrew/bin/uvx
            args: [blender-mcp]
            env: {DISABLE_TELEMETRY: "true"}
  ```

  Keep `sandbox: true`. The server subprocess inherits the arm's Seatbelt restrictions, but an already-running application reached over a socket, such as Blender, is shared external state and runs outside that sandbox. Back up and reset its scene between producers, use separate instances when possible, and save exported artifacts inside the arm's source directory. MCP omission controls tool registration, not network access: prohibit direct socket workarounds in the task when testing access to an integration. The runner does not reset Blender or isolate its application state.

- `settings` is a path, relative to the experiment file, to a JSON file whose contents become the producer's Claude settings. This is how a hook reaches one arm. It replaces the empty default whole rather than merging with it, `--setting-sources ""` still keeps this machine's own settings out, and only a Claude producer can apply one.
- `env` adds environment variables on top of the scrubbed ones, so an arm can point at a local proxy or a binary of its own. A value may name other variables, `$PATH` or `${HOME}` style, which are read from the scrubbed environment; nothing else is interpolated. The scrubbed home owns `HOME`, `TMPDIR`, and the `XDG_*` paths, and only `PATH` may be extended, so the isolation cannot be undone one variable at a time.
- `setup` is a shell command run in the copied project, after the workspace is built and before the producer starts, with the arm's own environment and the same sandbox profile. This is where a tool installs what it needs. It runs in the same directory the producer starts in, so a documented install command works unchanged. A shared `setup` and an arm's own are two different jobs — install what every arm needs, build this arm's tool — so both run, the shared one first; they share one `setup.log` beside the producer's other logs, each command's output under the command itself. A non-zero exit fails the arm before it starts and skips the rest, and setup time is not counted as producer time, though it shares the producer's timeout so a hung setup cannot hang the run. The producer's prompt quotes the project's `CLAUDE.md` and `AGENTS.md` after setup has run, so a tool whose documented install writes its rules into `CLAUDE.md` reaches the model the way it would in a real project. Whatever setup left behind is the project that arm starts from, not the arm's work: the runner records the project once setup is done, and every reading of what the arm changed — the status, the judge's copy, the archive — is measured from there. Files the project's `.gitignore` covers are left out of that reading too, so a build the arm ran does not count as work it wrote.

Two arms that differ only in these fields are two arms, not one arm run twice. The resolved settings path, the names of the extra variables, and the setup command appear in the report, the result, and the archive; the values do not, since one could be a token, and the judge is told none of it.

## When preparation stops over a leak

If a baseline skill or the project's own files name a candidate, preparation stops instead of leaking that clue to the other arms. Add the offending baseline skill to `skills.exclude`, or trim `source.include`, then prepare again. Shared-folder files that name a candidate are handled automatically where a shared snapshot exists: they are dropped from every arm's snapshot and listed in the report.

## Running without a judge

`judge: none` replaces the judge block. Nothing is scored. `crucible run` prepares, produces, audits, captures, reports, and archives; `crucible judge` on such a run says it has no judge and exits non-zero. Write the literal `none`. Leaving the `judge` key out altogether stops with an error, which names `judge: none` as the way to skip judging deliberately. No rubric is needed, and an experiment file that carries a judge block behaves exactly as before. A clean run with no judge and no `skills.shared` freezes nothing at all: no rubric, no baseline skills, no subagents, no shared folders.

`crucible capture <run-id>` takes the pictures the judge would have taken. The runner serves each arm's own work as static files on a port the kernel picks. That copy is the one a judge would receive, with setup installs and ignored files withheld. It then opens every HTML page the arm changed in Playwright's Chromium, at 1440 and 390 wide, up to four pages per arm. The pictures go to `shots/<label>/`, and `shots/index.json` has the same shape as the judge's index, marked `capturedBy: "runner"`. Each page is opened as a source file, so one that needs a build or its own server first does not look the way it would when running. That is why a judged run lets the judge start each output itself. A page that will not load leaves that viewport null with its reason in the index. A missing Chromium leaves the index empty with the reason on it, rather than failing the run. Markdown and other text an arm changed is listed under `omitted` instead of rendered. The command can be run again at any time, before or after the report.

An unjudged run reports `judged: false` in `result.json`, with no `winner`, `scores`, `totals`, `margin`, `confidence`, `referenceGuess`, or `judgeAgent`. The arms, producers, time and tokens, warnings, and the shot index are all recorded as usual. `report.md` and `report.html` show the arms, the captures, the costs, and the warnings, with a line saying the run was not judged in place of the score table. `crucible list` shows `not judged` in the result cell. `crucible series` counts the run, then leaves it out of the tally and the mean totals; a series whose runs were all unjudged says so instead of showing an empty tally. An archive validates like any other, and a visual arm still needs its capture.

A reuse arm is refused in both directions. An experiment with `judge: none` may not carry one, and no later experiment may reuse an arm of a run that went unjudged. Nothing in an unjudged run supports a claim that one arm is better than another. Use it when you only want to see what each arm produced, or to baseline a task before writing a rubric.
