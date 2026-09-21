import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCode } from "../src/code/parse.ts";
import { parseHtml } from "../src/html/parse.ts";
import functionNameMatchesBody from "../src/rules/code/function-name-matches-body.ts";
import alertIsUrgent from "../src/rules/html/alert-is-urgent.ts";
import { limits, withLimit } from "../src/rules/limits.ts";

const longFunction = (chars: number) => `function collectTotals(rows) {\n  let total = 0;\n  // ${"x".repeat(chars)}\n  return total;\n}\n`;
const longAlert = (count: number) => `<p role="alert">${Array.from({ length: count }, (_, i) => `word${i}`).join(" ")}</p>`;
const field = (candidates: { data: { [key: string]: unknown } }[], name: string) => String(candidates[0]!.data[name]);

test("the rules read their limits at select time, so a limit can be varied without forking a rule", async () => {
  // Asserted against the limit rather than a number, so retuning one is not a failing test.
  const doc = await parseCode("t.ts", longFunction(limits.codeChars * 2));
  const before = limits.codeChars;

  assert.equal(field(functionNameMatchesBody.select(doc), "body").length, before + 18, "the default clips at codeChars plus the truncation marker");

  const wider = await withLimit("codeChars", before * 4, async () => functionNameMatchesBody.select(doc));
  assert.ok(field(wider, "body").length > before * 2, "a wider limit sends the whole body");
  assert.ok(!field(wider, "body").includes("truncated"));

  assert.equal(limits.codeChars, before, "the limit is restored afterwards");
  assert.equal(field(functionNameMatchesBody.select(doc), "body").length, before + 18);
});

test("withLimit restores the limit when the body throws, and Infinity means no truncation", async () => {
  const before = limits.alertMessageWords;
  const html = parseHtml("t.html", longAlert(before * 2));

  assert.match(field(alertIsUrgent.select(html), "message"), / …$/);

  const whole = await withLimit("alertMessageWords", Infinity, async () => alertIsUrgent.select(html));
  assert.doesNotMatch(field(whole, "message"), / …$/);
  assert.equal(field(whole, "message").split(" ").length, before * 2);

  await assert.rejects(withLimit("alertMessageWords", 5, async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(limits.alertMessageWords, before);
});
