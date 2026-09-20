// How often does each situation a rule is about occur in the wild? A perfect rule for a construct
// that appears on one page in a hundred is worth little, and this costs nothing to find out: every
// number here comes from the parser. Run it before writing a rule, not after.
//
//   node scripts/corpus/prevalence.ts [--corpus corpus] [--kind home|form]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { attr, descendants, fieldLabel, parseHtml, text, type HtmlDoc } from "../../src/html/parse.ts";
import { htmlRules } from "../../src/rules/index.ts";

const { values } = parseArgs({ options: { corpus: { type: "string", default: "corpus" }, kind: { type: "string" } } });

interface Page {
  file: string;
  kind: "home" | "form";
  band: string;
}

const manifest: { pages: Page[] } = JSON.parse(readFileSync(`${values.corpus}/manifest.json`, "utf8"));
const pages = manifest.pages.filter((page) => !values.kind || page.kind === values.kind);

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

for (const page of pages) {
  const doc = parseHtml(page.file, readFileSync(page.file, "utf8"));
  for (const rule of htmlRules) record(`rule: ${rule.id}`, rule.select(doc).length);
  for (const [name, count] of Object.entries(PROPOSED)) record(`idea: ${name}`, count(doc));
}

const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const rows = [...counts].map(([situation, perPage]) => {
  const present = perPage.filter((count) => count > 0);
  return {
    situation,
    "pages with it": `${present.length}/${perPage.length}`,
    share: `${Math.round((present.length / perPage.length) * 100)}%`,
    candidates: perPage.reduce((sum, count) => sum + count, 0),
    "median where present": median(present),
  };
});
console.log(`${pages.length} pages${values.kind ? ` (${values.kind})` : ""}`);
console.table(rows.sort((a, b) => parseInt(b.share) - parseInt(a.share)));
