import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCode } from "../src/code/parse.ts";
import { boundOfCondition, differs, numberIn, sameLimit } from "../src/rules/code/boundary.ts";
import guardRule from "../src/rules/code/error-message-matches-guard.ts";

test("a comparison gives the bound an accepted value meets, whichever way round it is written", () => {
  assert.deepEqual(boundOfCondition("parsed >= 500", "accepted"), { side: "min", value: 500, inclusive: true });
  assert.deepEqual(boundOfCondition("20 <= parsed", "accepted"), { side: "min", value: 20, inclusive: true });
  // `if (items.length > 50) throw …` rejects above 50, so 50 or fewer is accepted.
  assert.deepEqual(boundOfCondition("items.length > 50", "rejected"), { side: "max", value: 50, inclusive: true });
  assert.deepEqual(boundOfCondition("x < 1_000", "rejected"), { side: "min", value: 1000, inclusive: true });
  assert.deepEqual(boundOfCondition("x < -5", "rejected"), { side: "min", value: -5, inclusive: true });
  // Not a single comparison with a number: left to Jev's other question.
  assert.equal(boundOfCondition("a > b", "accepted"), undefined);
  assert.equal(boundOfCondition("x > 1 && x < 5", "accepted"), undefined);
  assert.equal(boundOfCondition("!isValid(x)", "rejected"), undefined);
});

test("a message is comparable only when it holds one number, close to the condition's", () => {
  assert.equal(numberIn("Must be greater than 500ms"), 500);
  assert.equal(numberIn("x must be -5 or more"), -5);
  assert.equal(numberIn("must hold 1,000 items or fewer"), 1000);
  // A range, a count with an index, and no number at all.
  assert.equal(numberIn("must contain between 3 and 4 parts"), undefined);
  assert.equal(numberIn("must be a string"), undefined);
  // Digits inside an interpolation, a word or a dotted name are not numbers the message states.
  assert.equal(numberIn("items must be at most ${MAX_ITEMS_V2} entries"), undefined);
  assert.equal(numberIn("expected a sha256 digest in utf8"), undefined);
  assert.equal(numberIn("requires v2.1 of the schema"), undefined);
  assert.equal(numberIn("must be at most ${limit} items, got 51"), 51);
  const bound = boundOfCondition("timeout < 1000", "rejected")!;
  // "at least 1s" under `timeout < 1000`: far apart, so perhaps another unit, and nothing is compared.
  assert.equal(sameLimit(bound, 1), false);
  assert.equal(sameLimit(bound, 1000), true);
  assert.equal(sameLimit(bound, 999), true);
});

test("a stated limit differs from the code's when the side or the whole-number boundary does", () => {
  const atLeast500 = boundOfCondition("parsed >= 500", "accepted")!;
  assert.equal(differs(atLeast500, "more_than", 500), true);
  assert.equal(differs(atLeast500, "at_least", 500), false);
  assert.equal(differs(atLeast500, "at_most", 500), true);
  // "more than 499" and "at least 500" accept the same whole numbers.
  assert.equal(differs(atLeast500, "more_than", 499), false);
  // Whatever the message's number is doing, if it is not a limit there is nothing to differ.
  assert.equal(differs(atLeast500, "not_a_limit", 500), false);
});

test("an assertion with a literal message is a guard whose condition is the check negated", async () => {
  const doc = await parseCode(
    "src/config.js",
    `function parseTimeout(timeout) {
  parseAssert("timeout", /^\\d+$/.test(timeout), "Must be an integer");
  const parsed = Number(timeout);
  parseAssert("timeout", parsed >= 500, "Must be greater than 500ms");
  assert(ready, "The store must be ready");
  if (parsed > 60000) throw new RangeError("Timeout must be at most 60000ms");
  if (parsed > 100) throw new RangeError("Timeout must be at least 1s");
  return parsed;
}`,
  );
  assert.deepEqual(
    doc.guards.map((guard) => [guard.form, guard.condition, guard.message]),
    [
      ["assert", "!(/^\\d+$/.test(timeout))", "Must be an integer"],
      ["assert", "!(parsed >= 500)", "Must be greater than 500ms"],
      // `assert(ready, …)`: a bare name shows nothing the message could be compared with, so it is not a guard.
      ["if", "parsed > 60000", "Timeout must be at most 60000ms"],
      ["if", "parsed > 100", "Timeout must be at least 1s"],
    ],
  );
  // The limit question is asked only where code has a bound and the message has one number close to it.
  const asked = guardRule.select(doc).map((candidate) => [candidate.data.error_message, candidate.meta!.accepts, "limit" in guardRule.questions((field) => field, candidate) && guardRule.questions((field) => field, candidate).limit !== undefined]);
  assert.deepEqual(asked, [
    ["Must be an integer", undefined, false],
    ["Must be greater than 500ms", "at least 500", true],
    ["Timeout must be at most 60000ms", "at most 60000", true],
    // 1 against 100: perhaps seconds against something else. Not compared.
    ["Timeout must be at least 1s", undefined, false],
  ]);
});

test("Jev classifies the limit a message states, and code compares it with the condition's", async () => {
  const doc = await parseCode("src/config.js", `function f(parsed) { parseAssert("timeout", parsed >= 500, "Must be greater than 500ms"); }`);
  const [candidate] = guardRule.select(doc);
  const answers = (kind: string, p: number) => ({
    states_requirement: { type: "noul" as const, noul: 0.9 },
    contradicts: { type: "noul" as const, noul: 0.1 },
    limit: { type: "choice" as const, choice: kind, confidence: 1, probabilities: { at_least: 0, more_than: 0, at_most: 0, less_than: 0, not_a_limit: 1 - p, [kind]: p } },
  });
  // The message says "more than 500" and the code accepts 500: the limit differs, whatever the other question made of it.
  const mismatch = guardRule.assess(answers("more_than", 0.9), candidate!);
  assert.equal(mismatch.p, 0.9);
  assert.equal(mismatch.message, 'Error message "Must be greater than 500ms" asks for more than 500, and the code accepts at least 500.');
  // The finding names the likeliest reading that differs, even when another reading is likelier overall.
  const split = guardRule.assess(
    { ...answers("at_least", 0.4), limit: { type: "choice" as const, choice: "at_least", confidence: 0.3, probabilities: { at_least: 0.4, more_than: 0.35, at_most: 0.25, less_than: 0, not_a_limit: 0 } } },
    candidate!,
  );
  assert.ok(Math.abs(split.p - 0.6) < 1e-9);
  assert.match(split.message, /asks for more than 500, and the code accepts at least 500/);
  // Read as "at least 500", the same message agrees with the code, and only the general question counts.
  const agreeing = guardRule.assess(answers("at_least", 0.9), candidate!);
  assert.ok(Math.abs(agreeing.p - 0.09) < 1e-9);
});
