import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertGuestCompatible } from "./config.js";
import { executeAgent, type AgentExecutionResult } from "./agent.js";
import { UserError, errorMessage } from "./errors.js";
import { buildManifest, copyTree, makeReadOnly, removeTree, writePrivateFile } from "./files.js";
import { readJson, writeJson } from "./json.js";
import { hiddenFrom, omitSkillPathEchoes, scanFiles } from "./leaks.js";
import { copyArmOutputs } from "./outputs.js";
import { MATERIAL_FILE } from "./prepare.js";
import { recordReusableInputs } from "./reuse.js";
import { publishReportAssets } from "./report-assets.js";
import type { ServedOutput } from "./serve.js";
import { openAgentSession } from "./runner.js";
import { prepareRuntimeDirectories } from "./adapters.js";
import { publishShots, shotsPrompt } from "./shots.js";
import { appendRunEvent, readRunState, resetJudge, setRunState, trackAgent, updateJudge } from "./state.js";
import type { ForbiddenMaterial, JudgeConfig, JudgeOutput, ResolvedRun } from "./types.js";
import { judgeLetters, parseVerdict } from "./verdict.js";

/** Which producer's output each anonymous letter holds. */
type JudgeMapping = Record<JudgeOutput, string>;

export async function judgeRun(run: ResolvedRun): Promise<void> {
  assertGuestCompatible(run.config.sandbox, run.config.nodeModules);
  const judgeConfig = run.config.judge;
  if (!judgeConfig) {
    throw new UserError(`Run ${run.runId} has no judge: its experiment set judge: none. Capture its outputs with crucible capture ${run.runId} and seal them with crucible report ${run.runId}.`);
  }
  const state = await readRunState(run.runDir);
  // A reported run keeps its workspaces until it is cleaned, so it can be judged again.
  if (state.state !== "produced" && state.state !== "judged" && state.state !== "reported") {
    throw new UserError(`Run must have complete outputs before judging; current state is ${state.state}`);
  }

  const producerIds = Object.keys(run.assignment.arms);
  if (producerIds.length !== run.config.arms.length) throw new UserError(`Judging needs one output per arm; the run has ${producerIds.length} for ${run.config.arms.length} arms`);
  const letters = judgeLetters(producerIds.length);
  const shuffled = shuffle(producerIds);
  const mapping: JudgeMapping = Object.fromEntries(letters.map((letter, index) => [letter, shuffled[index]!]));
  const judgeId = `j-${randomBytes(3).toString("hex")}`;
  const judgeDir = join(run.tempDir, judgeId);
  const inputDir = join(judgeDir, "input");
  await removeTree(judgeDir);
  await mkdir(join(judgeDir, ".runtime", "tmp"), { recursive: true, mode: 0o700 });
  await prepareRuntimeDirectories(join(judgeDir, ".runtime"));
  const tools: JudgeTools = { playwright: true, chromium: true };
  const withheld = await copyJudgeInputs(run, inputDir, mapping);
  const effectiveJudge = { ...judgeConfig };
  if (judgeConfig.settings) {
    const settings = join(judgeDir, ".context", "claude-settings.json");
    await writePrivateFile(settings, await readFile(judgeConfig.settings, "utf8"));
    effectiveJudge.settings = settings;
  }
  const rubric = await readFile(join(run.runDir, "rubric.md"), "utf8");
  await writePrivateFile(join(judgeDir, ".context", "rubric.md"), rubric);

  // Blinding is procedural. Files that merely echo the frozen skill folder path
  // are dropped from the judge copy; anything that still names a candidate is
  // recorded as a warning for the report, not a reason to block the judgment.
  const { identities, hashes } = hiddenFrom(await readJson<ForbiddenMaterial>(join(run.runDir, MATERIAL_FILE)), null);
  const removed: string[] = [];
  for (const name of [...letters, "source"]) removed.push(...await omitSkillPathEchoes(join(inputDir, name), identities));
  const manifest = await buildManifest(inputDir);
  const findings = await scanFiles(inputDir, manifest.entries.map((entry) => entry.path), identities, hashes);
  await writeJson(join(run.runDir, "judge", "package-scan.json"), {
    findings,
    removed,
    withheld,
    note: "This catches explicit disclosures only. Style and implementation choices can still reveal which output received extra guidance.",
  });
  if (findings.length > 0) {
    process.stderr.write(`Judge package still names a candidate in ${findings.length} file(s); the report will say so.\n`);
  }
  await recordReusableInputs(run.runDir, inputDir, mapping);
  await makeReadOnly(join(judgeDir, ".context"));
  await makeReadOnly(inputDir);
  await writeJson(join(run.runDir, "judge", "mapping.json"), mapping);

  await resetJudge(run.runDir);
  let result;
  try {
    result = await serveAndJudge(run, judgeId, judgeDir, letters, effectiveJudge, tools);
  } catch (error) {
    // Left ready, the judge's row would read as waiting to start forever.
    await updateJudge(run.runDir, { state: "failed", completedAt: new Date().toISOString(), error: errorMessage(error) });
    throw error;
  }
  if ((await readRunState(run.runDir)).judge?.state === "stopped") return;
  const failure = result.succeeded ? null : result.timedOut ? "timed out" : `exited with ${result.exitCode ?? result.signal}`;
  await updateJudge(run.runDir, {
    state: failure ? "failed" : "complete",
    completedAt: result.completedAt,
    lastActivityAt: result.completedAt,
    toolCalls: result.toolCalls,
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(failure ? { error: failure } : {}),
  });
  await appendRunEvent(run.runDir, {
    time: result.completedAt,
    producer: judgeId,
    kind: failure ? "agent.failed" : "agent.completed",
    ...(failure ? { summary: failure } : {}),
  });
  await writeJson(join(run.runDir, "judge", "cost.json"), {
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    wallTimeMs: Date.parse(result.completedAt) - Date.parse(result.startedAt),
    usage: result.usage,
  });
  if (!result.succeeded) {
    throw new UserError(result.timedOut
      ? "Judge timed out; run crucible judge again"
      : `Judge exited with ${result.exitCode ?? result.signal}; run crucible judge again`);
  }
  let verdict: string;
  let structured: unknown;
  try {
    verdict = await readFile(join(judgeDir, "verdict.md"), "utf8");
  } catch {
    throw new UserError("Judge completed without writing verdict.md; run crucible judge again");
  }
  try {
    structured = await readJson<unknown>(join(judgeDir, "verdict.json"));
  } catch {
    throw new UserError("Judge completed without writing verdict.json; run crucible judge again");
  }
  await writePrivateFile(join(run.runDir, "judge", "verdict.md"), verdict);
  await writeJson(join(run.runDir, "judge", "verdict.json"), parseVerdict(structured, letters));
  const shots = await publishShots(run, judgeDir, mapping);
  await publishReportAssets(run.runDir, judgeDir);
  if (shots.skipped) process.stderr.write(`${shots.skipped}; the report will say so.\n`);
  await setRunState(run.runDir, "judged");
}

