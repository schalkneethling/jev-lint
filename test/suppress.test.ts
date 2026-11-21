import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDiff, touches } from "../src/engine/changed.ts";
import type { Ask } from "../src/engine/client.ts";
import { run } from "../src/engine/run.ts";
import { parseCode } from "../src/code/parse.ts";
import { readSuppressions, suppressionsFrom } from "../src/engine/suppress.ts";
import swallowedErrorJustified from "../src/rules/code/swallowed-error-justified.ts";

/** A code file's directives, read the way the engine reads them: from the comments its parser found. */
const inCode = async (source: string) => suppressionsFrom((await parseCode("x.js", source)).rawComments);

test("a next-line directive covers the named rules on the line below, and only those", async () => {
  const s = await inCode(`a();\n// jev-lint-disable-next-line rule-a, rule-b -- memoised on purpose\nb();`);
  assert.equal(s.covers("rule-a", 3), true);
  assert.equal(s.covers("rule-b", 3), true);
  assert.equal(s.covers("rule-c", 3), false);
  assert.equal(s.covers("rule-a", 2), false);
});

test("a directive with no rule covers every rule; a same-line directive covers its own line", async () => {
  const s = await inCode(`a(); // jev-lint-disable-line\n/* jev-lint-disable-next-line */\nb();`);
  assert.equal(s.covers("anything", 1), true);
  assert.equal(s.covers("anything", 3), true);
});

test("a plain disable covers the whole file, in a block comment or an HTML comment", async () => {
  assert.equal((await inCode(`/* jev-lint-disable comment-describes-code */\nx();`)).covers("comment-describes-code", 40), true);
  assert.equal(readSuppressions(`<!-- jev-lint-disable link-text-purpose -->\n<a>x</a>`).covers("link-text-purpose", 2), true);
  assert.equal(readSuppressions(`<!-- jev-lint-disable link-text-purpose -->`).covers("alt-text-quality", 2), false);
});

test("the reason after ` -- ` is not read as a rule", async () => {
  assert.equal((await inCode(`// jev-lint-disable-next-line rule-a -- rule-b is fine\nx();`)).covers("rule-b", 2), false);
});

test("the next line is the one after the comment ends, and a URL in markup is not a comment", async () => {
  // A directive in a comment of several lines targets the line after the comment, not its own second line.
  const block = await inCode(`/* jev-lint-disable-next-line rule-a\n   because of reasons */\nx();`);
  assert.equal(block.covers("rule-a", 3), true);
  assert.equal(block.covers("rule-a", 2), false);
  // The `//` of a URL must not swallow the directive after it on the same line.
  const html = readSuppressions(`<a href="https://example.com/x">more</a> <!-- jev-lint-disable-line link-text-purpose -->`);
  assert.equal(html.covers("link-text-purpose", 1), true);
  const multi = readSuppressions(`<!-- jev-lint-disable-next-line link-text-purpose\n     the vendor writes this markup -->\n<a href="#">more</a>`);
  assert.equal(multi.covers("link-text-purpose", 3), true);
});

test("parseDiff reads the new-side ranges, marks the lines either side of a pure deletion, and skips deleted files", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3 +3,2 @@ function f() {",
    "@@ -10,2 +11,0 @@",
    "@@ -20,0 +20 @@",
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,4 +0,0 @@",
  ].join("\n");
  // `+11,0`: lines were deleted after new line 11, so lines 11 and 12 are what the deletion touches.
  assert.deepEqual([...parseDiff(diff)], [["src/a.ts", [[3, 4], [11, 12], [20, 20]]]]);
});

test("touches is an inclusive overlap", () => {
  assert.equal(touches([[5, 7]], { first: 7, last: 9 }), true);
  assert.equal(touches([[5, 7]], { first: 8, last: 9 }), false);
});

