import { join } from "node:path";
import { buildManifest, removeLinks, verifyManifest } from "./files.js";
import { readJson, writeJson } from "./json.js";
import { hiddenFrom, scanFiles, scanTree } from "./leaks.js";
import { MATERIAL_FILE } from "./prepare.js";
import { readReuseRecord } from "./reuse.js";
import { producerOf } from "./run.js";
import type { FileManifest, ForbiddenMaterial, LeakFinding, ResolvedRun } from "./types.js";

export interface AuditReport {
  runId: string;
  auditedAt: string;
  contextChanges: Record<string, string[]>;
  /** Another arm's candidate material found in an arm's output or logs, per arm label. */
  leakFindings: Record<string, LeakFinding[]>;
  warnings: string[];
}

/**
 * The audit records anything that weakens the run's claims — a modified frozen
 * context, or another arm's candidate identity material in an arm's output or
 * logs. The findings are warnings for the report, not gates: the producers are
 * cooperative, and a warned result is still worth reading.
 */
export async function auditRun(run: ResolvedRun): Promise<AuditReport> {
  const material = await readJson<ForbiddenMaterial>(join(run.runDir, MATERIAL_FILE));
  const contextChanges: Record<string, string[]> = {};
  const leakFindings: Record<string, LeakFinding[]> = {};
  const removedLinks: Record<string, string[]> = {};

  for (const [producerId, label] of Object.entries(run.assignment.arms)) {
    const producerDir = join(run.tempDir, producerId);
    // First, before anything reads the output.
    if (!run.config.arms.find((arm) => arm.label === label)?.reuse) removedLinks[label] = await removeLinks(join(producerDir, "source"));
    const expectedContext = await readJson<FileManifest>(join(run.runDir, "manifests", `${producerId}-context.json`));
    contextChanges[producerId] = await verifyManifest(join(producerDir, ".context"), expectedContext);
    if (run.config.arms.find((arm) => arm.label === label)?.reuse) {
      const output = await readJson<FileManifest>(join(run.runDir, "manifests", `${producerId}-output.json`));
      contextChanges[producerId].push(...(await verifyManifest(join(producerDir, "source"), output)).map((change) => `reused output ${change}`));
    }

    const { identities, hashes } = hiddenFrom(material, label);
    const findings = await scanTree(join(producerDir, "source"), identities, hashes);
    const logRoot = join(run.runDir, "producers", producerId);
    const logManifest = await buildManifest(logRoot);
    findings.push(...await scanFiles(
      logRoot,
      logManifest.entries
        .map((entry) => entry.path)
        .filter((path) => path !== "prompt.txt" && path !== "launch.json"),
      identities,
      hashes,
    ));
    leakFindings[label] = findings;
  }

  const historicalWarnings = await Promise.all(run.config.arms.filter((arm) => arm.reuse).map(async (arm) => {
    const id = producerOf(run.assignment, arm.label);
    return (await readReuseRecord(run.runDir, id)).warnings.map((warning) => `${arm.label} reused from ${arm.reuse!.run}/${arm.reuse!.arm}: ${warning}`);
  }));
  const warnings = [
    ...historicalWarnings.flat(),
    ...Object.entries(contextChanges)
      .filter(([, changes]) => changes.length > 0)
      .map(([producerId, changes]) => `Frozen context changed for ${producerId}: ${changes.join(", ")}`),
    ...Object.entries(removedLinks).filter(([, paths]) => paths.length > 0)
      .map(([label, paths]) => `Removed ${paths.length === 1 ? "a link or special file" : `${paths.length} links or special files`} from ${label}'s output, which Crucible never follows: ${paths.join(", ")}`),
    ...Object.entries(leakFindings).flatMap(([label, findings]) => findings
      .map((finding) => `Candidate identity material from another arm reached ${label}: ${finding.path} (${finding.identity.label})`)),
  ];
  const report: AuditReport = {
    runId: run.runId,
    auditedAt: new Date().toISOString(),
    contextChanges,
    leakFindings,
    warnings,
  };
  await writeJson(join(run.runDir, "audit", "report.json"), report);
  return report;
}
