import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditReport } from "./audit.js";
import { UserError } from "./errors.js";
import { removeTree, sha256File, manifestFingerprint, writePrivateFile } from "./files.js";
import { agentIdentity, armFor, describeIdentity, describeToolSetup, environmentFor, producerFor } from "./config.js";
import { describeSharedMaterial } from "./skills.js";
import { armCost, describeCost, type CostRecord } from "./cost.js";
import { NOT_JUDGED_NOTE, RUNNER_CAPTURE_NOTE, describeOutcome, renderReportHtml } from "./html.js";
import { readJson, readOptionalJson, writeJson } from "./json.js";
import { reportEvidence } from "./report-assets.js";
import { producerOf } from "./run.js";
import { readReuseRecord } from "./reuse.js";
import { readShotIndex } from "./shots.js";
import { readRunState, setRunState } from "./state.js";
import type { AgentIdentity, FileManifest, JudgeOutput, LeakFinding, ProducedResult, ResolvedRun, RunLocation, RunResult, ShotIndex, StartCheck, Verdict } from "./types.js";
import { revealVerdict, topScorer, type RevealedVerdict } from "./verdict.js";

/**
 * Seals the run in three forms: result.json for anything that tallies or
 * displays runs, report.md for reading in a terminal or a diff, and
 * report.html for reading with the pictures. All three come from the same
 * revealed verdict, so they cannot disagree. A run with no judge is sealed the
 * same way, minus the verdict: the arms, their captures, and what they cost.
 * Sealing only writes those files; archiving and cleaning follow it in
 * `crucible run`, in that order, because cleaning removes the outputs an archive
 * copies.
 */
