import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { UserError } from "./errors.js";
import { RUNNER_ROOT, pathsConfig } from "./paths.js";
import { RUNNER_PACKAGES, linkJudgePackages } from "./playwright.js";
import { isDirectory, isWithin } from "./scan-files.js";
import type { ArmConfig, PathsConfig, ResolvedRun, StartCheck } from "./types.js";

const execFileAsync = promisify(execFile);
const SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";

export interface SandboxLaunch {
  command: string;
  args: string[];
  profilePath: string;
}

/**
 * The folders a producer or judge must not read: the run records and
 * workspaces, the archive of past verdicts, the original source, and the live
 * skills, shared guidance, subagents, and candidates, of which it gets frozen
 * copies instead.
 */
export function hiddenFolders(
  config: { skills: { root: string; shared: string[] }; subagents: { root: string }; source?: { path: string }; arms?: ArmConfig[] },
  paths: PathsConfig,
): string[] {
  return [
    paths.runRoot,
    paths.tempRoot,
    paths.archiveRoot,
    ...(config.source ? [config.source.path] : []),
    config.skills.root,
    ...config.skills.shared,
    config.subagents.root,
    ...(config.arms ?? []).flatMap((arm) => (arm.candidate ? [arm.candidate.path, ...arm.candidate.dependencies] : [])),
  ];
}

/**
 * The configured node_modules stays readable wherever it lies, so one inside
 * a hidden folder opens that part of it; null when it lies elsewhere.
 */
export function nodeModulesWarning(nodeModules: string | null, hidden: string[]): string | null {
  if (!nodeModules) return null;
  const folder = hidden.find((root) => resolve(root) === resolve(nodeModules) || isWithin(root, nodeModules));
  return folder ? `nodeModules ${nodeModules} is inside ${folder}, which the sandbox hides; producers can still read it` : null;
}

/**
 * The producers are cooperative agents, not adversaries. The profile is a
 * deny list that hides the experiment (see hiddenFolders), this runner, and
 * the sibling arm, and contains writes to the producer's own workspace.
 * Everything else, including the keychain, Playwright, the configured
 * node_modules, and the user's other command-line tools, stays available.
 */
export async function sandboxWrap(
  run: ResolvedRun,
  workspaceId: string,
  command: string,
  args: string[],
  frozenDirs: string[],
  extraWriteRoots: string[],
): Promise<SandboxLaunch> {
  const problem = await seatbeltProblem();
  if (problem) throw new UserError(problem);

  const workspaceDir = await realpath(join(run.tempDir, workspaceId));
  const siblingScratch = Object.keys(run.assignment.arms)
    .filter((id) => id !== workspaceId)
    .map((id) => join("/tmp", `crucible-${id}`));
  const deniedRoots = await canonicalPaths([
    // The run's own roots come from the run, so the same directories are
    // denied whichever environment later invokes start or judge; the archive
    // is wherever this environment's Crucible archive writes.
    ...hiddenFolders(run.config, { runRoot: dirname(run.runDir), tempRoot: dirname(run.tempDir), archiveRoot: pathsConfig().archiveRoot }),
    RUNNER_ROOT,
    ...siblingScratch,
  ]);

  const profileDir = join(run.runDir, "sandbox");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const commandName = basename(command).replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  const profilePath = join(profileDir, `${workspaceId}-${commandName}.sb`);
  await writeFile(profilePath, profile({
    workspaceDir,
    deniedRoots,
    readableRoots: await readableRoots(run.config.nodeModules),
    frozenDirs: await Promise.all(frozenDirs.map((path) => realpath(path))),
    extraWriteRoots: await canonicalPaths(extraWriteRoots),
    sharedTempDir: await realpath("/tmp"),
    runTempDir: await realpath(run.tempDir),
  }), { mode: 0o600 });
  return { command: SANDBOX_EXECUTABLE, args: ["-f", profilePath, command, ...args], profilePath };
}

/**
 * Package folders read back out of the denials: the configured node_modules,
 * and the one holding Crucible's own Playwright, which the judge is given and
 * which usually lies inside this runner's hidden install.
 */
async function readableRoots(nodeModules: string | null): Promise<string[]> {
  return canonicalPaths([...(nodeModules ? [nodeModules] : []), ...(RUNNER_PACKAGES ? [RUNNER_PACKAGES] : [])]);
}

