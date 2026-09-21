import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCode } from "../src/code/parse.ts";
import { parseHtml } from "../src/html/parse.ts";
import functionNameMatchesBody from "../src/rules/code/function-name-matches-body.ts";
import ariaHiddenHidesContent from "../src/rules/html/aria-hidden-hides-content.ts";
import { limits, withLimit } from "../src/rules/limits.ts";

const longFunction = (chars: number) => `function collectTotals(rows) {\n  let total = 0;\n  // ${"x".repeat(chars)}\n  return total;\n}\n`;
const longHidden = (count: number) => `<p aria-hidden="true">${Array.from({ length: count }, (_, i) => `word${i}`).join(" ")}</p>`;
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
  const before = limits.hiddenTextWords;
  const html = parseHtml("t.html", longHidden(before * 2));

  assert.match(field(ariaHiddenHidesContent.select(html), "hidden_text"), / …$/);

  const whole = await withLimit("hiddenTextWords", Infinity, async () => ariaHiddenHidesContent.select(html));
  assert.doesNotMatch(field(whole, "hidden_text"), / …$/);
  assert.equal(field(whole, "hidden_text").split(" ").length, before * 2);

  await assert.rejects(withLimit("hiddenTextWords", 5, async () => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(limits.hiddenTextWords, before);
});