export async function reportRun(run: ResolvedRun): Promise<string> {
  const state = await readRunState(run.runDir);
  const judgeConfig = run.config.judge;
  // Reporting is a pure function of the sealed record, so a reported or even
  // cleaned run can be reported again — after a runner update, say. Without a
  // judge, complete outputs are the whole record.
  const ready = judgeConfig ? ["judged", "reported", "cleaned"] : ["produced", "reported", "cleaned"];
  if (!ready.includes(state.state)) {
    throw new UserError(`Run must be ${judgeConfig ? "judged" : "produced"} before reporting; current state is ${state.state}`);
  }
  const audit = await readJson<AuditReport>(join(run.runDir, "audit", "report.json"));
  const judgment = judgeConfig ? await readJudgment(run) : null;
  const checks = await readOptionalJson<{ checks: StartCheck[] }>(join(run.runDir, "checks.json"));
  const arms = run.config.arms;
  const labels = arms.map((arm) => arm.label);
  const environments = arms.map((arm) => environmentFor(run.config, arm));
  const reused = Object.fromEntries(await Promise.all(arms.filter((arm) => arm.reuse).map(async (arm) =>
    [arm.label, await readReuseRecord(run.runDir, producerOf(run.assignment, arm.label))] as const)));
  const producers: Record<string, AgentIdentity> = Object.fromEntries(
    arms.map((arm) => [arm.label, reused[arm.label]?.producer ?? agentIdentity(producerFor(run.config.producer, arm))]),
  );
  const cost = async (label: string) =>
    armCost(producers[label]!, await readOptionalJson<CostRecord>(join(run.runDir, "cost", `${producerOf(run.assignment, label)}.json`)));
  const sourceManifest = await readJson<FileManifest>(join(run.runDir, "manifests", "source.json"));
  const candidateHashes = await Promise.all(arms.filter((arm) => arm.candidate).map(async (arm) => {
    const manifest = await readJson<FileManifest>(join(run.runDir, "manifests", `candidate-${arm.label}.json`));
    return `Candidate hash (${arm.label}): ${manifestFingerprint(manifest)}`;
  }));

  const omittedShared = await readOptionalJson<string[]>(join(run.runDir, "audit", "omitted-shared-files.json"));
  const warnings = [
    ...Object.entries(reused).map(([label, reuse]) => `${label} reuses the fixed output from ${reuse.run}/${reuse.arm}; this is not an independent producer sample. No producer ran and historical time/tokens are not counted again. Output hash: ${reuse.outputHash}`),
    ...Object.entries(state.producers)
      .filter(([, producer]) => producer.timedOut)
      .map(([producerId]) => `Producer ${producerId} (${run.assignment.arms[producerId]}) hit its timeout; its output is what was on disk at the cutoff`),
    ...(omittedShared ?? []).map((path) => `Shared file omitted from every arm because it names a candidate: ${path}`),
    ...audit.warnings,
    ...(judgment?.warnings ?? []),
  ];
  const shots = (await readShotIndex(run.runDir)) ?? null;
  const produced: ProducedResult = {
    runId: run.runId,
    name: run.config.name,
    series: run.config.series ?? null,
    task: run.config.task,
    reportedAt: new Date().toISOString(),
    environment: environments.every((environment) => environment === environments[0]) ? environments[0]! : "mixed",
    arms: arms.map((arm, index) => ({
      label: arm.label,
      environment: environments[index]!,
      ...(arm.reuse ? { reuse: arm.reuse } : {}),
      candidate: arm.candidate?.path ?? null,
      replaces: arm.candidate?.replaces ?? null,
    })),
    producers,
    cost: Object.fromEntries(await Promise.all(labels.map(async (label) => [label, await cost(label)]))),
    warnings,
    shots,
  };
  const result: RunResult = judgment && judgeConfig
    ? {
        ...produced,
        judged: true,
        judgeAgent: agentIdentity(judgeConfig),
        winner: judgment.revealed.winner,
        confidence: judgment.verdict.confidence,
        totals: judgment.revealed.totals,
        margin: judgment.revealed.margin,
        scores: judgment.revealed.scores,
        referenceGuess: judgment.revealed.referenceGuess,
        summary: judgment.revealed.summary,
      }
    : { ...produced, judged: false };

  const described = labels.map((label) => describeIdentity(producers[label]!));
  const sameProducer = described.every((line) => line === described[0]);
  // Named once when every arm received the same shared folders, per arm when
  // a candidate dependency gave one of them something of its own.
  const material = labels.map((label) => describeSharedMaterial(run.config, armFor(run.config, label), omittedShared ?? []));
  const sharedMaterial = material.every((line) => line === material[0])
    ? [`Shared material: ${material[0]}`]
    : labels.map((label, index) => `Shared material (${label}): ${material[index]}`);
  const setup = [
    ...(sameProducer
      ? [`Producer: ${described[0]}`]
      : labels.map((label, index) => `Producer (${label}): ${described[index]}`)),
    ...labels.flatMap((label) => describeToolSetup(label, producers[label]!)),
    judgeConfig ? `Judge: ${describeIdentity(agentIdentity(judgeConfig))}` : "Judge: none; this run was not judged",
    ...(produced.environment === "mixed"
      ? labels.map((label, index) => `Skill environment (${label}): ${environments[index]}`)
      : [`Skill environment: ${produced.environment}`]),
    ...sharedMaterial,
    // A clean run has no baseline to withhold skills from.
    ...(produced.environment === "clean" ? [] : [`Baseline skills withheld: ${run.config.skills.exclude.join(", ") || "none"}`]),
    ...(arms.some((arm) => arm.candidate || arm.reuse) ? [] : ["No candidate skill: the arms differ only in producer settings"]),
    ...arms.filter((arm) => arm.candidate?.replaces).map((arm) => `${arm.label} replaces the baseline skill: ${arm.candidate!.replaces}`),
    `Sandbox: ${run.config.sandbox ? "deny-list Seatbelt profile" : "off (scrubbed environment only)"}`,
    `Runtime: Node ${process.version}`,
    ...(checks?.checks ?? []).filter((check) => check.name.endsWith(" CLI")).map((check) => `${check.name}: ${check.detail ?? "available"}`),
  ];
  const integrity = [
    ...(warnings.length > 0 ? warnings.map((warning) => `Warning: ${warning}`) : ["No audit warnings."]),
    ...candidateHashes,
    `Source hash: ${manifestFingerprint(sourceManifest)}`,
    ...(judgment
      ? [
          `Rubric hash: ${judgment.rubricHash}`,
          "Blinding limit: the scan catches explicit names, paths, and copied experiment files. A judge may still guess an arm from style, structure, naming, or polish.",
          "One run is one sample. Agent output varies between runs, so treat the verdict as evidence, not proof; repeat the experiment when the decision matters.",
        ]
      : [
          "No judgment: this run had no rubric and no judge, so nothing here ranks the arms. Read the outputs and the captures.",
          "One run is one sample. Agent output varies between runs, so these outputs are one draw from each arm, not a characterization of it.",
        ]),
  ];
  const percent = (value: number) => `${Math.round(value * 100)}%`;

  const markdown = [
    `# ${run.config.name}`,
    "",
    `Run: \`${run.runId}\``,
    `Date: ${result.reportedAt}`,
    ...(result.series ? [`Series: ${result.series}`] : []),
    `Question: ${run.config.task}`,
    "",
    "## Result",
    "",
    ...(judgment
      ? [
          `${describeOutcome(result)}: ${labels.map((label) => `${label} ${judgment.revealed.totals[label]!.toFixed(2)}`).join(", ")} weighted; judge confidence ${percent(judgment.verdict.confidence)}.`,
          "",
          `| Criterion | Weight | ${labels.join(" | ")} |`,
          `|---|---:|${labels.map(() => "---:").join("|")}|`,
          ...judgment.revealed.scores.map((score) => `| ${score.criterion} | ${score.weight} | ${labels.map((label) => score.scores[label]).join(" | ")} |`),
          "",
          ...(judgment.revealed.summary ? [judgment.revealed.summary, ""] : []),
          labels.length < 2
            ? "One arm ran alone: the judge scored it against the rubric rather than picking a winner."
            : judgment.revealed.referenceGuess.arm === null
              ? "The judge could not tell which output was the control arm."
              : `Control arm guess: ${judgment.revealed.referenceGuess.arm} at ${percent(judgment.revealed.referenceGuess.confidence)} (${judgment.revealed.referenceGuess.correct ? "correct" : "wrong"}).`,
        ]
      : [NOT_JUDGED_NOTE]),
    "",
    "## Setup",
    "",
    ...setup.map((line) => `- ${line}`),
    "",
    ...(judgment
      ? [
          "## Assignment",
          "",
          ...Object.entries(judgment.armOf).map(([letter, label]) => `- ${letter}: ${label}`),
          "",
          "## Judge verdict",
          "",
          judgment.text.trim(),
          "",
        ]
      : pagesSection(labels, shots)),
    "## Time and tokens",
    "",
    ...labels.map((label) => `- ${label}: ${reused[label] ? "frozen output; no new producer time or tokens" : describeCost(result.cost[label]!)}`),
    "",
    "## Integrity",
    "",
    ...integrity.map((line) => `- ${line}`),
    "",
  ].join("\n");

  await writeJson(join(run.runDir, "result.json"), result);
  await writePrivateFile(join(run.runDir, "report.html"), renderReportHtml({ result, verdict: judgment?.text ?? null, setup, integrity }));
  const path = join(run.runDir, "report.md");
  await writePrivateFile(path, markdown);
  if (state.state === "judged" || state.state === "produced") await setRunState(run.runDir, "reported");
  return path;
}

