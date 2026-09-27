import assert from "node:assert/strict";
import test from "node:test";
import { armCost, describeCost } from "../src/cost.js";
import { identity } from "./support/run.js";

test("an arm reports its time and tokens, and says so when usage is missing", () => {
  const cost = armCost(identity, { wallTimeMs: 5000, usage: { input_tokens: 1000, output_tokens: 2000 } });
  assert.deepEqual(cost?.tokens, { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(describeCost(cost), "5s; 1k in, 2k out, 0 cache read, 0 cache write");
  assert.equal(armCost(identity, undefined), null);
  assert.equal(describeCost(armCost(identity, { wallTimeMs: 1000, usage: null })), "1s; tokens unavailable");
});
