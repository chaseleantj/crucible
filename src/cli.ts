import { copyFile, constants } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { archiveRun } from "./archive.js";
import { captureRun } from "./capture.js";
import { loadConfig } from "./config.js";
import { UserError, errorMessage } from "./errors.js";
import { judgeRun } from "./judge.js";
import { RUNNER_ROOT, pathsConfig } from "./paths.js";
import { chromiumProblem } from "./playwright.js";
import { prepareRun } from "./prepare.js";
import { formatBytes, pruneCandidates, pruneRun } from "./prune.js";
import { reportRun, cleanRun } from "./report.js";
import { listRuns, loadRun, loadRunLocation } from "./run.js";
import { agentChecks, startRun, stopRun } from "./runner.js";
import { harborChecks } from "./harbor.js";
import { renderSeries, renderSeriesIndex, resultCell } from "./series.js";
import { renderStatus, statusJson, table, watchStatus } from "./status.js";
import { checkArchive, scanExperiments } from "./store.js";
import { AGENTS, type AgentName, type ShotIndex } from "./types.js";
import { uiCommand } from "./ui.js";
import { SETTINGS, loadUserConfig } from "./user-config.js";

const HELP = `Usage:
  crucible run <experiment.yaml> [--no-archive]  prepare, produce, judge or capture, report, and archive in one go
  crucible prepare <experiment.yaml>   freeze inputs and print the run ID
  crucible start <run-id>              launch pending producers (also relaunches failed arms)
  crucible status <run-id> [--watch|--json]  show, follow, or emit producer progress
  crucible stop <run-id>               stop a run's producers or judge
  crucible judge <run-id>              judge the anonymous outputs
  crucible capture <run-id>            picture each arm's pages; for a run with judge: none
  crucible report <run-id>             write result.json, report.md, and report.html; print the report path
  crucible archive <run-id> [--to <dir>] [--build-dir <dir>]  copy the run into the archive and print the path
  crucible clean <run-id> [--yes]      remove the temporary workspace

  crucible init [<path>]               write a starter experiment file (default experiment.yaml)
  crucible list [--json]               live runs and archived results
  crucible series [<name>]             tally the runs of one series, or list every series
  crucible check [<dir>...]            validate archive entries (default: the configured archive)
  crucible prune [--older-than <days>] [--yes]  delete finished local runs the archive already holds; dry run without --yes
  crucible doctor [<agent>...]         check Harbor, credentials, and Chromium without starting a run
  crucible config                      show the resolved settings and where each came from
  crucible ui [--port N] [--no-open]   open the dashboard of running tests and results`;

/**
 * Commands that work on the run records and the archive as a whole rather
 * than on one run. A new one is an entry here and a line in HELP.
 */
const TOOLS: Record<string, (args: string[]) => Promise<void>> = {
  init: initCommand,
  list: listCommand,
  series: async ([name, ...rest]) => {
    rejectOptions(rest);
    const runs = await listRuns();
    stdout.write(`${name ? renderSeries(runs, name) : renderSeriesIndex(runs)}\n`);
  },
  check: checkCommand,
  prune: pruneCommand,
  doctor: doctorCommand,
  config: configCommand,
  ui: uiCommand,
};

