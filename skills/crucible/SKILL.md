---
name: crucible
description: Run a blinded A/B test of coding-agent skills, models, effort levels, harnesses (Claude Code, Codex, Cursor), or tools hooked into the agent, with the Crucible CLI. Use when the user invokes /crucible or asks whether a skill, tool, or model actually improves the result.
---

# A/B test with Crucible

`crucible` runs one to ten agents ("arms") on the same copied project and task, each in a disposable Linux VM. An arm can carry a candidate skill, a different model or effort, a different agent CLI, or a tool setup. An independent judge then compares the outputs under anonymous letters and scores them against a rubric.

The documentation sits next to the `crucible` executable, in `dirname "$(readlink -f "$(command -v crucible)")"`. Before writing an experiment, read `README.md`, `docs/experiments.md` (every field), and `example.yaml` there. Do not reconstruct the format from memory.

## Set up

1. Run `crucible doctor`. It checks the Harbor runtime, agent image, provider logins, and screenshot prerequisites. Follow its runtime setup instructions if needed. If a credential is missing, point the user to `CREDENTIALS.md` in the repository. If Chromium is missing, run the `npm run setup:browsers` command the check prints.
2. Run `crucible config` to see the user's defaults (skills root, shared folders, exclusions, storage roots). An experiment only states what differs.
3. Run `crucible init <path>` to write a starter experiment file, then edit it for the user's question:
   - The arms. The first is the one the others are compared against. Vary one thing per arm: a candidate skill, a `producer` override (model, effort, or agent), an `environment`, or a tool (`settings`, `env`, `setup`, `mcpServers`).
   - An explicit `source.include` allowlist.
   - The same agent, model, effort, and timeout for every arm, unless that is the variable. An arm that changes agent also sets a model and effort that agent accepts.
   - A rubric written before any producer starts, and a judge. Use `judge: none` only when the user wants to see the outputs without a ranking.

Keep the task as plain as the user's own request. A task that spells out quality criteria measures the prompt, not the skill. VM isolation is required; `sandbox: false` is rejected. Native automatic permission review is enabled. Tasks and setup commands run on Linux, so do not depend on host executables or host `node_modules`. Never modify or move the live candidate; the runner works from copies.

If `prepare` stops because a baseline skill or project file names a candidate, add that skill to `skills.exclude` or trim `source.include`, then prepare again.

## Run and watch

Start `crucible run <experiment.yaml>` in the background. It prepares, runs the producers, judges, reports, and archives, and prints the run ID early.

Check `crucible status <run-id> --json` every few minutes. Stay quiet while everything is healthy. Tell the user when:

- an agent becomes `quiet`, `stalled`, or `failed` (say which arm and the error);
- an agent is `near timeout` (say how much time is left and whether files are still changing);
- all producers finish, with their elapsed times.

If the user asks how it is going, answer from `--json`, not from memory. If an arm fails or is stopped, `crucible start <run-id>` relaunches it from the frozen inputs. Use `crucible stop <run-id>` rather than killing processes; it stops the judge as well as producers. If the user wants to watch themselves, `crucible ui` serves a local dashboard.

## Report the result

Read `result.json` for the numbers and `report.md` for the judge's reasoning. Give the user the path to `report.html` and summarize:

- whether the candidate helped, hurt, or made no clear difference, with criterion-level evidence;
- time and tokens per arm, leaving unavailable values unavailable;
- every warning the report lists;
- the judge's guess at which arm was the control, and its confidence;
- whether the quality change justifies the extra time and tokens.

The judge is blinded by procedure only. Style, structure, and naming can still reveal which output is which. One run is one sample per arm. When the decision matters, repeat the experiment with the same `series` and quote `crucible series <name>`.

For a run with `judge: none`, report what each arm produced, its time and tokens, and its warnings. Do not name a winner.
