<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo/lockup-dark.svg">
    <img alt="Crucible" src="brand/logo/lockup-light.svg" height="48">
  </picture>
</h1>

Crucible runs blinded A/B tests of coding agents on macOS. You give it a small project, a task, and up to six variations: the same agent with and without a skill, two models, two effort levels, or Claude Code against Codex against Cursor. It runs every variation on its own copy of the project, then has an independent judge score the results without knowing which is which.

The point is to find out whether a skill, model, or tool actually makes the work better, instead of guessing from one session.

![The Crucible dashboard comparing slide decks made by Claude Code, Codex, and Cursor, with the judge's scores below](docs/dashboard.png)

## What it supports

- **macOS only.** Each agent runs inside a macOS Seatbelt sandbox, and Claude's login is read from the keychain.
- **Three agent CLIs:** Claude Code (`claude`), Codex (`codex`), and Cursor Agent (`cursor-agent`), in any mix.
- **What an arm can vary:** a candidate skill, a revised version of a skill, the model, the effort level, the agent, the surrounding skills, or a tool (hooks, MCP servers, a setup command).
- **Any kind of output:** web pages, slide decks, SVGs, 3D scenes, documents. The judge runs and screenshots whatever each arm made.
- **A local dashboard** (`crucible ui`) for watching runs live and comparing results side by side.

## How a run works

Each variation is called an arm. Crucible copies your project once per arm and starts one agent per arm, in parallel, each in its own sandboxed workspace with a fake home directory, so no arm can see your real skills, the other arms, or the experiment. When they finish, a separate judge agent gets the outputs as `A`, `B`, and so on, in random order. It opens and screenshots each one, scores them against your rubric, and picks a winner. Crucible then reveals which letter was which arm, writes a report with the scores, time, and tokens of each arm, and saves the result to an archive that the dashboard reads.

## Requirements

- macOS with Node 24 or newer.
- At least one agent CLI, installed and logged in: `claude`, `codex`, or Cursor's `cursor-agent`. [CREDENTIALS.md](CREDENTIALS.md) explains how each one signs in.

## Install

Crucible is not on npm yet, so install it from source:

```sh
git clone https://github.com/chaseleantj/crucible.git
cd crucible
npm ci
npm run setup:browsers   # Chromium, which the judge uses for screenshots
npm run build
npm link                 # puts `crucible` on your PATH
crucible doctor          # checks each agent CLI, its login, the sandbox, and Chromium
```

## Run your first test

The repo comes with a small ready-made test that asks Claude Code to draw a coffee cup icon at low and at high effort:

```sh
crucible run examples/first-test/experiment.yaml
crucible ui                                       # open the dashboard at http://127.0.0.1:8300/
```

It takes a few minutes. `crucible run` prints a run ID straight away. In another terminal, `crucible status <run-id> --watch` follows the agents. When the run finishes, it prints where the report is, and the result appears in the dashboard.

To use Codex or Cursor instead, change `agent: claude` in the experiment file.

## Write your own test

A test is two files: an experiment file that says what to run, and a rubric that tells the judge how to score. `crucible init my-test.yaml` writes a commented starter. A minimal one looks like this:

```yaml
name: Does my frontend skill help?

arms:
  - label: without-skill
  - label: with-skill
    candidate:
      path: ~/.claude/skills/frontend-design

source:
  path: ~/code/my-project        # the project each arm gets a copy of
  include: [package.json, src/**/*]

task: Redesign the settings page and run the project's checks.

producer:
  agent: claude                  # claude, codex, or cursor

judge:
  agent: claude
  rubric: ./rubric.md
```

Instead of a `candidate`, an arm can change its own producer, for example `producer: {model: ...}`, `producer: {effort: high}`, or `producer: {agent: codex, model: ...}`. The rubric is plain Markdown: a few criteria, each with a weight and a line on what good looks like. [examples/first-test/rubric.md](examples/first-test/rubric.md) is a short one.

One run is one sample, since agents vary from run to run. Give repeated runs the same `series:` name, and `crucible series <name>` tallies them.

## Let an agent run Crucible for you

The repo includes an agent skill, [skills/crucible/SKILL.md](skills/crucible/SKILL.md), that teaches Claude Code, Codex, or Cursor Agent to set up, run, and report on a test. Link it into your agent's skills folder from the Crucible checkout:

```sh
ln -s "$PWD/skills/crucible" ~/.claude/skills/crucible    # Claude Code
ln -s "$PWD/skills/crucible" ~/.codex/skills/crucible     # Codex
ln -s "$PWD/skills/crucible" ~/.cursor/skills/crucible    # Cursor Agent
```

Then ask something like "A/B test whether my frontend skill improves this page."

Arms get a copy of your skills folder by default, so keep this skill away from them: add `crucible` to `skills.exclude` in your config (below). Otherwise an agent under test could read about the experiment it is in.

## Configuration

Crucible works without a config file. By default, arms start with the skills in `~/.claude/skills` and finished results are saved to `~/.crucible/archive`. To change that, or to withhold skills from every arm, create `~/.config/crucible/config.yaml`:

```yaml
skills:
  root: ~/.claude/skills          # the skills every arm starts with, unless it runs clean
  exclude: [crucible]             # skills no arm receives
archiveRoot: ~/.crucible/archive  # where finished results are saved
```

`crucible config` prints every setting and where it came from.

## Limits of the isolation

- **It is a deny-list, not a container.** The sandbox hides the experiment, the other arms, and your live skills, but the rest of the disk and the network stay reachable. It prevents accidental leaks between arms, not a determined agent.
- **Blinding is procedural.** The judge sees anonymous letters, and Crucible checks that no candidate's name or files leak into another arm. Style and structure can still give an output away.
- **External apps are shared.** An MCP server that talks to a running app, such as Blender, reaches state outside the sandbox. Reset it between arms.

## More documentation

- [docs/experiments.md](docs/experiments.md): every field in the experiment file.
- [docs/commands.md](docs/commands.md): every command, the files a run writes, and the archive format.
- [CONTRIBUTING.md](CONTRIBUTING.md): building and testing Crucible itself.
- [CHANGELOG.md](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