async function main(args: string[]): Promise<void> {
  const [command, target, ...options] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    stdout.write(`${HELP}\n`);
    return;
  }
  const tool = TOOLS[command];
  if (tool) return tool(args.slice(1));
  if (!target) throw new UserError(`${command} requires a file or run ID\n\n${HELP}`);

  if (command === "prepare") {
    rejectOptions(options);
    const run = await prepareRun(await loadConfig(target));
    stdout.write(`${run.runId}\n`);
    return;
  }
  if (command === "run") {
    const archive = !options.includes("--no-archive");
    rejectOptions(options.filter((option) => option !== "--no-archive"));
    const run = await prepareRun(await loadConfig(target));
    stdout.write(`Prepared ${run.runId}\n`);
    await startRun(run);
    stdout.write(`Producers complete for ${run.runId}\n`);
    // With no judge nothing ranks the outputs, so the runner pictures them
    // itself and the report says what they cost.
    if (run.config.judge) await judgeRun(run);
    else stdout.write(`${describeCapture(await captureRun(run))}\n`);
    stdout.write(`Report: ${await reportRun(run)}\n`);
    // Archiving copies the producer workspaces, so it has to happen before an
    // automatic cleanup removes them.
    if (archive && run.config.archive) stdout.write(`Archive: ${await archiveRun(run)}\n`);
    if (run.config.cleanup === "automatic") await cleanRun(run);
    return;
  }

  // Cleanup only needs to know where the run put its workspace, so a run whose
  // frozen experiment no longer loads can still be cleaned.
  if (command === "clean") {
    rejectOptions(options.filter((option) => option !== "--yes"));
    const run = await loadRunLocation(target);
    stdout.write(`Temporary workspace: ${run.tempDir}\n`);
    if (!options.includes("--yes") && !await confirmCleanup()) {
      stdout.write("Cleanup cancelled.\n");
      return;
    }
    for (const removed of await cleanRun(run)) stdout.write(`Removed ${removed}\n`);
    return;
  }

  const run = await loadRun(target);
  if (command === "start") {
    rejectOptions(options);
    await startRun(run);
    stdout.write(`Producers complete for ${run.runId}\n`);
  } else if (command === "status") {
    rejectOptions(options.filter((option) => option !== "--watch" && option !== "--json"));
    if (options.includes("--json")) stdout.write(`${await statusJson(run)}\n`);
    else if (options.includes("--watch")) await watchStatus(run);
    else stdout.write(`${await renderStatus(run)}\n`);
  } else if (command === "stop") {
    rejectOptions(options);
    await stopRun(run);
    stdout.write(`Stopped ${run.runId}\n`);
  } else if (command === "judge") {
    rejectOptions(options);
    await judgeRun(run);
    stdout.write(`Judgment complete for ${run.runId}\n`);
  } else if (command === "capture") {
    rejectOptions(options);
    stdout.write(`${describeCapture(await captureRun(run))}\n`);
  } else if (command === "report") {
    rejectOptions(options);
    stdout.write(`${await reportRun(run)}\n`);
  } else if (command === "archive") {
    const values: Record<string, string> = {};
    for (let index = 0; index < options.length; index += 2) {
      const option = options[index]!;
      if (option !== "--to" && option !== "--build-dir") rejectOptions([option]);
      const value = options[index + 1];
      if (!value || value.startsWith("--")) throw new UserError(`${option} requires a directory`);
      if (values[option]) throw new UserError(`Repeated option: ${option}`);
      values[option] = value;
    }
    stdout.write(`${await archiveRun(run, values["--to"], values["--build-dir"])}\n`);
  } else {
    throw new UserError(`Unknown command: ${command}\n\n${HELP}`);
  }
}

/** A starter experiment, copied from the one this package ships; never over an existing file. */
async function initCommand([target = "experiment.yaml", ...rest]: string[]): Promise<void> {
  rejectOptions(rest);
  const destination = resolve(target);
  try {
    await copyFile(resolve(RUNNER_ROOT, "example.yaml"), destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new UserError(`${destination} already exists; choose another path`);
    throw error;
  }
  stdout.write(`Wrote ${destination}. Edit its arms, source, task, and judge, then: crucible run ${target}\n`);
}

/** Live runs, then the archive, both read through the store. */
async function listCommand(options: string[]): Promise<void> {
  const json = options.includes("--json");
  rejectOptions(options.filter((option) => option !== "--json"));
  const { runRoot, archiveRoot } = pathsConfig();
  const scan = scanExperiments({ archiveRoot, runsRoot: runRoot });
  if (json) {
    stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
    return;
  }
  const live = [...scan.live.inFlight, ...scan.live.unfinished];
  stdout.write(`Live runs in ${runRoot}\n`);
  stdout.write(live.length === 0 ? "None.\n" : `${table(["run", "phase", "started", "name"], live.map((run) =>
    [run.runId, run.phase, run.startedAt.slice(0, 10), run.name]))}\n`);
  const archived = scan.questions.flatMap((question) => question.runs);
  stdout.write(`\nArchive in ${archiveRoot}: ${archived.length} results in ${scan.questions.length} questions, ${scan.reportsOnly.length} reports only\n`);
  if (archived.length > 0 || scan.reportsOnly.length > 0) {
    stdout.write(`${table(["run", "reported", "series", "result", "entry"], [
      ...archived.map(({ name, result }) => [result.runId, result.reportedAt.slice(0, 10), result.series ?? "", resultCell(result), name]),
      ...scan.reportsOnly.map(({ name }) => ["—", "", "", "report only", name]),
    ])}\n`);
  }
}

async function checkCommand(targets: string[]): Promise<void> {
  const options = targets.filter((target) => target.startsWith("-"));
  rejectOptions(options);
  const results = (targets.length > 0 ? targets : [pathsConfig().archiveRoot]).map(checkArchive);
  const problems = results.flatMap((result) => result.problems);
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  stdout.write(`Checked ${results.reduce((sum, result) => sum + result.entries, 0)} entries; ${problems.length} problems.\n`);
  if (problems.length > 0) process.exitCode = 1;
}

/**
 * What `start` checks before it launches anything, without a run: each
 * agent's CLI and credential, and the sandbox; and what the judge needs to
 * take screenshots: Chromium, and Playwright loading from its workspace. With no agents named, every
 * supported agent is checked and the command fails only when none is ready;
 * a named agent that is not ready fails it.
 */
async function doctorCommand(names: string[]): Promise<void> {
  const unknown = names.filter((name) => !(AGENTS as readonly string[]).includes(name));
  if (unknown.length > 0) throw new UserError(`Unknown agent: ${unknown.join(", ")}. Choose from ${AGENTS.join(", ")}`);
  const agents = (names.length > 0 ? names : [...AGENTS]) as AgentName[];
  const checks = await agentChecks(agents);
  const chromium = await chromiumProblem();
  const environment = [
    ...await harborChecks(),
    { name: "Chromium for screenshots", passed: !chromium, ...(chromium ? { detail: chromium } : {}) },
  ];
  for (const check of [...checks, ...environment]) {
    stdout.write(`${check.passed ? "ok  " : "FAIL"}  ${check.name}${check.detail ? `: ${check.detail}` : ""}\n`);
  }
  const ready = agents.filter((agent) => checks.filter((check) => check.name.startsWith(`${agent} `)).every((check) => check.passed));
  const agentsFail = names.length > 0 ? ready.length < agents.length : ready.length === 0;
  if (agentsFail || environment.some((check) => !check.passed)) process.exitCode = 1;
}

/** Every setting's value and where it came from: a default, the config file, or an environment variable. */
async function configCommand(options: string[]): Promise<void> {
  rejectOptions(options);
  const loaded = loadUserConfig();
  const value = (key: (typeof SETTINGS)[number]): string => {
    const found = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], loaded.values);
    return Array.isArray(found) ? (found.length > 0 ? found.join(", ") : "[]") : found === null ? "none" : String(found);
  };
  stdout.write(`Config file: ${loaded.file}${loaded.exists ? "" : " (not found; using defaults)"}\n\n`);
  stdout.write(`${table(["setting", "value", "source"], SETTINGS.map((key) => [key, value(key), loaded.sources[key]!]))}\n`);
}

