import { UserError } from "./errors.js";
import { MAX_ARMS, MIN_ARMS } from "./config.js";
import type { CriterionScore, JudgeOutput, JudgedResult, RunResult, Verdict } from "./types.js";

const SCORE_MAX = 10;
const DECIMALS = 2;
const FIRST_LETTER = "A".codePointAt(0)!;

/**
 * Whether a sealed run carries a verdict. Only a run of an experiment with
 * `judge: none` says `judged: false`; results sealed before judging could be
 * skipped carry no flag and were judged.
 */
export function isJudged(result: RunResult): result is JudgedResult {
  return result.judged !== false;
}

/** The anonymous names one run's outputs get: A, B, C, … one per arm. */
export function judgeLetters(count: number): JudgeOutput[] {
  if (count < MIN_ARMS || count > MAX_ARMS) throw new Error(`A run has ${MIN_ARMS} to ${MAX_ARMS} arms, not ${count}`);
  return Array.from({ length: count }, (_, index) => String.fromCodePoint(FIRST_LETTER + index));
}

/**
 * The judge writes verdict.json by hand, so its shape is checked here and
 * nowhere else. A confidence given in percent is accepted and scaled; anything
 * else that is off is a reason to judge again, not to guess. A lone output has
 * no control to pick out, so its reference guess is dropped rather than read.
 */
export function parseVerdict(raw: unknown, letters: JudgeOutput[]): Verdict {
  const named = `"${letters.join('", "')}"`;
  const value = requireRecord(raw, "verdict");
  const winner = value.winner;
  if (typeof winner !== "string" || (winner !== "tie" && !letters.includes(winner))) throw invalid(`winner must be ${named}, or "tie"`);
  if (!Array.isArray(value.scores) || value.scores.length === 0) throw invalid("scores must be a non-empty list");
  const scores = value.scores.map((entry, index) => parseScore(entry, index, letters));
  if (scores.every((score) => score.weight === 0)) throw invalid("at least one criterion needs a weight above zero");
  const guess = requireRecord(letters.length > 1 ? value.referenceGuess ?? {} : {}, "referenceGuess");
  const output = guess.output ?? null;
  if (output !== null && (typeof output !== "string" || !letters.includes(output))) throw invalid(`referenceGuess.output must be ${named}, or null`);
  return {
    winner,
    confidence: probability(value.confidence, "confidence"),
    scores,
    referenceGuess: { output, confidence: probability(guess.confidence ?? 0, "referenceGuess.confidence") },
    summary: typeof value.summary === "string" ? value.summary.trim() : "",
  };
}

/** Weighted mean of the criterion scores for one side, on the rubric's scale. */
export function weightedTotal<Side extends string>(scores: CriterionScore<Side>[], side: Side): number {
  const weight = scores.reduce((sum, score) => sum + score.weight, 0);
  const total = scores.reduce((sum, score) => sum + score.weight * score.scores[side], 0) / weight;
  return round(total);
}

export interface RevealedVerdict {
  /** An arm's label, or "tie". */
  winner: string;
  /** The judge's summary with any "Output A" turned into that arm's label. */
  summary: string;
  scores: CriterionScore<string>[];
  totals: Record<string, number>;
  /** Null when one arm ran alone: there is no runner-up to measure against. */
  margin: number | null;
  referenceGuess: { arm: string | null; confidence: number; correct: boolean | null };
}

/**
 * The same verdict with the letters replaced by the arms they stood for. The
 * winner is the judge's own choice: the runner reports the verdict it was given
 * and never rewrites it from the totals, so the margin comes out negative when
 * the judge named an arm that did not score highest. The labels are given in
 * run order, reference first, so the result reads in that order.
 */