/** Judge files and any servers live only in its disposable guest. */
async function serveAndJudge(
  run: ResolvedRun,
  judgeId: string,
  judgeDir: string,
  letters: JudgeOutput[],
  config: JudgeConfig,
  tools: JudgeTools,
): Promise<AgentExecutionResult> {
  const session = await openAgentSession(run, judgeId, judgeDir, config.agent);
  try {
    const result = await executeAgent({
      run,
      id: judgeId,
      directory: judgeDir,
      cwd: judgeDir,
      runtimeDir: join(judgeDir, ".runtime"),
      logDir: join(run.runDir, "judge", "agent"),
      prompt: judgePrompt(run, "/workspace", letters, [], tools),
      config,
      session,
      ...trackAgent(run.runDir, judgeId, (patch) => updateJudge(run.runDir, patch)),
    });
    await session.collect();
    return result;
  } finally {
    await session.close();
  }
}

/** The untouched source lets a judge check changes shared by every output. */
export async function copyJudgeInputs(run: ResolvedRun, inputDir: string, mapping: JudgeMapping): Promise<string[]> {
  await copyTree(join(run.runDir, "frozen", "source"), join(inputDir, "source"));
  return copyArmOutputs(run, inputDir, mapping);
}

/** A permutation of the producer ids, so the letters say nothing about the arms. */
function shuffle(values: string[]): string[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const draw = randomBytes(1)[0]! % (index + 1);
    [result[index], result[draw]] = [result[draw]!, result[index]!];
  }
  return result;
}

/** What the judge can render pages with, so its prompt claims only what holds. */
export interface JudgeTools {
  /** require("playwright") resolves from the judge's working directory. */
  playwright: boolean;
  /** That Playwright's Chromium is installed. */
  chromium: boolean;
}

