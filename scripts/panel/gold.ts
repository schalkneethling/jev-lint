// Scores a classifying run against a gold set that costs no labelling: the defects reviewers found by
// reading, and everything in the same files that they read and did not flag.
//
//   node scripts/panel/gold.ts [--corpus corpus-code] [--against <path to classifications>] [--list <rule>] [--uncovered] [--curve] [--dump <file>]
//
// --list prints a rule's flagged candidates and its high-probability unflagged ones, to read.
// --uncovered prints the defects no rule meant for their family selects: the extraction gap.
//
// A panel round answers "is this report right?" and has to be drawn, labelled and scored again after every
// change. This answers a different question at no cost per change: of the candidates a rule selects in the
// files a reviewer read in full, which sit on a defect the reviewer listed (positive) and which do not
// (negative), and do the rule's probabilities put the first above the second?
//
// Per rule it prints the candidates and positives in the read files, how many the run classified, and:
//   AUC          the chance that a positive candidate has a higher probability than a negative one.
//                0.5 is no ranking at all. This is working rule 20 as a number.
//   reported     positives and negatives the rule reports at its own thresholds, any severity and loud only.
//
// Read the numbers for what they are. A negative is "a careful reader did not flag it", which is not "it is
// fine": reviewers miss things and were not asked about style, so precision here is a lower bound. A
// positive is matched by family of defect and by the line of the candidate's own words (its doc comment and
// name, its title, its comment), so a comment rule is not credited with a test defect three lines away, and
// a class is not credited with its methods' defects. And the sets are small: a rule with four positives has an AUC worth one glance.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseCode } from "../../src/code/parse.ts";
import { severityFor } from "../../src/engine/types.ts";
import { codeRules } from "../../src/rules/index.ts";
import { placeOf, readCorpus } from "../corpus/corpus.ts";
import type { Saved } from "./draw-shared.ts";

const { values } = parseArgs({ options: { corpus: { type: "string", default: "corpus-code" }, against: { type: "string" }, list: { type: "string" }, uncovered: { type: "boolean", default: false }, slack: { type: "string", default: "2" }, curve: { type: "boolean", default: false }, dump: { type: "string" } } });
const corpus = readCorpus(values.corpus);
const dir = `${values.corpus}/rounds/mined`;

interface Mined {
  file: string;
  line: number;
  kind: string;
  text: string;
  /** A second reviewer's verdict, once `apply-verdicts.ts` has run. A defect the second reviewer refuted is left out. */
  verified?: "yes" | "no" | "unsure";
}

/** The family of a reviewer's free-form `kind`, and the rules that are meant to find that family. */
const FAMILIES: { name: string; kinds: RegExp; rules: string[] }[] = [
  { name: "message", kinds: /message|log/, rules: ["error-message-matches-guard"] },
  { name: "comment", kinds: /comment|copy-paste|stale/, rules: ["comment-describes-code", "doc-matches-function", "doc-matches-function-next"] },
  { name: "doc", kinds: /jsdoc|doc|param|description|example/, rules: ["doc-matches-function", "doc-matches-function-next", "comment-describes-code"] },
  { name: "test", kinds: /test|assert/, rules: ["test-title-matches-body", "test-title-matches-body-next", "test-assertions-can-fail"] },
  { name: "name", kinds: /name|boolean/, rules: ["function-name-matches-body", "boolean-name-holds-boolean"] },
  { name: "ignored error", kinds: /catch|swallow/, rules: ["swallowed-error-justified"] },
];
const rulesFor = (kind: string) => FAMILIES.find((family) => family.kinds.test(kind))?.rules ?? [];

const mined: Mined[] = readdirSync(dir)
  .filter((file) => /^found-\d+\.json$/.test(file))
  .flatMap((file) => (JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as { findings: Mined[] }).findings);
const listed = mined.length;
const refuted = mined.filter((defect) => defect.verified === "no").length;
mined.splice(0, mined.length, ...mined.filter((defect) => defect.verified !== "no"));
// The files reviewers were given (read-files.txt, one path per line), and any file a defect was listed in:
// a reviewer who listed a defect in a file read it, whatever the list says.
const read = new Set([...readFileSync(`${dir}/read-files.txt`, "utf8").split("\n").filter(Boolean), ...mined.map((defect) => defect.file)]);
const minedByFile = Map.groupBy(mined, (defect) => defect.file);

const classified = new Map((JSON.parse(readFileSync(values.against ?? `${values.corpus}/classifications.json`, "utf8")) as Saved[]).map((j) => [`${j.rule}|${j.page}`, j]));
const slack = Number(values.slack);