/** The verdict as the report reads it: revealed, with the warnings only a judged run can raise. */
interface Judgment {
  armOf: Record<JudgeOutput, string>;
  verdict: Verdict;
  revealed: RevealedVerdict;
  /** The judge's prose, with links pointing at the evidence saved beside the report. */
  text: string;
  rubricHash: string;
  warnings: string[];
}

async function readJudgment(run: ResolvedRun): Promise<Judgment> {
  const mapping = await readJson<Record<JudgeOutput, string>>(join(run.runDir, "judge", "mapping.json"));
  const packageScan = await readOptionalJson<{ findings: LeakFinding[]; withheld?: string[] }>(join(run.runDir, "judge", "package-scan.json"));
  const evidence = await reportEvidence(run.runDir, await readFile(join(run.runDir, "judge", "verdict.md"), "utf8"));
  const verdict = await readOptionalJson<Verdict>(join(run.runDir, "judge", "verdict.json"));
  if (!verdict) throw new UserError("This run was judged before verdict.json existed; run crucible judge again for a structured result");
  const armOf = Object.fromEntries(Object.entries(mapping).map(([letter, producerId]) => [letter, run.assignment.arms[producerId]!]));
  const revealed = revealVerdict(verdict, armOf, run.config.arms.map((arm) => arm.label));
  return {
    armOf,
    verdict,
    revealed,
    text: evidence.text,
    rubricHash: await sha256File(join(run.runDir, "rubric.md")),
    warnings: [
      ...evidence.warnings,
      ...(packageScan?.findings ?? []).map((finding) => `Judge package names a candidate: ${finding.path} (${finding.identity.label})`),
      ...(packageScan?.withheld ?? []),
      // The judge's own choice stands, but a winner that did not score highest is
      // worth saying out loud rather than leaving to a reader of the numbers.
      ...(revealed.margin !== null && revealed.margin < 0
        ? [`The judge named ${revealed.winner} the winner although ${topScorer(revealed.totals, revealed.winner)} had the higher weighted total`]
        : []),
    ],
  };
}

/** What an unjudged report shows instead of a verdict: the captures, and where they came from. */
function pagesSection(labels: string[], shots: ShotIndex | null): string[] {
  // An arm with no pictures is named rather than left out, so the section
  // always accounts for every arm.
  const pictures = shots === null ? [] : labels.flatMap((label) => {
    const taken = shots.arms[label] ?? [];
    if (taken.length === 0) return [`- ${label}: nothing pictured`];
    return taken.flatMap((shot) => [
      `- ${label}, \`${shot.page}\`:`,
      ...(["desktop", "phone"] as const).map((viewport) => shot[viewport]
        ? `  - [${viewport}](${shot[viewport]})`
        : `  - ${viewport}: no picture${shot.error ? ` (${shot.error})` : ""}`),
    ]);
  });
  return [
    "## Pages",
    "",
    ...(shots?.skipped ? [shots.skipped] : pictures.length > 0 ? pictures : ["Nothing has been captured yet; run crucible capture."]),
    "",
    ...(shots?.capturedBy === "runner" ? [RUNNER_CAPTURE_NOTE, ""] : []),
  ];
}

/** Remove producer working directories; preserve the run record and frozen inputs. */
export async function cleanRun(run: RunLocation): Promise<string[]> {
  const state = await readRunState(run.runDir);
  if (state.state === "running") {
    throw new UserError(`Refusing cleanup while producers run; stop the run first: crucible stop ${run.runId}`);
  }
  await removeTree(run.tempDir);
  if (state.state === "reported") await setRunState(run.runDir, "cleaned");
  return [run.tempDir];
}
