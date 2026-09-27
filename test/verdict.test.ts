import assert from "node:assert/strict";
import test from "node:test";
import { judgeLetters, parseVerdict, revealVerdict, weightedTotal } from "../src/verdict.js";

test("ten anonymous outputs can be scored and revealed, including a winner at J", () => {
  const letters = judgeLetters(10);
  assert.deepEqual(letters, ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
  assert.throws(() => judgeLetters(11), /1 to 10 arms/);
  const labels = letters.map((letter) => `variant-${letter.toLowerCase()}`);
  const verdict = parseVerdict({
    winner: "J", confidence: 0.8,
    scores: [{ criterion: "quality", weight: 1, scores: Object.fromEntries(letters.map((letter, index) => [letter, index + 1])) }],
    referenceGuess: { output: "A", confidence: 0.2 },
    summary: "Output J is clearest. I's conclusion is shorter.",
  }, letters);
  const revealed = revealVerdict(verdict, Object.fromEntries(letters.map((letter, index) => [letter, labels[index]!])), labels);
  assert.equal(revealed.winner, "variant-j");
  assert.equal(revealed.margin, 1);
  assert.equal(revealed.summary, "variant-j is clearest. variant-i's conclusion is shorter.");
  assert.deepEqual(Object.keys(revealed.totals), labels);
  assert.equal(revealed.totals["variant-j"], 10);
});

test("candle totals round decimal halves consistently with their weighted scores", () => {
  const verdict = parseVerdict({
    winner: "A",
    confidence: 0.77,
    scores: [
      { criterion: "Candle realism", weight: 30, scores: { A: 6.5, B: 5.5 } },
      { criterion: "Flame realism and animation", weight: 30, scores: { A: 7, B: 6.5 } },
      { criterion: "Lighting and overall visual finish", weight: 25, scores: { A: 6, B: 6.5 } },
      { criterion: "Working wordless showcase", weight: 15, scores: { A: 10, B: 10 } },
    ],
  }, ["A", "B"]);
  // The unrounded weighted means are 6.725 and 7.05.
  assert.equal(weightedTotal(verdict.scores, "B"), 6.73);
  assert.equal(weightedTotal(verdict.scores, "A"), 7.05);
  const assignment = { A: "with-skill", B: "without-skill" };
  const labels = ["without-skill", "with-skill"];
  const revealed = revealVerdict(verdict, assignment, labels);
  assert.deepEqual(revealed.totals, { "without-skill": 6.73, "with-skill": 7.05 });
  assert.equal(revealed.margin, 0.32);
  assert.equal(revealVerdict({ ...verdict, winner: "B" }, assignment, labels).margin, -0.32);
});