export function judgePrompt(
  run: ResolvedRun,
  judgeDir: string,
  letters: JudgeOutput[],
  served: ServedOutput[] = [],
  tools: JudgeTools = { playwright: false, chromium: false },
): string {
  const named = letters.join(", ");
  const quoted = `"${letters.join('" | "')}"`;
  const scoreShape = letters.map((letter) => `"${letter}": <0 to 10>`).join(", ");
  // A run with one arm has nothing to compare: the judge scores that output
  // against the rubric, and the winner is the only letter there is.
  const alone = letters.length === 1;
  return [
    alone
      ? "Independently score one anonymous output for this task:"
      : `Independently compare ${letters.length} anonymous outputs for this task:`,
    run.config.task,
    "",
    `Read the rubric at ${join(judgeDir, ".context", "rubric.md")}.`,
    `The original input every output started from is at ${join(judgeDir, "input", "source")}. Use it to verify changes and factual claims; it is not another competing output.`,
    ...letters.map((letter) => `Output ${letter} is at ${join(judgeDir, "input", letter)}.`),
    ...served.map((output) => `Output ${output.name} is already served as static files at ${output.url} (its folder is the site root).`),
    ...(served.length > 0 ? [
      "Open static pages through those URLs. Do not start a static file server of your own: a port you pick may already be taken by something else, and a server started with its output discarded fails silently and leaves you photographing another run's pages. If an output needs its own dev server or build, run it from a scratch copy under /tmp on a port you have confirmed is free, check the served page is that copy before you photograph it, and stop it when you are done.",
    ] : []),
    alone
      ? "Inspect and test the output against every rubric item. Do not edit any input."
      : "Inspect and test every output using the same checks. Do not edit any input.",
    tools.playwright
      ? `Playwright is available: require("playwright") resolves from your working directory${tools.chromium ? " and its Chromium is installed" : ", but its Chromium is not installed"}.`
      : "Playwright is not installed where you can reach it, so use whatever browser tooling you have.",
    ...shotsPrompt(judgeDir, letters),
    alone
      ? "There is no second output to compare against. Score this one against the rubric on its own merits, as strictly as you would in a comparison."
      : run.config.arms.some((arm) => arm.reuse)
      ? "This comparison includes historical frozen outputs, so it is not an independent producer sample for every arm. Judge their visible quality normally. Do not infer a control treatment; use null for referenceGuess.output and 0 for its confidence."
      : `One of the outputs is the reference configuration. Configurations may vary prompts, information, models, skills, or tools. The reference is one of ${named}; guess a letter and say how sure you are. Use null in verdict.json when you have no evidence to tell them apart.`,
    alone
      ? `Write verdict.md in your working directory. Include: scores for every rubric item, evidence, and how confident you are in the scoring. There is nothing to beat, so the winner is ${named}.`
      : `Write verdict.md in your working directory. Include: scores for every rubric item, evidence, the winner (${named}, or tie), confidence, and your guess at the control arm, with confidence in that guess.`,
    "Also write verdict.json beside it, with exactly this shape and nothing else:",
    alone
      ? `{"winner": ${quoted}, "confidence": <0 to 1>, "scores": [{"criterion": "<rubric item>", "weight": <its weight in the rubric>, "scores": {${scoreShape}}}, ...], "summary": "<one or two sentences on how the output scored>"}`
      : `{"winner": ${quoted} | "tie", "confidence": <0 to 1>, "scores": [{"criterion": "<rubric item>", "weight": <its weight in the rubric>, "scores": {${scoreShape}}}, ...], "referenceGuess": {"output": ${quoted} | null, "confidence": <0 to 1>}, "summary": "<one or two sentences on why the winner won>"}`,
    "Score every rubric item on a 0 to 10 scale, one entry per item, in the rubric's order, with the item's short name as the criterion. The numbers in verdict.json must match the ones in verdict.md.",
    alone
      ? `In the summary, call it "the output" rather than ${named}: the name is replaced by a real one once the summary is read.`
      : `In the summary, call the outputs "the winner" and "the other outputs" rather than ${named}: the names are replaced by real ones once the summary is read.`,
    "Do not look for experiment records or infer the mapping from paths. Judge only the supplied outputs against the supplied source and rubric.",
  ].join("\n");
}
