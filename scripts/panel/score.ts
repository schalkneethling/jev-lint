// Scores one panel round: what each model labeller said about each sampled classification, per rule.
//
//   node scripts/panel/score.ts --round 1 [--corpus corpus-code] [--against <path to classifications>] [--human]
//
// A labeller answers two things per item: is the claim true of the code (`true`), and would a careful
// reviewer want it raised (`worth`). An item counts as right for a labeller only when both are yes.
// The panel's consensus is "right" when every labeller says right, "wrong" when none does, and
// "contested" otherwise. Precision is reported strictly (contested counts as not right) because the
// tool is meant to raise few, certain findings.
//
// --against (a path as given, unlike draw.ts's --from, which is a name inside the corpus) scores the same
// labels against a later classifying run, as `scripts/corpus/score.ts` does:
// it flatters a fix made after reading these labels. A new round is the honest test.
// --human compares the panel with the human labels on the items both have labelled.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { wordsOf, type Saved } from "./draw-shared.ts";

const { values } = parseArgs({
  options: { corpus: { type: "string", default: "corpus-code" }, round: { type: "string" }, against: { type: "string" }, human: { type: "boolean", default: false }, quiet: { type: "boolean", default: false } },
});
if (!values.round) throw new Error("--round is required");
const dir = `${values.corpus}/rounds/panel-${values.round}`;

interface Label {
  id: string;
  true: "yes" | "no" | "unsure";
  worth: "yes" | "no";
  note?: string;
}

let sample: Saved[] = JSON.parse(readFileSync(`${dir}/sample.json`, "utf8"));
let dropped = 0;
if (values.against) {
  const later = new Map((JSON.parse(readFileSync(values.against, "utf8")) as Saved[]).map((j) => [wordsOf(j), j]));
  sample = sample.map((j) => {
    const again = later.get(wordsOf(j));
    if (!again) dropped++;
    return again ? { ...j, p: again.p, severity: again.severity } : { ...j, p: 0, severity: null };
  });
}

// labels-<labeller>-<chunk>.json, one array of labels per file.
const byLabeller = new Map<string, Map<string, Label>>();
for (const file of readdirSync(dir).filter((name) => /^labels-.+\.json$/.test(name))) {
  const labeller = file.replace(/^labels-/, "").replace(/-\d+\.json$/, "");
  const labels = byLabeller.get(labeller) ?? new Map<string, Label>();
  for (const label of JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as Label[]) labels.set(label.id, label);
  byLabeller.set(labeller, labels);
}
const labellers = [...byLabeller.keys()].sort();
if (labellers.length === 0) throw new Error(`No labels-*.json in ${dir}`);

const idOf = (j: Saved) => (j.id < 0 ? `h${-j.id}` : `p${j.id}`);
const isRight = (label: Label | undefined) => label?.true === "yes" && label.worth === "yes";
type Consensus = "right" | "wrong" | "contested" | "unlabelled";
function consensusOf(j: Saved): Consensus {
  const given = labellers.map((labeller) => byLabeller.get(labeller)!.get(idOf(j)));
  if (given.some((label) => label === undefined)) return "unlabelled";
  const right = given.filter(isRight).length;
  return right === given.length ? "right" : right === 0 ? "wrong" : "contested";
}

const ratio = (a: number, b: number) => (b === 0 ? "n/a" : `${a}/${b} (${Math.round((a / b) * 100)}%)`);
const mean = (xs: number[]) => (xs.length === 0 ? "n/a" : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2));
const judged = sample.map((j) => ({ ...j, consensus: consensusOf(j) })).filter((j) => j.consensus !== "unlabelled");