export function revealVerdict(verdict: Verdict, armOf: Record<JudgeOutput, string>, labels: string[]): RevealedVerdict {
  const referenceLabel = labels[0]!;
  const scores = verdict.scores.map((score) => ({
    criterion: score.criterion,
    weight: score.weight,
    scores: Object.fromEntries(labels.map((label) => [label, score.scores[letterOf(armOf, label)]!])),
  }));
  const totals = Object.fromEntries(labels.map((label) => [label, weightedTotal(scores, label)]));
  const winner = verdict.winner === "tie" ? "tie" : armOf[verdict.winner]!;
  const guessed = verdict.referenceGuess.output ? armOf[verdict.referenceGuess.output]! : null;
  return {
    winner,
    summary: nameOutputs(verdict.summary, armOf),
    scores,
    totals,
    margin: labels.length < 2 ? null : winner === "tie" ? 0 : round(totals[winner]! - bestOther(totals, winner)),
    referenceGuess: {
      arm: guessed,
      confidence: verdict.referenceGuess.confidence,
      correct: guessed === null ? null : guessed === referenceLabel,
    },
  };
}

/**
 * The judge is asked not to name its outputs in the summary, and a summary that
 * does anyway is corrected here: "Output A" and "A's" become the arm's label.
 * A bare letter is left alone — it is usually the article or an initial.
 */
export function nameOutputs(text: string, armOf: Record<JudgeOutput, string>): string {
  const letters = Object.keys(armOf).join("");
  return text
    .replace(new RegExp(`\\b[Oo]utput ([${letters}])\\b`, "g"), (_, output: string) => armOf[output]!)
    .replace(new RegExp(`\\b([${letters}])'s\\b`, "g"), (_, output: string) => `${armOf[output]!}'s`);
}

/** The best total any arm other than the winner scored: the runner-up the margin is measured against. */
export function bestOther(totals: Record<string, number>, winner: string): number {
  const others = Object.entries(totals).filter(([label]) => label !== winner).map(([, total]) => total);
  if (others.length === 0) throw new Error(`A run has more than one arm, so ${winner} cannot be the only total`);
  return Math.max(...others);
}

/** The arm that scored best among those the judge did not name the winner. */
export function topScorer(totals: Record<string, number>, winner: string): string {
  const best = bestOther(totals, winner);
  return Object.keys(totals).find((label) => label !== winner && totals[label] === best)!;
}

function letterOf(armOf: Record<JudgeOutput, string>, label: string): JudgeOutput {
  const letter = Object.keys(armOf).find((key) => armOf[key] === label);
  if (!letter) throw new Error(`The judge saw no output for ${label}`);
  return letter;
}

function parseScore(raw: unknown, index: number, letters: JudgeOutput[]): CriterionScore<JudgeOutput> {
  const value = requireRecord(raw, `scores[${index}]`);
  if (typeof value.criterion !== "string" || value.criterion.trim() === "") throw invalid(`scores[${index}].criterion must be a non-empty string`);
  const weight = finite(value.weight, `scores[${index}].weight`);
  if (weight < 0) throw invalid(`scores[${index}].weight must not be negative`);
  const sides = requireRecord(value.scores, `scores[${index}].scores`);
  const score = (side: JudgeOutput) => {
    const number = finite(sides[side], `scores[${index}].scores.${side}`);
    if (number < 0 || number > SCORE_MAX) throw invalid(`scores[${index}].scores.${side} must be between 0 and ${SCORE_MAX}`);
    return number;
  };
  return { criterion: value.criterion.trim(), weight, scores: Object.fromEntries(letters.map((letter) => [letter, score(letter)])) };
}

function probability(raw: unknown, label: string): number {
  const number = finite(raw, label);
  const scaled = number > 1 && number <= 100 ? number / 100 : number;
  if (scaled < 0 || scaled > 1) throw invalid(`${label} must be between 0 and 1`);
  return round(scaled);
}

function finite(raw: unknown, label: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw invalid(`${label} must be a number`);
  return raw;
}

function requireRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid(`${label} must be an object`);
  return raw as Record<string, unknown>;
}

function invalid(reason: string): UserError {
  return new UserError(`Judge wrote an invalid verdict.json (${reason}); run crucible judge again`);
}

function round(value: number): number {
  const factor = 10 ** DECIMALS;
  return Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * factor) / factor;
}
