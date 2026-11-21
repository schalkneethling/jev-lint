import assert from "node:assert/strict";
import { test } from "node:test";
import { configureRules, fromCustomRule, widen } from "../src/config.ts";
import type { Ask } from "../src/engine/client.ts";
import { run } from "../src/engine/run.ts";
import functionNameMatchesBody from "../src/rules/code/function-name-matches-body.ts";
import { allRules, defaultRules } from "../src/rules/index.ts";

const source = `/** Says hello. */
function greet(name) { return "hi " + name; }
function undocumented() {}
test("works", () => { expect(1).toBe(1); });
test("rejects an empty name", () => { expect(() => greet("")).toThrow(); });`;

/** Records every request and answers yes with the given probability. */
function recording(yes: number): { ask: Ask; states: unknown[]; instructions: string[] } {
  const states: unknown[] = [];
  const instructions: string[] = [];
  const ask: Ask = async (state, questions) => {
    states.push(state);
    for (const question of Object.values(questions)) instructions.push(String(question.instructions));
    return { answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul" as const, noul: yes }])), usage: { input_tokens: 1, output_tokens: 1 } };
  };
  return { ask, states, instructions };
}

test("a custom rule sends only the fields its question names, and fills its message from them", async () => {
  const rule = fromCustomRule({
    id: "test-title-names-behaviour",
    on: "tests",
    ask: "{title} is the title of a test. Does it name a behaviour?",
    reportWhen: "no",
    message: 'Test title "{title}" does not name a behaviour.',
  });
  const { ask, states, instructions } = recording(0.1);
  const { findings } = await run([{ path: "a.test.ts", source }], { rules: [rule], ask, isolation: "candidate" });
  assert.deepEqual(states, [{ candidate: { title: "works" } }, { candidate: { title: "rejects an empty name" } }]);
  assert.equal(instructions[0], "`candidate.title` is the title of a test. Does it name a behaviour?");
  // reportWhen "no": a 0.1 probability of yes is a 0.9 probability of the defect.
  assert.deepEqual(findings.map((f) => [f.message, f.severity]), [
    ['Test title "works" does not name a behaviour.', "error"],
    ['Test title "rejects an empty name" does not name a behaviour.', "error"],
  ]);
});

test("a custom rule skips a thing whose asked field is empty, and applies `where` before asking", async () => {
  const documented = fromCustomRule({ id: "doc-says-something", on: "functions", ask: "Does {documentation} describe {name}?", message: "{name}" });
  const { ask, states } = recording(0.9);
  await run([{ path: "a.ts", source }], { rules: [documented], ask, isolation: "candidate" });
  assert.deepEqual(states, [{ candidate: { documentation: "Says hello.", name: "greet" } }]);

  const onlyGreeters = fromCustomRule({ id: "greeters", on: "functions", ask: "Is {name} polite?", where: { name: /^greet/ }, message: "{name}" });
  const second = recording(0.9);
  await run([{ path: "a.ts", source }], { rules: [onlyGreeters], ask: second.ask, isolation: "candidate" });
  assert.deepEqual(second.states, [{ candidate: { name: "greet" } }]);
});

test("a custom rule that names a field its source does not have fails with the fields it could have used", async () => {
  const rule = fromCustomRule({ id: "bad", on: "tests", ask: "Is {name} good?", message: "x" });
  await assert.rejects(run([{ path: "a.test.ts", source }], { rules: [rule], ask: recording(0.5).ask, isolation: "candidate" }), /"tests" has no field "name". It has: title, suite, body/);
  assert.throws(() => fromCustomRule({ id: "bad", on: "tests", ask: "Is it good?", message: "x" }), /names no field/);
});

test("configureRules switches rules off, turns opt-in rules on, replaces thresholds, and rejects unknown ids", () => {
  const ids = (rules: { id: string }[]) => rules.map((rule) => rule.id);
  assert.equal(ids(defaultRules).includes("swallowed-error-justified"), false, "opt-in rules are not in the default set");
  assert.equal(ids(configureRules(allRules, {})).includes("swallowed-error-justified"), false);
  assert.equal(ids(configureRules(allRules, { rules: { "swallowed-error-justified": "on" } })).includes("swallowed-error-justified"), true);
  assert.equal(ids(configureRules(allRules, { rules: { "link-text-purpose": "off" } })).includes("link-text-purpose"), false);
  const tuned = configureRules(allRules, { rules: { "test-title-matches-body": { error: 0.99 } } }).find((rule) => rule.id === "test-title-matches-body")!;
  assert.equal(tuned.thresholds!.error, 0.99);
  assert.equal(tuned.thresholds!.warn, 0.88, "thresholds the config does not name keep the rule's own value");
  assert.throws(() => configureRules(allRules, { rules: { "no-such-rule": "off" } }), /does not exist: "no-such-rule"/);
  assert.throws(() => configureRules(allRules, { custom: [{ id: "link-text-purpose", on: "tests", ask: "{title}?", message: "x" }] }), /already taken/);
});

test("conventions reach only the rules that read them, as a field the question names", async () => {
  const { ask, states, instructions } = recording(0.1);
  const code = `function getTotal(cart) { cart.cached = 1; return cart.cached; }`;
  await run([{ path: "src/cart.ts", source: code }], { rules: [functionNameMatchesBody], ask, isolation: "candidate", conventions: ["get* functions may cache on their argument."] });
  assert.deepEqual((states[0] as { candidate: { project_conventions: string[] } }).candidate.project_conventions, ["get* functions may cache on their argument."]);
  assert.match(instructions[0]!, /`candidate.project_conventions` lists conventions this codebase follows/);

  const without = recording(0.1);
  await run([{ path: "src/cart.ts", source: code }], { rules: [functionNameMatchesBody], ask: without.ask, isolation: "candidate" });
  assert.equal("project_conventions" in (without.states[0] as { candidate: object }).candidate, false);
  assert.doesNotMatch(without.instructions[0]!, /conventions/);
});

test("when most functions sharing a prefix are reported, the reports become one house-style finding per file at review", async () => {
  // Five `get…` functions, four classified as having a surprising side effect; one `is…` function also reported.
  const code = ["getA", "getB", "getC", "getD", "getPure", "isReady"].map((name) => `function ${name}() { return read(state); }`).join("\n");
  const ask: Ask = async (state, questions) => ({
    answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul" as const, noul: JSON.stringify(state).includes("getPure") ? 0.05 : 0.9 }])),
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const { findings, classifications } = await run([{ path: "src/store.ts", source: code }], { rules: [functionNameMatchesBody], ask, isolation: "candidate" });
  assert.deepEqual(
    findings.map((f) => [f.severity, f.message, f.occurrences?.length]),
    [
      ["review", '4 elements in this file: "get…" functions with a side effect their name does not suggest.', 4],
      // One `is…` function is not a habit: it keeps its own severity and message.
      ["error", 'Function "isReady" has a side effect its name does not suggest.', undefined],
    ],
  );
  assert.match(findings[0]!.hint!, /4 of the 5 "get…" functions in this run/);
  assert.equal(classifications.length, 6, "classifications stay per function");
});

test("a custom rule's `where` pattern with the g flag still tests every candidate, and a message may only quote asked fields", async () => {
  const code = ["getA", "getB", "getC", "getD"].map((name) => `function ${name}() { return 1; }`).join("\n");
  const rule = fromCustomRule({ id: "getters", on: "functions", ask: "Is {name} clear?", where: { name: /^get/g }, message: "{name}" });
  const { ask, states } = recording(0.9);
  await run([{ path: "a.ts", source: code }], { rules: [rule], ask, isolation: "candidate" });
  assert.equal(states.length, 4);
  assert.throws(() => fromCustomRule({ id: "bad", on: "functions", ask: "Is {name} a verb?", message: "{name} in {body}" }), /`message` uses \{body\}, which `ask` does not name/);
});

test("a `where` value that is not a regular expression is refused by name", () => {
  // A plain JavaScript config has no type checking, hence the cast.
  assert.throws(() => fromCustomRule({ id: "bad", on: "functions", ask: "Is {name} clear?", where: { name: "^get" as unknown as RegExp }, message: "{name}" }), /`where.name` must be a regular expression/);
});

test("a custom rule's id must be one a suppression directive can name, declarative rule or not", () => {
  const declarative = { id: "team/no-foo", on: "tests" as const, ask: "{title}?", message: "{title}" };
  assert.throws(() => configureRules(allRules, { custom: [declarative] }), /must be a string of letters, digits, hyphens and underscores/);
  assert.throws(() => configureRules(allRules, { custom: [{ ...functionNameMatchesBody, id: "my rule" }] }), /"my rule" must be a string/);
  // A plain JavaScript config can leave the id out altogether.
  assert.throws(() => configureRules(allRules, { custom: [{ ...declarative, id: undefined as unknown as string }] }), /undefined must be a string/);
});

test("widen lowers only the review threshold, and never raises one", () => {
  const thresholdsOf = (id: string, floor: number) => widen(allRules, floor).find((rule) => rule.id === id)!.thresholds!;
  // `test-title-matches-body` reports from 0.88 and has no review band of its own.
  assert.deepEqual(thresholdsOf("test-title-matches-body", 0.3), { error: 0.95, warn: 0.88, review: 0.3 });
  // `doc-matches-function` already reviews from 0.35.
  assert.equal(thresholdsOf("doc-matches-function", 0.5).review, 0.35);
  // A rule with no thresholds of its own starts from the engine's.
  assert.equal(thresholdsOf("link-text-purpose", 0.25).review, 0.25);
});
