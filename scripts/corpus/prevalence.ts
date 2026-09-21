// How often does each situation a rule is about occur in the wild? A perfect rule for a construct
// that appears on one page in a hundred is worth little, and this costs nothing to find out: every
// number here comes from the parser. Run it before writing a rule, not after.
//
//   node scripts/corpus/prevalence.ts [--corpus corpus] [--kind home|form|article|source|test|jsx]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseJsx } from "../../src/code/jsx.ts";
import { parseCode } from "../../src/code/parse.ts";
import { attr, descendants, fieldLabel, parseHtml, text, type HtmlDoc } from "../../src/html/parse.ts";
import { allRules } from "../../src/rules/index.ts";
import { readCorpus } from "./corpus.ts";

const { values } = parseArgs({ options: { corpus: { type: "string", default: "corpus" }, kind: { type: "string" } } });

const corpus = readCorpus(values.corpus);
const files = corpus.files.filter((file) => !values.kind || file.kind === values.kind);

// Situations no rule covers yet. Each is what a candidate for a possible rule would be.
const PROPOSED: Record<string, (doc: HtmlDoc) => number> = {
  "table with header cells": (doc) => doc.elements.filter((el) => el.tagName === "table" && descendants(el, ["th"]).length > 0).length,
  "fieldset with a legend": (doc) => doc.elements.filter((el) => el.tagName === "fieldset" && descendants(el, ["legend"]).length > 0).length,
  "field with label and placeholder": (doc) =>
    doc.elements.filter((el) => el.tagName === "input" && (attr(el, "placeholder") ?? "").trim() !== "" && fieldLabel(doc, el) !== undefined).length,
  "field with placeholder but no label": (doc) =>
    doc.elements.filter((el) => el.tagName === "input" && (attr(el, "placeholder") ?? "").trim() !== "" && fieldLabel(doc, el) === undefined).length,
  "element with its own lang attribute": (doc) => doc.elements.filter((el) => el.tagName !== "html" && attr(el, "lang") !== undefined).length,
  "same-origin link (promise vs destination)": (doc) =>
    doc.elements.filter((el) => el.tagName === "a" && /^(\/(?!\/)|\.)/.test(attr(el, "href") ?? "") && text(el) !== "").length,
  "button with visible text": (doc) => doc.elements.filter((el) => el.tagName === "button" && /[\p{L}\p{N}]/u.test(text(el))).length,
  "title attribute on a control": (doc) => doc.elements.filter((el) => ["a", "button", "input"].includes(el.tagName) && (attr(el, "title") ?? "") !== "").length,
  "iframe with a title": (doc) => doc.elements.filter((el) => el.tagName === "iframe" && (attr(el, "title") ?? "") !== "").length,
  "summary of a details element": (doc) => doc.elements.filter((el) => el.tagName === "summary").length,
};

const counts = new Map<string, number[]>();
const record = (name: string, count: number) => counts.set(name, [...(counts.get(name) ?? []), count]);

for (const entry of files) {
  const source = readFileSync(entry.file, "utf8");
  // The same two readings `run()` gives a source file: as code, and for the markup in its JSX. The ideas
  // below are all about rendered markup, so a code corpus, whose HTML is whatever JSX states outright,
  // is counted for the rules alone.
  const docs = corpus.code
    ? ([["code", await parseCode(entry.file, source)], ["html", await parseJsx(entry.file, source)]] as const)
    : ([["html", parseHtml(entry.file, source)]] as const);
  for (const [target, doc] of docs) for (const rule of allRules) if (rule.target === target) record(`rule: ${rule.id}`, rule.select(doc).length);
  if (!corpus.code) for (const [name, count] of Object.entries(PROPOSED)) record(`idea: ${name}`, count(docs[0]![1] as HtmlDoc));
}

const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const unit = corpus.code ? "files" : "pages";
const rows = [...counts].map(([situation, perPage]) => {
  const present = perPage.filter((count) => count > 0);
  return {
    situation,
    [`${unit} with it`]: `${present.length}/${perPage.length}`,
    share: `${Math.round((present.length / perPage.length) * 100)}%`,
    candidates: perPage.reduce((sum, count) => sum + count, 0),
    "median where present": median(present),
  };
});
console.log(`${files.length} ${unit}${values.kind ? ` (${values.kind})` : ""}`);
console.table(rows.sort((a, b) => parseInt(b.share) - parseInt(a.share)));
