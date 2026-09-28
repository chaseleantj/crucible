// What a judge decided, in words, for a question and for one run.
import { percent } from "./format";
import type { JudgedRun, Question, RunResult } from "./types";

/** A result written before the runner could skip the judge carries no flag, and was judged. */
export const isJudged = (result: RunResult): result is JudgedRun => result.judged !== false;

export const NOT_JUDGED = "Not judged";

/** A question's judged runs, newest first. */
export const judgedRuns = (question: Question): JudgedRun[] =>
  question.runs.map((run) => run.result).filter((r): r is JudgedRun => r !== null && isJudged(r));

/**
 * How far the winner leads the best other arm: a lone run's margin, or a
 * series' on mean totals. Null for a tie, a single arm, or no verdict.
 */
export function questionMargin(question: Question): number | null {
  const winner = question.winner;
  if (winner === null || winner === "tie") return null;
  const judged = judgedRuns(question);
  if (judged.length === 1) return judged[0]!.margin;
  const own = question.meanTotals[winner];
  const others = question.arms.filter((arm) => arm !== winner).map((arm) => question.meanTotals[arm]).filter((v): v is number => v != null);
  if (own == null || others.length === 0) return null;
  return Number((own - Math.max(...others)).toFixed(2));
}

/** The judge a question's newest judged run used, in full. */
export const questionJudge = (question: Question) => judgedRuns(question)[0]?.judgeAgent;

/** The judge's confidence in its verdict, as a run's fact. */
export const confidenceLine = (result: JudgedRun) => (result.confidence === 0 ? "Not recorded" : percent(result.confidence));

/** What the blind judge made of which arm was the control; null when there was none to guess. */
export function controlGuess(result: JudgedRun): { text: string; correct: boolean | null } | null {
  const guess = result.referenceGuess;
  if (!guess || result.arms.length === 1) return null;
  if (guess.arm === null) return { text: "Did not guess", correct: null };
  return { text: `${guess.arm}, ${percent(guess.confidence)} confident`, correct: guess.correct };
}

/** "claude · claude-opus-5 · low", leaving out what the record did not say. */
export const identity = (who: { agent: string; model: string | null; effort: string | null } | undefined) =>
  who ? [who.agent, who.model, who.effort].filter(Boolean).join(" · ") : "—";
