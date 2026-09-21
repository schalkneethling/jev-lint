// Turns blind labels into precision and recall per rule. Export the labels from the label bench
// into <corpus>/labels/labels/<id>.json first (the ArtifactData tool's `out_dir` does this), then:
//
//   node scripts/corpus/score.ts [--corpus corpus] [--against classifications.json]
//
// With --against, the same labels score a later classifying run: each labelled item is found again by its
// rule, page, and the words that were classified, which stay the same when a question or a threshold
// changes. An item the later run no longer selects counts as not reported. Scoring a fix against the
// labels that motivated it flatters the fix; a fresh sample is the honest test.
//
// "Cannot tell" labels are counted but left out of both figures. Precision is over what the tool
// reported; recall is over what the labeller called true. The unreported half of the sample leans
// towards near-threshold cases on purpose, so recall here is a lower bound on the rule's real recall.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { corpus: { type: "string", default: "corpus" }, against: { type: "string" } } });
type Classified = { id: number; rule: string; page: string; p: number; severity: string | null; message: string; checked: Record<string, unknown> };
const drawn: Classified[] = JSON.parse(readFileSync(`${values.corpus}/label-sample.json`, "utf8"));

// Field names and nulls may change between runs; the words themselves identify the element.
const wordsOf = (j: Classified) => `${j.rule}|${j.page}|${Object.values(j.checked).filter((value) => typeof value === "string").sort().join("|")}`;
let dropped = 0;
const sample: Classified[] = values.against
  ? (() => {
      const later = new Map((JSON.parse(readFileSync(values.against!, "utf8")) as Classified[]).map((j) => [wordsOf(j), j]));
      return drawn.map((j) => {
        const again = later.get(wordsOf(j));
        if (!again) dropped++;
        return again ? { ...j, p: again.p, severity: again.severity } : { ...j, p: 0, severity: null };
      });
    })()
  : drawn;
const dir = `${values.corpus}/labels/labels`;
if (!existsSync(dir)) throw new Error(`No labels found in ${dir}. Export them from the label bench first.`);
const labels = new Map(readdirSync(dir).map((file) => [file.replace(".json", ""), JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as { label: string; note?: string }]));

const ratio = (a: number, b: number) => (b === 0 ? "n/a" : `${a}/${b} (${Math.round((a / b) * 100)}%)`);
const rows = [...new Set(sample.map((j) => j.rule))].map((rule) => {
  const mine = sample.filter((j) => j.rule === rule).map((j) => ({ ...j, given: labels.get(`j${j.id}`)?.label }));
  const decided = mine.filter((j) => j.given === "yes" || j.given === "no");
  const reported = decided.filter((j) => j.severity !== null);
  const trueOnes = decided.filter((j) => j.given === "yes");
  return {
    rule,
    labelled: `${mine.filter((j) => j.given).length}/${mine.length}`,
    "cannot tell": mine.filter((j) => j.given === "unsure").length,
    precision: ratio(reported.filter((j) => j.given === "yes").length, reported.length),
    "precision (error+warn)": ratio(reported.filter((j) => j.severity !== "review" && j.given === "yes").length, reported.filter((j) => j.severity !== "review").length),
    "recall (lower bound)": ratio(trueOnes.filter((j) => j.severity !== null).length, trueOnes.length),
  };
});
console.table(rows);
if (values.against) console.log(`${dropped} labelled items are no longer selected by their rule and count as not reported.`);

console.log("\nDisagreements, most confident first:");
const wrong = sample
  .map((j) => ({ ...j, ...labels.get(`j${j.id}`) }))
  .filter((j) => (j.label === "no" && j.severity !== null) || (j.label === "yes" && j.severity === null))
  .sort((a, b) => Math.abs(b.p - 0.5) - Math.abs(a.p - 0.5));
for (const j of wrong) console.log(`${j.label === "no" ? "FALSE+" : "MISSED"} ${j.rule} p=${j.p.toFixed(2)} ${JSON.stringify(j.checked).slice(0, 130)}${j.note ? `\n        note: ${j.note}` : ""}`);
