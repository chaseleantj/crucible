// What a judge decided, in words, for a question and for one run.
import { percent, plural } from "./format";
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

/** One run's verdict: "control wins by 0.27", "Tie", "a scored 7.50". */
export function runHeadline(run: JudgedRun): string {
  if (run.winner === "tie") return "Tie";
  if (run.margin === null) return `${run.winner} scored ${run.totals[run.winner]?.toFixed(2) ?? "—"}`;
  if (run.margin < 0.005) return `${run.winner} wins on the judge's call, with equal totals`;
  return `${run.winner} wins by ${run.margin.toFixed(2)}`;
}

/**
 * The verdict in one line: the headline, then what qualifies it (a series'
 * margin, a leader missing from some runs, judges that differ). Confidence,
 * the judge and the date each live once elsewhere: in the run's facts and
 * the runs table. Null when no run was judged.
 */
export function verdictLine(question: Question): { headline: string; details: string[] } | null {
  const judged = judgedRuns(question);
  const winner = question.winner;
  if (winner === null || judged.length === 0) return null;
  const margin = questionMargin(question);
  if (judged.length === 1) {
    const run = judged[0]!;
    return { headline: runHeadline(run), details: [] };
  }
  const runs = plural(judged.length, "judged run");
  const won = winner === "tie" ? 0 : question.tally[winner] ?? 0;
  // Runs of one arm each are scored, never won, so only the scores compare.
  const scoredOnly = Object.values(question.tally).every((count) => count === 0) && judged.every((run) => run.arms.length === 1);
  let headline: string;
  if (scoredOnly) headline = winner === "tie" ? `Tie on score across ${runs}` : `${winner} scores highest across ${runs}`;
  else if (winner === "tie") headline = `Tie across ${runs}`;
  else if (question.split) {
    const onScore = question.arms.some((arm) => arm !== winner && question.tally[arm] === won);
    headline = onScore ? `${winner} leads on score, runs split` : `${winner} leads with ${won} of ${runs}, runs split`;
  } else headline = `${winner} wins ${won} of ${runs}`;
  const details: string[] = [];
  if (margin !== null && margin > 0) details.push(`by ${margin.toFixed(2)} on mean total`);
  // A leader scored in fewer runs than the series has rests on less than it looks.
  const scored = winner === "tie" ? judged.length : judged.filter((run) => typeof run.totals[winner] === "number").length;
  if (winner !== "tie" && !scoredOnly && scored < judged.length) details.push(`${winner} ran in ${scored} of ${plural(judged.length, "run")}`);
  // Runs scored by different judges compare less well: say so here, since each run names only its own.
  const judges = new Set(judged.map((run) => identity(run.judgeAgent)));
  if (judges.size > 1) details.push(`${judges.size} different judges`);
  return { headline, details };
}

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
