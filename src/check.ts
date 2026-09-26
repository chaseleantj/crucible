// What a valid archive entry is: the folder `crucible archive` writes, and the
// result.json inside it that every reader trusts. `crucible archive` refuses to
// publish an entry these rules reject, and `crucible check` applies them to
// entries already on disk.
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { isMacJunk } from "./files.js";
import { WORKING_STATE, experimentVisualPreviews, isPreviewImage } from "./previews.js";
import { containedFile } from "./scan-files.js";
import type { RunResult } from "./types.js";
import { isJudged } from "./verdict.js";

/** An archive README is a short note; the report and result carry the detail. */
export const README_WORD_LIMIT = 200;

const REQUIRED_FILES = ["README.md", "result.json", "report.html"];
const ALLOWED_FOLDERS = ["outputs", "dependencies"];

export const wordCount = (text: string) => text.trim().split(/\s+/u).filter(Boolean).length;

/** Why a README is not a short note, or null when it is. */
export function readmeIssue(text: string): string | null {
  const words = wordCount(text);
  return !words || words > README_WORD_LIMIT ? `README.md has ${words} words; expected 1–${README_WORD_LIMIT}` : null;
}

/** Problems with one archive entry's layout and files. An empty list means it conforms. */
export function entryIssues(directory: string): string[] {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return ["Entry is not a directory"];
  const errors: string[] = [];
  // Finder recreates its metadata whenever someone browses the archive, so it is not the entry's content.
  const names = readdirSync(directory).filter((name) => !isMacJunk(name));
  const file = (name: string) => names.includes(name) && lstatSync(join(directory, name)).isFile();
  const required = (name: string) => {
    if (!file(name)) errors.push(`Missing file: ${name}`);
    return file(name);
  };
  if (required("README.md")) {
    const issue = readmeIssue(readFileSync(join(directory, "README.md"), "utf8"));
    if (issue) errors.push(issue);
  }
  let result: unknown = null;
  if (required("result.json")) {
    try { result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8")); } catch { result = null; }
    if (!isObject(result)) errors.push("result.json must contain a JSON object");
  }
  required("report.html");
  for (const name of names) {
    if (!REQUIRED_FILES.includes(name) && !ALLOWED_FOLDERS.includes(name)) errors.push(`Unexpected entry: ${name}`);
    if (ALLOWED_FOLDERS.includes(name) && !lstatSync(join(directory, name)).isDirectory()) errors.push(`${name} must be a directory`);
  }
  const walk = (path: string) => {
    for (const name of readdirSync(path).filter((name) => !isMacJunk(name))) {
      const entry = join(path, name);
      const info = lstatSync(entry);
      const local = entry.slice(directory.length + 1);
      if (info.isSymbolicLink()) errors.push(`Symlinks are not portable: ${local}`);
      else if (info.isDirectory()) {
        if (WORKING_STATE.includes(name)) errors.push(`Installed packages or working state: ${local}`);
        else walk(entry);
      }
    }
  };
  walk(directory);
  errors.push(...missingPreviews(directory, isObject(result) ? result : null));
  return errors;
}

/**
 * Problems with a standalone copy of an archived run, such as one a case study
 * keeps: only result.json, outputs/, and dependencies/shots/ travel, so only
 * the result and each visual arm's screenshot are checked. `name` prefixes the
 * messages when the caller holds several copies.
 */
export function copiedRunIssues(directory: string, name = ""): string[] {
  let result: unknown = null;
  try { result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8")); } catch { result = null; }
  const where = name ? `${name}/` : "";
  if (!isObject(result)) return [`${where}result.json must contain a JSON object`];
  return missingPreviews(directory, result, name);
}

/**
 * A visual arm needs a picture, unless every capture of it says why there is
 * none: an output that never renders is still a result worth archiving.
 */
function missingPreviews(directory: string, result: Record<string, unknown> | null, name = ""): string[] {
  const shots = isObject(result?.shots) && isObject(result.shots.arms) ? result.shots.arms : {};
  const explained = (label: string) => {
    const captures = shots[label];
    return Array.isArray(captures) && captures.length > 0 && captures.every((shot) => isObject(shot) && text(shot.error) && shot.error.trim() !== "");
  };
  return Object.entries(experimentVisualPreviews(directory, result))
    .filter(([label, preview]) => preview.required && !preview.path && !explained(label))
    .map(([label]) => `Visual output ${label}${name ? ` of ${name}` : ""} requires a representative screenshot in result.json shots.arms or dependencies/shots/${label}/`);
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const optionalText = (value: unknown) => value == null || text(value);
const identity = (value: unknown) => isObject(value) && [value.agent, value.model, value.effort].every(optionalText);
const numbers = (value: unknown) => isObject(value) && Object.values(value).every(finite);
const probability = (value: unknown) => finite(value) && value >= 0 && value <= 1;

/**
 * Problems with a saved result.json: the fields a reader relies on, checked
 * before anything is shown from it. A `legacy: true` result is a hand-written
 * comparison and makes no claims to check.
 */
export function resultIssues(result: unknown): string[] {
  if (!isObject(result)) return ["result.json must contain an object"];
  if (result.legacy === true) return [];
  const issues: string[] = [];
  const check = (valid: boolean, field: string) => { if (!valid) issues.push(`result.json has invalid ${field}`); };
  for (const key of ["runId", "name", "task"]) check(text(result[key]), key);
  check(text(result.reportedAt) && Number.isFinite(Date.parse(result.reportedAt)), "reportedAt");
  check(optionalText(result.series), "series");
  check(result.environment == null || ["realistic", "clean", "mixed"].includes(result.environment as string), "environment");
  check(result.judged == null || typeof result.judged === "boolean", "judged");
  const arms = result.arms;
  const armsValid = Array.isArray(arms) && arms.length > 0 && arms.every((arm: unknown) =>
    isObject(arm) && text(arm.label) && arm.label.length > 0 && arm.label !== "tie" &&
    optionalText(arm.candidate) && optionalText(arm.replaces) &&
    (arm.environment == null || ["realistic", "clean"].includes(arm.environment as string)));
  const labels = armsValid ? (arms as Array<{ label: string }>).map((arm) => arm.label) : [];
  check(armsValid && new Set(labels).size === labels.length, "arms (expected unique labels)");
  const producers = result.producers;
  check(isObject(producers) && labels.every((label) => identity(producers[label])), "producers");
  check(Array.isArray(result.warnings) && result.warnings.every(text), "warnings");
  check(result.cost == null || (isObject(result.cost) && Object.values(result.cost).every((cost) => cost === null ||
    (isObject(cost) && finite(cost.wallTimeMs) && (cost.tokens == null ||
      (isObject(cost.tokens) && ["input", "output", "cacheRead"].every((key) => finite((cost.tokens as Record<string, unknown>)[key]))))))), "cost");
  if (isJudged(result as unknown as RunResult)) verdictIssues(result, labels, check);
  return issues;
}

/**
 * What a judge adds to a run: the call, the scores behind it, and how well it
 * saw through the blinding. A run with one arm has nothing to compare against,
 * so it records no margin, and no baseline worth guessing.
 */
function verdictIssues(result: Record<string, unknown>, labels: string[], check: (valid: boolean, field: string) => void): void {
  check(text(result.summary), "summary");
  check(result.winner === "tie" || labels.includes(result.winner as string), "winner");
  check(numbers(result.totals), "totals");
  check(finite(result.margin) || result.margin === null, "margin");
  check(probability(result.confidence), "confidence");
  check(identity(result.judgeAgent), "judgeAgent");
  check(Array.isArray(result.scores) && result.scores.every((score: unknown) =>
    isObject(score) && text(score.criterion) && finite(score.weight) && numbers(score.scores)), "scores");
  const guess = result.referenceGuess;
  check(guess == null
    ? labels.length === 1
    : isObject(guess) && (guess.arm === null || labels.includes(guess.arm as string)) &&
      probability(guess.confidence) && [null, true, false].includes(guess.correct as boolean | null), "referenceGuess");
}

/** Problems with a valid result's screenshot index: each capture must be an image inside the archive. */
export function previewIssues(directory: string, result: RunResult): string[] {
  const issues: string[] = [];
  const shots = result.shots?.arms as unknown;
  if (result.shots != null && !isObject(result.shots)) issues.push("result.json shots must be an object");
  if (shots != null && !isObject(shots)) issues.push("result.json shots.arms must map arm labels to screenshot lists");
  // Older archives sometimes kept the blinded control/treatment labels.
  // Validate those captures too, without renaming arms.
  const shotMap = isObject(shots) ? shots : null;
  const labels = [...new Set([...result.arms.map((arm) => arm.label), ...(shotMap ? Object.keys(shotMap) : [])])];
  for (const label of labels) {
    const entries = shotMap?.[label];
    if (entries == null) continue;
    if (!Array.isArray(entries)) {
      issues.push(`shots.arms.${label} must be a screenshot list`);
      continue;
    }
    for (const entry of entries as unknown[]) {
      if (!isObject(entry)) {
        issues.push(`shots.arms.${label} contains an invalid screenshot`);
        continue;
      }
      for (const field of ["artifact", "page"]) {
        if (entry[field] != null && typeof entry[field] !== "string") issues.push(`shots.arms.${label} ${field} must be a file reference`);
      }
      for (const kind of ["desktop", "mobile", "phone"]) {
        const relative = entry[kind];
        if (relative == null) continue;
        const file = containedFile(directory, relative);
        if (!file || !isPreviewImage(extname(file))) {
          issues.push(`${label} ${kind}: missing, unsupported, or outside this archive: ${String(relative)}`);
        }
      }
    }
  }
  return issues;
}