/** Classifies every ignored error as having no reason at all, so each empty catch is reported. */
const noReason: Ask = async (_state, questions) => ({
  answers: Object.fromEntries(
    Object.keys(questions).map((id) => [id, { type: "choice" as const, choice: "nothing", confidence: 1, probabilities: { reason_stated: 0, evident_from_code: 0, nothing: 1 } }]),
  ),
  usage: { input_tokens: 1, output_tokens: 1 },
});
const source = `function a() {\n  try { x(); } catch {}\n}\n\nfunction b() {\n  // jev-lint-disable-next-line swallowed-error-justified -- probe\n  try { y(); } catch {}\n}\n\nfunction c() {\n  try {\n    z();\n  } catch {}\n}\n`;

test("a suppressed finding is counted and not reported", async () => {
  const { findings, stats } = await run([{ path: "s.ts", source }], { rules: [swallowedErrorJustified], ask: noReason, isolation: "candidate" });
  assert.deepEqual(findings.map((f) => f.loc.line), [2, 13]);
  assert.equal(stats.suppressed, 1);
});

test("with changed lines, only candidates that overlap a change are classified; a change inside the try block counts", async () => {
  const { findings, stats } = await run([{ path: "s.ts", source }], {
    rules: [swallowedErrorJustified],
    ask: noReason,
    isolation: "candidate",
    changed: new Map([["s.ts", [[12, 12]]]]),
  });
  assert.deepEqual(findings.map((f) => f.loc.line), [13]);
  assert.equal(stats.unchanged, 2);
});

test("with changed lines, a file that is not listed has nothing to classify", async () => {
  const { findings } = await run([{ path: "s.ts", source }], { rules: [swallowedErrorJustified], ask: noReason, isolation: "candidate", changed: new Map() });
  assert.deepEqual(findings, []);
});

test("the github format prints one workflow command per finding, with reviews as notices and special characters escaped", async () => {
  const { github } = await import("../src/report/github.ts");
  const { findings } = await run([{ path: "src/a,b.ts", source }], { rules: [swallowedErrorJustified], ask: noReason, isolation: "candidate" });
  const lines = github(findings.map((f, i) => ({ ...f, severity: i === 0 ? "review" : f.severity, message: i === 0 ? "50% of\nthe time" : f.message }))).split("\n");
  assert.equal(lines[0], "::notice file=src/a%2Cb.ts,line=2,col=16,title=jev-lint swallowed-error-justified::50%25 of%0Athe time (p=1.00)");
  assert.match(lines[1]!, /^::error file=src\/a%2Cb\.ts,line=13,col=5,title=jev-lint swallowed-error-justified::This error is caught and ignored/);
});

test("a baseline leaves out the findings it records, survives moved code, and lets changed words through", async () => {
  const { fingerprintOf, readBaseline, writeBaseline } = await import("../src/engine/baseline.ts");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "jev-baseline-")), "baseline.json");
  const options = { rules: [swallowedErrorJustified], ask: noReason, isolation: "candidate" as const };

  const first = await run([{ path: "/repo/src/s.ts", source }], options);
  assert.equal(writeBaseline(file, first.reported, "/repo"), 2);
  const baseline = { known: readBaseline(file), root: "/repo" };

  // The same code, moved down two lines: both findings are still the baseline's.
  const moved = await run([{ path: "/repo/src/s.ts", source: `\n\n${source}` }], { ...options, baseline });
  assert.deepEqual([moved.findings.length, moved.stats.baselined], [0, 2]);

  // The code inside one try block changed, so that finding is about new words and comes back.
  const edited = await run([{ path: "/repo/src/s.ts", source: source.replace("x();", "x(); more();") }], { ...options, baseline });
  assert.deepEqual([edited.findings.map((f) => f.loc.line), edited.stats.baselined], [[2], 1]);

  // The path is relative to the project, so a checkout somewhere else matches the same baseline.
  assert.equal(fingerprintOf(first.reported[0]!, "/repo"), fingerprintOf({ ...first.reported[0]!, file: "/elsewhere/src/s.ts" }, "/elsewhere"));
});