/** Why the Seatbelt sandbox cannot run here, or null when it can. */
export async function seatbeltProblem(): Promise<string | null> {
  if (platform() !== "darwin") return "sandbox: true requires macOS Seatbelt; set sandbox: false to run without isolation";
  try {
    await execFileAsync(SANDBOX_EXECUTABLE, ["-p", "(version 1) (allow default)", "/usr/bin/true"]);
    return null;
  } catch (error) {
    return `macOS Seatbelt is unavailable: ${error instanceof Error ? error.message : error}`;
  }
}

/**
 * The start probes' core on a throwaway workspace, for `crucible doctor`: the
 * profile a run uses lets a producer write its own workspace, hides a denied
 * folder, and keeps writes from leaving the workspace.
 */
export async function sandboxSelfTest(): Promise<StartCheck[]> {
  const problem = await seatbeltProblem();
  if (problem) return [{ name: "sandbox", passed: false, detail: problem }];
  const root = await realpath(await mkdtemp(join(tmpdir(), "crucible-doctor-")));
  try {
    const workspaceDir = join(root, "workspace");
    const hidden = join(root, "hidden");
    await mkdir(workspaceDir);
    await mkdir(hidden);
    await writeFile(join(hidden, "file"), "hidden\n");
    const profilePath = join(root, "probe.sb");
    await writeFile(profilePath, profile({
      workspaceDir, deniedRoots: [hidden], readableRoots: [], frozenDirs: [], extraWriteRoots: [], sharedTempDir: await realpath("/tmp"), runTempDir: root,
    }));
    return [
      await runProbe("sandbox: write own workspace", "allow", profilePath, ["touch", join(workspaceDir, "probe")], workspaceDir),
      await runProbe("sandbox: hide a denied folder", "deny", profilePath, ["test", "-r", join(hidden, "file")], workspaceDir),
      await runProbe("sandbox: contain writes", "deny", profilePath, ["touch", join(root, "outside")], workspaceDir),
    ];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * For `crucible doctor`: a throwaway judge workspace, linked the way a judge's
 * is, can load Playwright under a profile that hides this runner and the
 * given folders, as a judge's does.
 */
export async function judgePlaywrightCheck(nodeModules: string | null, hidden: string[]): Promise<StartCheck> {
  const name = "judge: load Playwright";
  const root = await realpath(await mkdtemp(join(tmpdir(), "crucible-doctor-")));
  try {
    const workspaceDir = join(root, "judge");
    await mkdir(workspaceDir);
    if (!(await linkJudgePackages(nodeModules, workspaceDir))) {
      return { name, passed: false, detail: "require(\"playwright\") does not resolve from a judge workspace; reinstall Crucible's dependencies" };
    }
    if (await seatbeltProblem()) return { name, passed: true, detail: "resolves; not tried under the sandbox, which is unavailable" };
    const profilePath = join(root, "probe.sb");
    await writeFile(profilePath, profile({
      workspaceDir,
      deniedRoots: await canonicalPaths([...hidden, RUNNER_ROOT]),
      readableRoots: await readableRoots(nodeModules),
      frozenDirs: [],
      extraWriteRoots: [],
      sharedTempDir: await realpath("/tmp"),
      runTempDir: root,
    }));
    const probe = await runProbe(name, "allow", profilePath, [process.execPath, "-e", 'require("playwright")'], workspaceDir);
    return { ...probe, name };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function profile(options: {
  workspaceDir: string;
  deniedRoots: string[];
  /** Read back out of the denials, like node_modules inside this runner's install. */
  readableRoots: string[];
  frozenDirs: string[];
  extraWriteRoots: string[];
  sharedTempDir: string;
  runTempDir: string;
}): string {
  return [
    "(version 1)",
    "(allow default)",
    // Contain writes to the workspace. Seatbelt applies the last matching rule,
    // so the allowances below carve exceptions back out of each deny.
    `(deny file-write* (require-not (subpath ${quote(options.workspaceDir)})))`,
    // The shared temp directory stays writable, as on any machine: agents
    // write scratch files there whatever TMPDIR says. The run's own temp
    // and every sibling's scratch are denied again below.
    `(allow file-write* (subpath ${quote(options.sharedTempDir)}))`,
    ...options.extraWriteRoots.map((path) => `(allow file-read* file-write* (subpath ${quote(path)}))`),
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty"))',
    // Hide the experiment.
    ...options.deniedRoots.map((path) => `(deny file-read* file-write* (subpath ${quote(path)}))`),
    ...options.readableRoots.map((path) => `(allow file-read* (subpath ${quote(path)}))`),
    // Resolving a package takes its real path, which stats every folder above it.
    ...options.readableRoots.flatMap(ancestors).map((path) => `(allow file-read-metadata (literal ${quote(path)}))`),
    `(allow file-read-metadata (literal ${quote(dirname(options.runTempDir))}) (literal ${quote(options.runTempDir)}))`,
    `(allow file-read* file-write* (subpath ${quote(options.workspaceDir)}))`,
    ...options.frozenDirs.map((path) => `(deny file-write* (subpath ${quote(path)}))`),
  ].join("\n");
}

export async function runSandboxProbes(run: ResolvedRun, producerId: string): Promise<StartCheck[]> {
  const producerDir = join(run.tempDir, producerId);
  const siblingIds = Object.keys(run.assignment.arms).filter((id) => id !== producerId);
  const launch = await sandboxWrap(run, producerId, "/bin/sh", ["-c", "exit 0"], [join(producerDir, ".context")], []);
  const checks: StartCheck[] = [];
  const probe = async (name: string, expected: "allow" | "deny", command: string[]) => {
    checks.push(await runProbe(`${producerId}: ${name}`, expected, launch.profilePath, command, producerDir));
  };
  const probeFile = join(producerDir, "source", ".crucible-write-probe");
  await probe("read own source", "allow", ["test", "-r", join(producerDir, "source")]);
  await probe("write own source", "allow", ["touch", probeFile]);
  await probe("deny original source", "deny", ["test", "-r", run.config.source.path]);
  await probe("deny run records", "deny", ["test", "-r", run.runDir]);
  await probe("deny live global skills", "deny", ["test", "-r", run.config.skills.root]);
  for (const folder of run.config.skills.shared) await probe(`deny live shared ${basename(folder)}`, "deny", ["test", "-r", folder]);
  await probe("deny live subagents", "deny", ["test", "-r", run.config.subagents.root]);
  await probe("deny archive", "deny", ["test", "-r", pathsConfig().archiveRoot]);
  if (run.config.nodeModules && isDirectory(run.config.nodeModules)) await probe("read node_modules", "allow", ["test", "-r", run.config.nodeModules]);
  for (const siblingId of siblingIds) await probe(`deny sibling producer ${siblingId}`, "deny", ["test", "-r", join(run.tempDir, siblingId)]);
  await probe("deny frozen context writes", "deny", ["touch", join(producerDir, ".context", ".crucible-write-probe")]);
  await probe("deny writes outside workspace", "deny", ["touch", join(run.tempDir, ".crucible-write-probe")]);
  // Agents write scratch files under /tmp whatever TMPDIR says; a denial
  // there fails commands that actually succeeded.
  const scratchFile = join("/tmp", `crucible-probe-${randomBytes(8).toString("hex")}`);
  await probe("write shared temp", "allow", ["touch", scratchFile]);
  await rm(scratchFile, { force: true });
  await rm(probeFile, { force: true });
  return checks;
}

async function runProbe(
  name: string,
  expected: "allow" | "deny",
  profilePath: string,
  command: string[],
  cwd: string,
): Promise<StartCheck> {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Empty probe command");
  let allowed = true;
  let detail = "";
  try {
    const { stderr } = await execFileAsync(SANDBOX_EXECUTABLE, ["-f", profilePath, executable, ...args], { cwd });
    detail = stderr.trim();
  } catch (error) {
    allowed = false;
    detail = error instanceof Error ? error.message : String(error);
  }
  const passed = expected === "allow" ? allowed : !allowed;
  return { name: `${name} (${expected})`, passed, ...(detail && !passed ? { detail } : {}) };
}

async function canonicalPaths(paths: string[]): Promise<string[]> {
  const values = new Set<string>();
  for (const path of paths) {
    values.add(resolve(path));
    try {
      values.add(await realpath(path));
    } catch {
      // Missing optional paths are validated elsewhere when required.
    }
  }
  return [...values];
}

/** Every folder above `path`, up to but not including the root. */
function ancestors(path: string): string[] {
  const found: string[] = [];
  for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) found.push(parent);
  return found;
}

function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
