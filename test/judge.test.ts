import assert from "node:assert/strict";
import test from "node:test";
import { judgePrompt } from "../src/judge.js";
import type { ResolvedRun } from "../src/types.js";
import { judgeLetters, parseVerdict, revealVerdict } from "../src/verdict.js";

test("the judge is told Playwright is available only when its workspace resolves it", () => {
  const run = { config: { task: "Improve the page", arms: [{ label: "baseline" }, { label: "variant" }] } } as ResolvedRun;
  const prompt = (tools: { playwright: boolean; chromium: boolean }) => judgePrompt(run, "/tmp/judge", ["A", "B"], [], tools);
  assert.match(prompt({ playwright: true, chromium: true }), /Playwright is available: require\("playwright"\) resolves from your working directory and its Chromium is installed/);
  assert.match(prompt({ playwright: true, chromium: false }), /its Chromium is not installed/);
  assert.doesNotMatch(prompt({ playwright: false, chromium: false }), /Playwright is available/);
});

test("the judge guesses a reference without assuming which experimental factors varied", () => {
  const letters = judgeLetters(5);
  const prompt = judgePrompt({ config: { task: "Improve the page", arms: [{ label: "baseline" }, { label: "variant" }] } } as ResolvedRun, "/tmp/judge", letters);
  assert.match(prompt, /One of the outputs is the reference configuration/);
  assert.match(prompt, /Configurations may vary prompts, information, models, skills, or tools/);
  assert.match(prompt, /your guess at the control arm/);
  assert.doesNotMatch(prompt, /baseline/i);
  // A judge with nothing to go on may still answer null, and that is not counted as a hit.
  const verdict = parseVerdict({
    winner: "A",
    confidence: 0.5,
    scores: [{ criterion: "quality", weight: 1, scores: { A: 5, B: 6, C: 6, D: 6, E: 6 } }],
    referenceGuess: { output: null, confidence: 0 },
    summary: "",
  }, letters);
  const labels = ["one", "two", "three", "four", "five"];
  const armOf = Object.fromEntries(letters.map((letter, index) => [letter, labels[index]!]));
  assert.deepEqual(revealVerdict(verdict, armOf, labels).referenceGuess, { arm: null, confidence: 0, correct: null });
});