test("a directive must open a comment, and one whose rule list cannot be read switches nothing off", async () => {
  // The words in a string, or in the text of a page, are not a directive.
  assert.equal((await inCode(`const help = "Add jev-lint-disable to a comment to silence a rule";`)).covers("any-rule", 1), false);
  assert.equal(readSuppressions(`<p>Add a jev-lint-disable comment</p>\n<a href="#">more</a>`).covers("link-text-purpose", 2), false);
  // Ids separated by spaces, and a reason without " -- ", cannot be read. Neither widens to every rule.
  assert.equal((await inCode(`// jev-lint-disable-next-line rule-a rule-b\nx();`)).covers("rule-c", 2), false);
  assert.equal((await inCode(`// jev-lint-disable-next-line rule-a because getters memoise\nx();`)).covers("rule-a", 2), false);
});

test("a directive above a try block switches off the finding reported at its catch", async () => {
  const code = `function f() {\n  // jev-lint-disable-next-line swallowed-error-justified -- best effort\n  try {\n    remove(p);\n  } catch {}\n}\n`;
  const { findings, stats } = await run([{ path: "s.ts", source: code }], { rules: [swallowedErrorJustified], ask: noReason, isolation: "candidate" });
  assert.deepEqual([findings.length, stats.suppressed], [0, 1]);
});

test("a baseline's fingerprint ignores the project's conventions, and its paths are relative to the baseline file", async () => {
  const { fingerprintOf, rootOf } = await import("../src/engine/baseline.ts");
  const candidate = { loc: { line: 1, col: 1 }, data: { name: "getX", body: "{ save(); }" } };
  const withConvention = { ...candidate, data: { ...candidate.data, project_conventions: ["get* functions memoise"] } };
  assert.equal(
    fingerprintOf({ ruleId: "function-name-matches-body", file: "/repo/src/a.js", candidate }, "/repo"),
    fingerprintOf({ ruleId: "function-name-matches-body", file: "/repo/src/a.js", candidate: withConvention }, "/repo"),
  );
  assert.equal(rootOf("/repo/jev-lint-baseline.json"), "/repo");
});

test("rules see a file's path relative to the linted directory, so a project under a directory named for tests is still linted", async () => {
  const { default: functionName } = await import("../src/rules/code/function-name-matches-body.ts");
  const code = `function getTotal(cart) { cart.cached = sum(cart); return cart.cached; }`;
  const yes: Ask = async (_state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul" as const, noul: 0.95 }])), usage: { input_tokens: 1, output_tokens: 1 } });
  const options = { rules: [functionName], ask: yes, isolation: "candidate" as const };
  const inside = await run([{ path: "/work/test-harness/src/cart.js", source: code }], { ...options, root: "/work/test-harness" });
  assert.equal(inside.findings.length, 1);
  // Its own test directory is still left alone.
  const ownTests = await run([{ path: "/work/test-harness/test/cart.js", source: code }], { ...options, root: "/work/test-harness" });
  assert.equal(ownTests.findings.length, 0);
});

test("in a code file a directive inside a string literal switches nothing off, because directives are read from comments", async () => {
  const code = `const fixture = "/* jev-lint-disable */";\nfunction f() {\n  try { x(); } catch {}\n}\n`;
  const { findings, stats } = await run([{ path: "s.ts", source: code }], { rules: [swallowedErrorJustified], ask: noReason, isolation: "candidate" });
  assert.deepEqual([findings.length, stats.suppressed], [1, 0]);
});

test("a path git wrote in C-quoted form is read back as it is on disk", () => {
  const diff = ['--- "a/caf\\303\\251.ts"', '+++ "b/caf\\303\\251.ts"', "@@ -1 +1 @@"].join("\n");
  assert.deepEqual([...parseDiff(diff).keys()], ["café.ts"]);
});

test("a directive above a comment is not joined into it: the comment stays a candidate for the rules the directive does not name", async () => {
  const { commentCandidates } = await import("../src/rules/code/shared.ts");
  const doc = await parseCode("c.js", `// jev-lint-disable-next-line comment-describes-code -- fine\n// Add one to the counter, because ids start at 1.\ncounter = counter + 1;\n`);
  assert.deepEqual(commentCandidates(doc).map((candidate) => [candidate.data.comment, candidate.loc.line]), [["Add one to the counter, because ids start at 1.", 2]]);
});
