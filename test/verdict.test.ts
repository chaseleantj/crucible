import assert from "node:assert/strict";
import test from "node:test";
import { parseVerdict, revealVerdict, weightedTotal } from "../src/verdict.js";

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
