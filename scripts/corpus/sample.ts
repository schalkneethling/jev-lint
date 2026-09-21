// Draws the labelling sample from <corpus>/classifications.json. Precision needs reported classifications and
// recall needs unreported ones, so each rule contributes both: reports across its severities, the
// unreported classifications closest to its threshold (where a miss is most likely), and a few random
// unreported ones (so recall is not only measured at the edge). Identical words are sampled once.
//
//   node scripts/corpus/sample.ts [--corpus corpus] [--reported 8] [--unreported 5] [--seed 1] [--exclude <rule>]...
//
// Writes <corpus>/label-sample.json, which keeps the probabilities and severities the labeller must
// not see; <corpus>/label-items/<id>.json, the blind items to load into the label bench; and
// <corpus>/label-sample-blind.json, the same items in one document to hand over.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { allRules, htmlRules } from "../../src/rules/index.ts";
import { readCorpus } from "./corpus.ts";

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

function roundRobin<T>(queues: T[][]): T[] {
  const out: T[] = [];
  while (queues.some((queue) => queue.length > 0)) for (const queue of queues) if (queue.length > 0) out.push(queue.shift()!);
  return out;
}

/**
 * The one thing a rule's sample must not be dominated by: the site a page came from, or the repository a
 * file came from. One repository's house style runs through every file in it, so eight reports from it
 * would measure that house and not the rule. `page` is a URL for a page and `owner/repo: path:line` for a file.
 */
const sourceOf = (j: Saved) => (j.page.includes("://") ? new URL(j.page).origin : j.page.split(": ")[0]!);

/**
 * Round-robin over the kinds, and within each kind over the sites or repositories, keeping each queue's own
 * order. A rule behaves differently on a home page, a form, and an article — `description-matches-page` only
 * classifies articles at all, and `test-title-matches-body` only classifies tests — and taking the first n of
 * a list sorted by anything else gave whichever kind, and whichever repository, happens to be most common.
 */
function acrossKinds(items: Saved[]): Saved[] {
  const queuesFor = (of: Saved[], key: (j: Saved) => string) => [...new Set(of.map(key))].map((value) => of.filter((j) => key(j) === value));
  return roundRobin(queuesFor(items, (j) => j.kind).map((ofKind) => roundRobin(queuesFor(ofKind, sourceOf))));
}

const corpus = readCorpus(values.corpus);
const all: Saved[] = JSON.parse(readFileSync(`${values.corpus}/classifications.json`, "utf8"));
const sample: Saved[] = [];
const rules = (corpus.code ? allRules : htmlRules).filter((rule) => !(values.exclude ?? []).includes(rule.id));
for (const rule of rules) {
  const seen = new Set<string>();
  const distinct = shuffled(all.filter((j) => j.rule === rule.id)).filter((j) => {
    const words = JSON.stringify(j.checked);
    return seen.has(words) ? false : (seen.add(words), true);
  });
  const reported = distinct.filter((j) => j.severity !== null);
  const unreported = distinct.filter((j) => j.severity === null);

  // Round-robin over severities, so a rule with two hundred reviews and three errors still shows its errors.
  const bySeverity = ["error", "warn", "review"].map((severity) => acrossKinds(reported.filter((j) => j.severity === severity)));
  const takenReported: Saved[] = [];
  while (takenReported.length < Number(values.reported) && bySeverity.some((group) => group.length > 0)) {
    for (const group of bySeverity) if (group.length > 0 && takenReported.length < Number(values.reported)) takenReported.push(group.shift()!);
  }

  const nearThreshold = acrossKinds(unreported.toSorted((a, b) => b.p - a.p)).slice(0, Math.ceil(Number(values.unreported) / 2));
  const random = acrossKinds(unreported.filter((j) => !nearThreshold.includes(j))).slice(0, Number(values.unreported) - nearThreshold.length);
  sample.push(...takenReported, ...nearThreshold, ...random);
}

// What the labeller is asked to confirm must read the same whether or not the tool agreed. Most rules'
// messages already do. label-input-type's names the model's reading of the label, which for an
// unreported item came out as 'asks for an email value, but the input is type="email"': two labellers'
// worth of "true" for a claim nobody made. So its claim is stated from the facts alone.
const CLAIMS: Record<string, (j: Saved) => string> = {
  "label-input-type": (j) => `Field "${j.checked.label ?? j.checked.placeholder}" has type="${j.facts.type}", and that type does not suit what the field asks for.`,
  // The rule's own message ends "Say why, or remove it", which is advice to an author rather than something
  // a labeller can call true or false. Stated as the claim the label is actually about.
  "comment-gives-reason": (j) => `Comment "${j.checked.comment}" only restates what the code below it already says.`,
  // Two messages, one for a catch block holding a comment and one for a catch block holding nothing, would
  // tell a labeller which of the two the tool decided in code. One wording, stated from the facts, for both.
  "swallowed-error-justified": (j) =>
    j.checked.comment_in_empty_catch
      ? `Nothing in this catch block says why ignoring the error is safe: its only comment is "${j.checked.comment_in_empty_catch}".`
      : "Nothing in this catch block says why ignoring the error is safe: it holds no comment at all.",
};

const ordered = shuffled(sample);
const description = new Map(allRules.map((rule) => [rule.id, rule.description]));
writeFileSync(`${values.corpus}/label-sample.json`, JSON.stringify(ordered, null, 1));
// One file per item, so the bench can be loaded by file path and no page text passes through a prompt.
const itemsDir = `${values.corpus}/label-items`;
rmSync(itemsDir, { recursive: true, force: true });
mkdirSync(itemsDir, { recursive: true });
const items = ordered.map((j, n) => {
  const item = { id: `j${j.id}`, n, rule: j.rule, ruleDescription: description.get(j.rule), claim: CLAIMS[j.rule]?.(j) ?? j.message, hint: j.hint ?? "", snippet: j.snippet, checked: j.checked, facts: j.facts, page: j.page, kind: j.kind, band: j.band };
  writeFileSync(`${itemsDir}/${item.id}.json`, JSON.stringify(item));
  return item;
});
// The same items in one document, for a labeller who is not running the bench. Neither form carries a
// probability or a severity: what the tool concluded is exactly what the labels are there to check.
const drawnFrom = corpus.code ? "open-source JavaScript and TypeScript corpus" : "Tranco corpus";
writeFileSync(`${values.corpus}/label-sample-blind.json`, JSON.stringify({ createdFor: `seed-${corpus.seed} ${drawnFrom}, blind labelling round`, items }));

console.table(
  rules.map((rule) => {
    const mine = ordered.filter((j) => j.rule === rule.id);
    const kinds = [...new Set(mine.map((j) => j.kind))].map((kind) => `${kind} ${mine.filter((j) => j.kind === kind).length}`);
    return {
      rule: rule.id,
      reported: mine.filter((j) => j.severity !== null).length,
      unreported: mine.filter((j) => j.severity === null).length,
      // A rule's items spread over one repository or site are eight measurements of that house style.
      [corpus.code ? "repos" : "sites"]: new Set(mine.map(sourceOf)).size,
      kinds: kinds.join(", "),
    };
  }),
);
console.log(`${ordered.length} items`);
