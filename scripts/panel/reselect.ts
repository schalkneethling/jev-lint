// Applies the current rules' *selection* to a saved classifying run, without asking Jev anything.
//
//   node scripts/panel/reselect.ts --from classifications-v2.json --to classifications-reselected.json [--corpus corpus-code]
//
// A change to which candidates a rule selects (skip test files, skip framework hooks, only names that
// promise an answer) needs no new answers: every classification it keeps was already made. This re-parses
// each corpus file, runs each rule's `select`, and keeps a saved classification only when the rule still
// selects a candidate on the same line. It is how a selection change is scored when no API key is at hand,
// and it is exact for that part. A change to a question or to the words sent is not covered: those
// classifications keep their old answers here and need a live run.
//
// --same-words <rule> keeps a rule's classification only when the words the rule would send today are the
// words that were classified. Use it for a rule whose candidates now carry more code: the ones dropped are
// exactly those whose old answer was about a slice the rule no longer sends.
//
// --rethreshold <rule> recomputes a rule's severities from its saved probabilities and the rule's current
// thresholds. Only valid for a rule whose questions and `assess` are unchanged since the saved run.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseCode } from "../../src/code/parse.ts";
import { severityFor } from "../../src/engine/types.ts";
import { codeRules } from "../../src/rules/index.ts";
import { placeOf, readCorpus } from "../corpus/corpus.ts";
import type { Saved } from "./draw-shared.ts";

const { values } = parseArgs({ options: { corpus: { type: "string", default: "corpus-code" }, from: { type: "string" }, to: { type: "string" }, "same-words": { type: "string", multiple: true }, rethreshold: { type: "string", multiple: true } } });
if (!values.from || !values.to) throw new Error("--from and --to are required");
const corpus = readCorpus(values.corpus);
const saved: Saved[] = JSON.parse(readFileSync(`${values.corpus}/${values.from}`, "utf8"));

const sameWords = new Set(values["same-words"] ?? []);
const stillSelected = new Set<string>();
for (const entry of corpus.files) {
  const doc = await parseCode(entry.file, readFileSync(entry.file, "utf8"));
  for (const rule of codeRules) for (const candidate of rule.select(doc)) stillSelected.add(`${rule.id}|${placeOf(corpus, entry.origin, candidate.loc.line)}${sameWords.has(rule.id) ? `|${JSON.stringify(candidate.data)}` : ""}`);
}

const codeRuleIds = new Set(codeRules.map((rule) => rule.id));
const thresholdsOf = new Map(codeRules.filter((rule) => (values.rethreshold ?? []).includes(rule.id)).map((rule) => [rule.id, rule.thresholds]));
const kept = saved
  .filter((j) => !codeRuleIds.has(j.rule) || stillSelected.has(`${j.rule}|${j.page}${sameWords.has(j.rule) ? `|${JSON.stringify(j.checked)}` : ""}`))
  .map((j) => (thresholdsOf.has(j.rule) ? { ...j, severity: severityFor(j.p, thresholdsOf.get(j.rule)) } : j));
writeFileSync(`${values.corpus}/${values.to}`, JSON.stringify(kept));

console.table(
  [...codeRuleIds].map((rule) => {
    const before = saved.filter((j) => j.rule === rule);
    const after = kept.filter((j) => j.rule === rule);
    const reported = (of: Saved[]) => of.filter((j) => j.severity !== null).length;
    const loud = (of: Saved[]) => of.filter((j) => j.severity === "error" || j.severity === "warn").length;
    return { rule, "candidates before": before.length, after: after.length, "reported before": reported(before), "reported after": reported(after), "error+warn before": loud(before), "error+warn after": loud(after) };
  }),
);
