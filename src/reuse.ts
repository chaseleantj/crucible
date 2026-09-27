import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AuditReport } from "./audit.js";
import { agentIdentity, armFor, producerFor, taskFor } from "./config.js";
import { UserError } from "./errors.js";
import { assertDirectory, buildManifest, copyTree, manifestFingerprint, verifyManifest } from "./files.js";
import { readJson, readOptionalJson, writeJson } from "./json.js";
import { loadRun, producerOf } from "./run.js";
import { readRunState } from "./state.js";
import type { AgentIdentity, Assignment, ExperimentConfig, FileManifest, ForbiddenMaterial, LeakFinding, PathsConfig, ReuseConfig } from "./types.js";

export interface ReuseRecord extends ReuseConfig {
  producer: AgentIdentity;
  frozenAt: string;
  outputHash: string;
  warnings: string[];
  inputs?: string[];
}

interface JudgedInputs {
  directory: string;
  outputs: Record<string, { letter: string; manifest: FileManifest }>;
}

/** Record the exact anonymous inputs before the judge sees them, for verified reuse later. */
export async function recordReusableInputs(runDir: string, inputDir: string, mapping: Record<string, string>): Promise<void> {
  const outputs = Object.fromEntries(await Promise.all(Object.entries(mapping).map(async ([letter, id]) =>
    [id, { letter, manifest: await buildManifest(join(inputDir, letter)) }] as const)));
  await writeJson(join(runDir, "judge", "inputs.json"), { directory: inputDir, outputs } satisfies JudgedInputs);
}

/** Reuse judged evidence, never a producer workspace that may have changed after judging. */
export async function freezeReusedOutputs(runDir: string, config: ExperimentConfig, assignment: Assignment, paths: PathsConfig): Promise<void> {
  const source = manifestFingerprint(await readJson<FileManifest>(join(runDir, "manifests", "source.json")));
  const materialPath = join(runDir, "audit", "forbidden-material.json");
  const material = await readJson<ForbiddenMaterial>(materialPath);
  for (const arm of config.arms) {
    if (!arm.reuse) continue;
    const previous = await loadRun(arm.reuse.run, paths);
    const previousId = producerOf(previous.assignment, arm.reuse.arm);
    const view = await readRunState(previous.runDir);
    const state = view.producers[previousId]!;
    if (state.state !== "complete" || state.timedOut) throw new UserError(`${arm.label}: reused producer must have completed without a timeout`);
    // Reuse copies the exact anonymous input a judge scored, so a run that was
    // never judged — including one whose experiment set judge: none — has
    // nothing to reuse.
    if (!["judged", "reported", "cleaned"].includes(view.state) || view.judge?.state !== "complete") {
      throw new UserError(`${arm.label}: reuse requires a successfully judged run, and ${arm.reuse.run} was not judged`);
    }
    const previousArm = armFor(previous.config, arm.reuse.arm);
    if (taskFor(previous.config, previousArm) !== config.task) throw new UserError(`${arm.label}: reused output has a different task`);
    if (manifestFingerprint(await readJson<FileManifest>(join(previous.runDir, "manifests", "source.json"))) !== source) {
      throw new UserError(`${arm.label}: reused output has different frozen source inputs`);
    }
    const inputs = await readOptionalJson<JudgedInputs>(join(previous.runDir, "judge", "inputs.json"));
    const input = inputs?.outputs[previousId];
    if (!inputs || !input) throw new UserError(`${arm.label}: historical judged-input manifest is unavailable; rejudge the historical run before reuse`);
    const priorReuse = previousArm.reuse ? await readReuseRecord(previous.runDir, previousId) : undefined;
    let previousSource = join(inputs.directory, input.letter);
    if (!(await stat(previousSource).catch(() => null))?.isDirectory() && priorReuse) {
      previousSource = join(previous.runDir, "frozen", previousId, "output");
    }
    await assertDirectory(previousSource, `${arm.label} historical judged input (prepare reuse before cleanup)`);
    const changes = await verifyManifest(previousSource, input.manifest);
    if (changes.length) throw new UserError(`${arm.label}: historical judged input changed: ${changes.join(", ")}`);
    const producerId = producerOf(assignment, arm.label);
    const frozenDir = join(runDir, "frozen", producerId);
    const outputDir = join(frozenDir, "output");
    await copyTree(previousSource, outputDir);
    if ((await verifyManifest(outputDir, input.manifest)).length) throw new UserError(`${arm.label}: copied output does not match historical judged input`);
    await writeJson(join(runDir, "manifests", `${producerId}-output.json`), input.manifest);
    const historicalMaterial = await readJson<ForbiddenMaterial>(join(previous.runDir, "audit", "forbidden-material.json"));
    material.identities.push(...historicalMaterial.identities.map((identity) => ({ ...identity, ...(identity.arm === undefined ? {} : { arm: arm.label }) })));
    material.hashes.push(...historicalMaterial.hashes.map((hash) => ({ ...hash, ...(hash.arm === undefined ? {} : { arm: arm.label }) })));
    const audit = await readJson<AuditReport>(join(previous.runDir, "audit", "report.json"));
    const scan = await readJson<{ findings: LeakFinding[] }>(join(previous.runDir, "judge", "package-scan.json"));
    const omittedShared = await readOptionalJson<string[]>(join(previous.runDir, "audit", "omitted-shared-files.json"));
    const warnings = [
      ...(priorReuse?.warnings ?? []),
      ...(omittedShared ?? []).map((path) => `Historical shared guidance omitted because it named a candidate: ${path}`),
      ...(audit.contextChanges[previousId] ?? []).map((change) => `Historical frozen context changed: ${change}`),
      ...(audit.leakFindings[arm.reuse.arm] ?? []).map((finding) => `Historical producer identity finding: ${finding.path} (${finding.identity.label})`),
      ...scan.findings.filter((finding) => finding.path.startsWith(`${input.letter}/`)).map((finding) => `Historical judge identity finding: ${finding.path.slice(input.letter.length + 1)} (${finding.identity.label})`),
    ];
    await writeJson(join(frozenDir, "reuse.json"), {
      ...arm.reuse,
      producer: priorReuse?.producer ?? agentIdentity(producerFor(previous.config.producer, previousArm)),
      inputs: priorReuse?.inputs ?? Object.keys(previousArm.inputs ?? {}),
      frozenAt: new Date().toISOString(), outputHash: manifestFingerprint(input.manifest), warnings,
    } satisfies ReuseRecord);
  }
  await writeJson(materialPath, material);
}

export function readReuseRecord(runDir: string, producerId: string): Promise<ReuseRecord> {
  return readJson<ReuseRecord>(join(runDir, "frozen", producerId, "reuse.json"));
}
