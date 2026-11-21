import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { JsonStore } from "../src/engine/cache.ts";
import type { Finding } from "../src/engine/types.ts";
import { verify, type Reader } from "../src/engine/verify.ts";
import { excerpt } from "../src/report/excerpt.ts";
import { json } from "../src/report/json.ts";
import { stylish } from "../src/report/stylish.ts";

const finding = (file: string, line: number, message = `claim on line ${line}`): Finding => ({
  ruleId: "doc-matches-function",
  file,
  loc: { line, col: 1 },
  severity: "error",
  p: 0.93,
  message,
  checked: { doc: "Returns the user.", body: "return null;" },
  measurements: {},
  facts: {},
});

const SOURCES = new Map([["src/a.ts", "export const a = 1;\n"]]);

/** Reads the findings back out of a prompt, as the reader would. */
const idsIn = (prompt: string): { id: number; file: string }[] => JSON.parse(prompt.slice(prompt.indexOf("Findings:") + "Findings:".length, prompt.indexOf("\n\nSource:")));

/** A reader that answers every finding the same way, and records each prompt it was sent. */
function answering(verdict: { true: boolean; worth_raising: boolean }, prompts: string[] = []): Reader {
  return async (prompt) => {
    prompts.push(prompt);
    return { output: { verdicts: idsIn(prompt).map(({ id }) => ({ id, ...verdict, reason: `reason ${id}` })) }, costUsd: 0.01 };
  };
}

test("keeps what the reader calls true and worth raising, with its reason, and drops the rest", async () => {
  const read: Reader = async (prompt) => ({
    output: {
      verdicts: idsIn(prompt).map(({ id }) => ({ id, true: true, worth_raising: id !== 1, reason: `reason ${id}` })),
    },
  });
  const result = await verify([finding("src/a.ts", 1), finding("src/a.ts", 2), finding("src/a.ts", 3)], { read, model: "sonnet", sources: SOURCES });

  assert.deepEqual(result.findings.map((f) => [f.loc.line, f.confirmed]), [
    [1, { by: "sonnet", reason: "reason 0" }],
    [3, { by: "sonnet", reason: "reason 2" }],
  ]);
  assert.deepEqual(result.rejected.map(({ finding: f, reason }) => [f.loc.line, reason]), [[2, "reason 1"]]);
  assert.deepEqual([result.stats.confirmed, result.stats.rejected, result.stats.unverified], [2, 1, 0]);
});

test("a claim that is true and not worth raising is rejected, and so is one that is false", async () => {
  for (const verdict of [{ true: true, worth_raising: false }, { true: false, worth_raising: true }]) {
    const result = await verify([finding("src/a.ts", 1)], { read: answering(verdict), model: "sonnet", sources: SOURCES });
    assert.equal(result.findings.length, 0);
  }
});

test("a finding the reader leaves out, or answers in the wrong shape, stays reported and is counted as unverified", async () => {
  const read: Reader = async () => ({ output: { verdicts: [{ id: 0, true: "yes", worth_raising: true, reason: "malformed" }] } });
  const result = await verify([finding("src/a.ts", 1), finding("src/a.ts", 2)], { read, model: "sonnet", sources: SOURCES });

  assert.deepEqual(result.findings.map((f) => [f.loc.line, f.confirmed]), [[1, undefined], [2, undefined]]);
  assert.equal(result.stats.unverified, 2);
});

test("when the reader fails, every finding of the batch stays reported and the reason is given once", async () => {
  const read: Reader = async () => Promise.reject(new Error("no claude"));
  const result = await verify([finding("src/a.ts", 1), finding("src/a.ts", 2), finding("src/a.ts", 3)], { read, model: "sonnet", sources: SOURCES, batchSize: 1 });

  assert.equal(result.findings.length, 3);
  assert.deepEqual(result.stats.failures, ["no claude"]);
  assert.equal(result.stats.unverified, 3);
});

test("a finding about a page, which has no file to open, is not sent to the reader", async () => {
  const prompts: string[] = [];
  const result = await verify([finding("https://example.com/", 1), finding("src/a.ts", 2)], { read: answering({ true: false, worth_raising: false }, prompts), model: "sonnet", sources: SOURCES });

  assert.equal(prompts.length, 1);
  assert.deepEqual(idsIn(prompts[0]!).map(({ file }) => file), [resolve("src/a.ts")]);
  assert.deepEqual(result.findings.map((f) => f.file), ["https://example.com/"]);
  assert.equal(result.stats.unverified, 1);
});

test("findings are sent a batch at a time, and the prompt leaves out Jev's probability and severity", async () => {
  const prompts: string[] = [];
  await verify([1, 2, 3, 4, 5].map((line) => finding("src/a.ts", line)), { read: answering({ true: true, worth_raising: true }, prompts), model: "sonnet", sources: SOURCES, batchSize: 2 });

  assert.deepEqual(prompts.map((prompt) => idsIn(prompt).length).sort(), [1, 2, 2]);
  assert.ok(prompts.every((prompt) => !prompt.includes("0.93") && !prompt.includes('"severity"')));
});