interface Row {
  rule: string;
  positive: boolean;
  p: number | undefined;
  place: string;
  words: string;
}
const rows: Row[] = [];
const credited = new Set<Mined>();
for (const entry of corpus.files) {
  if (!read.has(entry.file)) continue;
  const source = readFileSync(entry.file, "utf8");
  const doc = await parseCode(entry.file, source);
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;
  const defects = minedByFile.get(entry.file) ?? [];
  for (const rule of codeRules) {
    const candidates = rule.select(doc).map((candidate) => {
      const lines = candidate.loc.lines ?? { first: candidate.loc.line, last: candidate.loc.line };
      // The head is the words themselves: the doc comment and the name, the title, the comment. A reviewer
      // cites a defect by the line of its words, so only the head can claim it. Matching on the whole span
      // credited a class with its methods' defects and a test with the next test's.
      const headEnd = candidate.loc.span ? lineAt(candidate.loc.span.end) : candidate.loc.line;
      return { candidate, head: { first: lines.first - slack, last: headEnd + slack }, size: lines.last - lines.first };
    });
    // Each defect goes to one candidate per rule: the one whose head holds its line, the smallest if several do.
    const claimed = new Map<(typeof candidates)[number], Mined[]>();
    for (const defect of defects.filter((found) => rulesFor(found.kind).includes(rule.id))) {
      const owner = candidates.filter(({ head }) => defect.line >= head.first && defect.line <= head.last).sort((x, y) => x.size - y.size)[0];
      if (!owner) continue;
      claimed.set(owner, [...(claimed.get(owner) ?? []), defect]);
      credited.add(defect);
    }
    for (const entryOf of candidates) {
      const { candidate } = entryOf;
      const place = placeOf(corpus, entry.origin, candidate.loc.line);
      rows.push({ rule: rule.id, positive: claimed.has(entryOf), p: candidate.decided?.p ?? classified.get(`${rule.id}|${place}`)?.p, place, words: JSON.stringify(candidate.data).slice(0, 160) });
    }
  }
}

/** The chance that a positive outranks a negative, ties counting half. */
function auc(positives: number[], negatives: number[]): string {
  if (positives.length === 0 || negatives.length === 0) return "n/a";
  let wins = 0;
  for (const positive of positives) for (const negative of negatives) wins += positive > negative ? 1 : positive === negative ? 0.5 : 0;
  return (wins / (positives.length * negatives.length)).toFixed(2);
}

const thresholds = new Map(codeRules.map((rule) => [rule.id, rule.thresholds]));
console.table(
  codeRules.map((rule) => {
    const mine = rows.filter((row) => row.rule === rule.id);
    const answered = mine.filter((row) => row.p !== undefined) as (Row & { p: number })[];
    const positives = answered.filter((row) => row.positive);
    const negatives = answered.filter((row) => !row.positive);
    const severity = (row: { p: number }) => severityFor(row.p, thresholds.get(rule.id));
    const reported = (of: { p: number }[], loudOnly: boolean) => of.filter((row) => (loudOnly ? ["error", "warn"].includes(severity(row) ?? "") : severity(row) !== null)).length;
    return {
      rule: rule.id,
      candidates: mine.length,
      positives: mine.filter((row) => row.positive).length,
      classified: answered.length,
      AUC: auc(positives.map((row) => row.p), negatives.map((row) => row.p)),
      "reported: on a defect / not": `${reported(positives, false)} / ${reported(negatives, false)}`,
      "loud: on a defect / not": `${reported(positives, true)} / ${reported(negatives, true)}`,
    };
  }),
);
// --dump writes every candidate with whether a kept defect sits on it, for experiments that join on rule and place.
if (values.dump) writeFileSync(values.dump, JSON.stringify(rows));

// With a second reader to confirm each report, a rule's threshold decides how much that reader has to read
// and how many defects it gets the chance to confirm. --curve prints both for each cut of the probability.
if (values.curve) {
  const cuts = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  console.table(
    codeRules
      .map((rule) => rows.filter((row) => row.rule === rule.id && row.p !== undefined) as (Row & { p: number })[])
      .filter((mine) => mine.some((row) => row.positive))
      .map((mine) => ({
        rule: mine[0]!.rule,
        positives: mine.filter((row) => row.positive).length,
        ...Object.fromEntries(cuts.map((cut) => [`p>=${cut}`, `${mine.filter((row) => row.positive && row.p >= cut).length} in ${mine.filter((row) => row.p >= cut).length}`])),
      })),
  );
}
const reachable = mined.filter((defect) => rulesFor(defect.kind).length > 0);
console.log(
  `${read.size} files read by reviewers, ${listed} defects listed${refuted > 0 ? `, ${refuted} refuted by a second reviewer and left out` : ""}, ${mined.length} kept, ${reachable.length} of a family some rule is meant for, ${credited.size} on a candidate some such rule selects (${mined.length - reachable.length} of a family no rule covers, ${reachable.length - credited.size} with no candidate).`,
);

// Defects of a family a rule is meant for that no such rule selects: the extraction gap, to be read one by one.
if (values.uncovered) {
  for (const defect of reachable.filter((defect) => !credited.has(defect))) {
    console.log(`NO CANDIDATE  ${defect.kind}  ${defect.file.split("/").slice(-2).join("/")}:${defect.line}  ${String(defect.text).replace(/\s+/g, " ").slice(0, 110)}`);
  }
}

if (values.list) {
  for (const row of rows.filter((row) => row.rule === values.list && (row.positive || (row.p ?? 0) >= 0.5)).sort((a, b) => (b.p ?? -1) - (a.p ?? -1))) {
    console.log(`${row.positive ? "DEFECT " : "       "} p=${row.p === undefined ? "  ? " : row.p.toFixed(2)}  ${row.place}  ${row.words}`);
  }
}