/**
 * Sweeping up after archiving: a dry run prints what would go, --yes removes
 * it. Runs the archive does not hold are kept unless --older-than asks for them.
 */
async function pruneCommand(options: string[]): Promise<void> {
  const remove = options.includes("--yes");
  const rest = options.filter((option) => option !== "--yes");
  let olderThanDays: number | undefined;
  if (rest.length > 0) {
    if (rest[0] !== "--older-than") rejectOptions(rest);
    const days = Number(rest[1]);
    if (!Number.isFinite(days) || days < 0) throw new UserError("--older-than requires a number of days");
    rejectOptions(rest.slice(2));
    olderThanDays = days;
  }
  const candidates = await pruneCandidates(olderThanDays);
  if (candidates.length === 0) {
    stdout.write("Nothing to prune.\n");
    return;
  }
  const total = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  if (!remove) {
    stdout.write(`${table(["run", "created", "state", "archived", "size"], candidates.map((candidate) =>
      [candidate.runId, candidate.createdAt.slice(0, 10), candidate.state, candidate.archived ? "yes" : "no", formatBytes(candidate.bytes)]))}\n`);
    stdout.write(`${candidates.length} runs, ${formatBytes(total)} would be freed. Re-run with --yes to remove them.\n`);
    return;
  }
  for (const candidate of candidates) {
    await pruneRun(candidate);
    stdout.write(`Removed ${candidate.runId} (${formatBytes(candidate.bytes)})\n`);
  }
  stdout.write(`Pruned ${candidates.length} runs, ${formatBytes(total)} freed.\n`);
}

/** What a capture produced, in one line: how many pages per arm, or why none. */
function describeCapture(index: ShotIndex): string {
  if (index.skipped) return `No pictures taken: ${index.skipped}`;
  const counted = Object.entries(index.arms).map(([label, shots]) => `${label} ${shots.length}`).join(", ");
  return `Captured pages: ${counted}`;
}

async function confirmCleanup(): Promise<boolean> {
  if (!stdin.isTTY) throw new UserError("Cleanup requires an interactive confirmation or --yes");
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return (await prompt.question("Remove this temporary workspace? [y/N] ")).trim().toLocaleLowerCase() === "y";
  } finally {
    prompt.close();
  }
}

function rejectOptions(options: string[]): void {
  if (options.length > 0) throw new UserError(`Unknown option: ${options[0]}`);
}

main(process.argv.slice(2)).catch((error) => {
  const exitCode = error instanceof UserError ? error.exitCode : 1;
  process.stderr.write(`crucible: ${errorMessage(error)}\n`);
  process.exitCode = exitCode;
});
