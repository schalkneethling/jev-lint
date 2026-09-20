// Draws the labelling sample from <corpus>/judgements.json. Precision needs reported judgements and
// recall needs unreported ones, so each rule contributes both: reports across its severities, the
// unreported judgements closest to its threshold (where a miss is most likely), and a few random
// unreported ones (so recall is not only measured at the edge). Identical words are sampled once.
//
//   node scripts/corpus/sample.ts [--corpus corpus] [--reported 8] [--unreported 5] [--seed 1] [--exclude <rule>]...
//
// Writes <corpus>/label-sample.json, which keeps the probabilities and severities the labeller must
// not see, and <corpus>/label-items/<id>.json, the blind items to load into the label bench.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { htmlRules } from "../../src/rules/index.ts";

const { values } = parseArgs({
  options: { corpus: { type: "string", default: "corpus" }, reported: { type: "string", default: "8" }, unreported: { type: "string", default: "5" }, seed: { type: "string", default: "1" }, exclude: { type: "string", multiple: true } },
});

interface Saved {
  id: number;
  rule: string;
  page: string;
  kind: string;
  band: string;
  p: number;
  severity: string | null;
  message: string;
  hint?: string;
  snippet: string;
  checked: Record<string, unknown>;
  facts: Record<string, string>;
}

let state = Number(values.seed);
const next = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffled = <T>(items: T[]): T[] => items.map((item) => [next(), item] as const).sort(([a], [b]) => a - b).map(([, item]) => item);

const all: Saved[] = JSON.parse(readFileSync(`${values.corpus}/judgements.json`, "utf8"));
const sample: Saved[] = [];
const rules = htmlRules.filter((rule) => !(values.exclude ?? []).includes(rule.id));
for (const rule of rules) {
  const seen = new Set<string>();
  const distinct = shuffled(all.filter((j) => j.rule === rule.id)).filter((j) => {
    const words = JSON.stringify(j.checked);
    return seen.has(words) ? false : (seen.add(words), true);
  });
  const reported = distinct.filter((j) => j.severity !== null);
  const unreported = distinct.filter((j) => j.severity === null);

  // Round-robin over severities, so a rule with two hundred reviews and three errors still shows its errors.
  const bySeverity = ["error", "warn", "review"].map((severity) => reported.filter((j) => j.severity === severity));
  const takenReported: Saved[] = [];
  while (takenReported.length < Number(values.reported) && bySeverity.some((group) => group.length > 0)) {
    for (const group of bySeverity) if (group.length > 0 && takenReported.length < Number(values.reported)) takenReported.push(group.shift()!);
  }

  const nearThreshold = unreported.toSorted((a, b) => b.p - a.p).slice(0, Math.ceil(Number(values.unreported) / 2));
  const random = unreported.filter((j) => !nearThreshold.includes(j)).slice(0, Number(values.unreported) - nearThreshold.length);
  sample.push(...takenReported, ...nearThreshold, ...random);
}

// What the labeller is asked to confirm must read the same whether or not the tool agreed. Most rules'
// messages already do. label-input-type's names the model's reading of the label, which for an
// unreported item came out as 'asks for an email value, but the input is type="email"': two labellers'
// worth of "true" for a claim nobody made. So its claim is stated from the facts alone.
const CLAIMS: Record<string, (j: Saved) => string> = {
  "label-input-type": (j) => `Field "${j.checked.label ?? j.checked.placeholder}" has type="${j.facts.type}", and that type does not suit what the field asks for.`,
};

const ordered = shuffled(sample);
const description = new Map(htmlRules.map((rule) => [rule.id, rule.description]));
writeFileSync(`${values.corpus}/label-sample.json`, JSON.stringify(ordered, null, 1));
// One file per item, so the bench can be loaded by file path and no page text passes through a prompt.
const itemsDir = `${values.corpus}/label-items`;
rmSync(itemsDir, { recursive: true, force: true });
mkdirSync(itemsDir, { recursive: true });
ordered.forEach((j, n) => {
  const item = { n, rule: j.rule, ruleDescription: description.get(j.rule), claim: CLAIMS[j.rule]?.(j) ?? j.message, hint: j.hint ?? "", snippet: j.snippet, checked: j.checked, facts: j.facts, page: j.page, kind: j.kind, band: j.band };
  writeFileSync(`${itemsDir}/j${j.id}.json`, JSON.stringify(item));
});

console.table(
  rules.map((rule) => {
    const mine = ordered.filter((j) => j.rule === rule.id);
    return { rule: rule.id, reported: mine.filter((j) => j.severity !== null).length, unreported: mine.filter((j) => j.severity === null).length };
  }),
);
console.log(`${ordered.length} items`);