const rows = [...new Set(judged.map((j) => j.rule))].map((rule) => {
  const mine = judged.filter((j) => j.rule === rule);
  const reported = mine.filter((j) => j.severity !== null);
  const loud = reported.filter((j) => j.severity !== "review");
  const count = (of: typeof mine, consensus: Consensus) => of.filter((j) => j.consensus === consensus).length;
  const row: Record<string, string | number> = {
    rule,
    "error+warn right": ratio(count(loud, "right"), loud.length),
    "all reported right": ratio(count(reported, "right"), reported.length),
    contested: count(reported, "contested"),
  };
  for (const labeller of labellers) row[labeller] = ratio(reported.filter((j) => isRight(byLabeller.get(labeller)!.get(idOf(j)))).length, reported.length);
  // Do the probabilities rank? If right and wrong reports sit at the same mean p, no threshold can separate them.
  row["mean p right"] = mean(reported.filter((j) => j.consensus === "right").map((j) => j.p));
  row["mean p wrong"] = mean(reported.filter((j) => j.consensus === "wrong").map((j) => j.p));
  const trueOnes = mine.filter((j) => j.consensus === "right");
  row["recall (lower bound)"] = ratio(trueOnes.filter((j) => j.severity !== null).length, trueOnes.length);
  return row;
});
console.table(rows);
const allReported = judged.filter((j) => j.severity !== null);
const allLoud = allReported.filter((j) => j.severity !== "review");
console.log(
  `Panel: ${labellers.join(", ")}. ${judged.length} items. error+warn right ${ratio(allLoud.filter((j) => j.consensus === "right").length, allLoud.length)}; all reported right ${ratio(allReported.filter((j) => j.consensus === "right").length, allReported.length)}.`,
);
if (values.against) console.log(`${dropped} items are no longer selected by their rule and count as not reported.`);

if (labellers.length > 1) {
  const both = judged.filter((j) => j.consensus !== "contested").length;
  console.log(`Labellers agree with each other on ${ratio(both, judged.length)} of items.`);
}

if (values.human) {
  const humanDir = `${values.corpus}/labels/labels`;
  const human = new Map(readdirSync(humanDir).map((file) => [file.replace(".json", "").replace(/^j/, "h"), JSON.parse(readFileSync(`${humanDir}/${file}`, "utf8")) as { label: string; note?: string }]));
  for (const labeller of labellers) {
    const shared = [...byLabeller.get(labeller)!.values()].filter((label) => human.has(label.id) && human.get(label.id)!.label !== "unsure" && label.true !== "unsure");
    console.log(`${labeller} agrees with the human label ("is the claim true") on ${ratio(shared.filter((label) => label.true === human.get(label.id)!.label).length, shared.length)}.`);
    for (const label of shared.filter((l) => l.true !== human.get(l.id)!.label)) console.log(`   ${label.id}: human ${human.get(label.id)!.label} (${human.get(label.id)!.note?.slice(0, 160) ?? ""}) vs ${label.true}: ${label.note}`);
  }
}

// What to read before changing anything: the reports the panel called wrong, and the misses it called right.
const lines: string[] = [];
for (const j of judged.toSorted((a, b) => a.rule.localeCompare(b.rule) || b.p - a.p)) {
  const wrongReport = j.severity !== null && j.consensus !== "right";
  const missed = j.severity === null && j.consensus === "right";
  if (!wrongReport && !missed) continue;
  lines.push(`${missed ? "MISSED" : j.consensus === "contested" ? "CONTESTED" : "FALSE+"} ${j.rule} ${idOf(j)} p=${j.p.toFixed(2)} ${j.severity ?? "-"}  ${j.page}`);
  lines.push(`    ${JSON.stringify(j.checked).slice(0, 300)}`);
  for (const labeller of labellers) {
    const label = byLabeller.get(labeller)!.get(idOf(j))!;
    lines.push(`    ${labeller}: true=${label.true} worth=${label.worth} ${label.note ?? ""}`);
  }
}
writeFileSync(`${dir}/disagreements${values.against ? "-against" : ""}.txt`, lines.join("\n"));
if (!values.quiet) console.log(`\n${lines.length === 0 ? "No disagreements." : `Disagreements written to ${dir}/disagreements${values.against ? "-against" : ""}.txt`}`);