test("the prompt carries the source around each finding, numbered, so the reader need not choose to open the file", async () => {
  const source = Array.from({ length: 400 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n");
  const prompts: string[] = [];
  await verify([finding("src/big.ts", 200), finding("src/big.ts", 210)], { read: answering({ true: true, worth_raising: true }, prompts), model: "sonnet", sources: new Map([["src/big.ts", source]]) });

  const [prompt] = prompts;
  assert.match(prompt!, new RegExp(`=== ${resolve("src/big.ts")} \\(400 lines\\) ===\n50: const line50 = 50;`));
  assert.match(prompt!, /\n360: const line360 = 360;\n$/);
  assert.equal(prompt!.match(/^205: /gm)!.length, 1);
  assert.doesNotMatch(prompt!, /^49: |^361: /m);
});

test("a batch ends when its source would pass the budget, and a finding larger than the budget is still sent", async () => {
  const sources = new Map([1, 2, 3].map((n) => [`src/${n}.ts`, "x".repeat(600)] as const));
  const prompts: string[] = [];
  await verify([1, 2, 3].map((n) => finding(`src/${n}.ts`, 1)), { read: answering({ true: true, worth_raising: true }, prompts), model: "sonnet", sources, sourceBudget: 1000, concurrency: 1 });

  assert.deepEqual(prompts.map((prompt) => idsIn(prompt).map(({ id }) => id)), [[0], [1], [2]]);
});

test("a verdict is reused while the finding and its file are unchanged, and asked again when the file changes", async () => {
  const cache = new JsonStore<{ keep: boolean; reason: string }>(mkdtempSync(join(tmpdir(), "jev-lint-verdicts-")));
  const prompts: string[] = [];
  const read = answering({ true: true, worth_raising: true }, prompts);
  const findings = [finding("src/a.ts", 1)];

  await verify(findings, { read, model: "sonnet", sources: SOURCES, cache });
  const again = await verify(findings, { read, model: "sonnet", sources: SOURCES, cache });
  assert.equal(prompts.length, 1);
  assert.equal(again.stats.cached, 1);
  assert.deepEqual(again.findings[0]!.confirmed, { by: "sonnet", reason: "reason 0" });

  await verify(findings, { read, model: "sonnet", sources: new Map([["src/a.ts", "export const a = 2;\n"]]), cache });
  await verify(findings, { read, model: "haiku", sources: SOURCES, cache });
  assert.equal(prompts.length, 3);
});

test("the reports say what the second reader confirmed and what it rejected", async () => {
  const read: Reader = async (prompt) => ({
    output: { verdicts: idsIn(prompt).map(({ id }) => ({ id, true: id === 0, worth_raising: true, reason: id === 0 ? "The body returns null." : "A sibling test covers it." })) },
  });
  const { findings, rejected, stats } = await verify([finding("src/a.ts", 1), finding("src/a.ts", 2)], { read, model: "sonnet", sources: SOURCES });
  const runStats = { requests: 0, questions: 0, cacheHits: 0, inputTokens: 0, unanswered: 0, suppressed: 0, unchanged: 0, baselined: 0 };

  const report = JSON.parse(json(findings, runStats, { stats, rejected }));
  assert.deepEqual(report.elements[0].findings[0].confirmed, { by: "sonnet", reason: "The body returns null." });
  assert.deepEqual(report.rejected, [{ file: "src/a.ts", line: 2, column: 1, rule: "doc-matches-function", message: "claim on line 2", reason: "A sibling test covers it." }]);
  assert.equal(report.verification.rejected, 1);

  const text = stylish(findings, runStats, { evidence: false, verification: stats });
  assert.match(text, /confirmed.*The body returns null\./);
  assert.match(text, /second reader \(sonnet\): 1 confirmed, 1 rejected and left out/);
  assert.doesNotMatch(text, /claim on line 2/);
});

test("an excerpt drops the lines that only open and close a body, the shared indentation, and all but a few lines", () => {
  assert.deepEqual(excerpt("{\n  return cart.items.filter((item) => item.inStock);\n}"), ["return cart.items.filter((item) => item.inStock);"]);
  assert.deepEqual(excerpt("() => {\n    if (a) {\n      b();\n    }\n  })"), ["if (a) {", "  b();", "}"]);
  // A section cut out of a file starts mid-line, so only its later lines still have their indentation.
  assert.deepEqual(excerpt("cart.items.push(item);\n  cart.items.sort(byPrice);"), ["cart.items.push(item);", "cart.items.sort(byPrice);"]);
  assert.deepEqual(excerpt("a;\nb;\nc;\nd;", 2), ["a;", "b;", "… 2 more lines"]);
  assert.deepEqual(excerpt("x = { a: 1 }"), ["x = { a: 1 }"]);
});

test("a finding shows the code its words were compared with, under the message", () => {
  const withCode: Finding = { ...finding("src/a.ts", 1), compared: { label: "The function", code: "{\n  return null;\n}" } };
  const runStats = { requests: 0, questions: 0, cacheHits: 0, inputTokens: 0, unanswered: 0, suppressed: 0, unchanged: 0, baselined: 0 };

  assert.match(stylish([withCode], runStats, { evidence: false }), /The function: .*return null;/);
  assert.deepEqual(JSON.parse(json([withCode], runStats)).elements[0].findings[0].compared, withCode.compared);
});
