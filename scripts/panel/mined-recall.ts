// Recall against defects found independently of the rules. Model reviewers (Opus and Fable agents following
// `miner.md`) each read about 43 corpus files in full and listed every place where words and code disagree,
// without seeing any rule or any classification (<corpus>/rounds/mined/found-*.json, one file per reviewer). This counts how many of those places a
// classifying run reported, and at what severity.
//
//   node scripts/panel/mined-recall.ts [--corpus corpus-code] [--against <path to classifications>] [--within 8] [--misses]
//
// --against is a path as given, not a name inside the corpus. --misses lists every mined defect with what
// became of it: found (and by which rule), passed over by a rule that looked, or not looked at.
//
// A mined defect counts as found when any rule reports within `--within` lines of it in the same file: the
// reviewers and the extractor do not always anchor a finding on the same line (a comment above a function,
// a throw inside an if). The mined list is small and was not checked by a human, so read the number as a
// direction, and read the misses: they say which defects no rule looks at.
import { readdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Saved } from "./draw-shared.ts";

const { values } = parseArgs({ options: { corpus: { type: "string", default: "corpus-code" }, against: { type: "string" }, within: { type: "string", default: "8" }, misses: { type: "boolean", default: false } } });
interface Mined {
  file: string;
  line: number;
  kind: string;
  text: string;
  why: string;
  confidence: string;
}
const dir = `${values.corpus}/rounds/mined`;
// One file per reviewer. A finding a second reviewer refuted (`apply-verdicts.ts`) is left out.
const mined: Mined[] = readdirSync(dir)
  .filter((file) => /^found-\d+\.json$/.test(file))
  .flatMap((file) => (JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as { findings: (Mined & { verified?: string })[] }).findings)
  .filter((defect) => defect.verified !== "no");
const classified: Saved[] = JSON.parse(readFileSync(values.against ?? `${values.corpus}/classifications.json`, "utf8"));

// `page` is "owner/repo: path:line"; a mined file is "<corpus>/snapshots/owner__repo/path".
const placeOf = (j: Saved) => {
  const [repo, rest] = j.page.split(": ") as [string, string];
  const at = rest.lastIndexOf(":");
  return { file: `${values.corpus}/snapshots/${repo.replace("/", "__")}/${rest.slice(0, at)}`, line: Number(rest.slice(at + 1)) };
};
const byFile = Map.groupBy(classified.map((j) => ({ ...j, ...placeOf(j) })), (j) => j.file);
const within = Number(values.within);
const rank = { error: 3, warn: 2, review: 1 } as Record<string, number>;

const rows = mined.map((defect) => {
  const near = (byFile.get(defect.file) ?? []).filter((j) => Math.abs(j.line - defect.line) <= within);
  const reported = near.filter((j) => j.severity !== null).sort((a, b) => rank[b.severity!]! - rank[a.severity!]!);
  const best = reported[0];
  // Highest probability of any rule that looked here without reporting: was it seen and passed, or never seen?
  const closest = near.sort((a, b) => b.p - a.p)[0];
  return { defect, best, closest };
});
const found = rows.filter((row) => row.best);
const loud = found.filter((row) => row.best!.severity !== "review");
const pct = (n: number) => `${n}/${rows.length} (${Math.round((n / rows.length) * 100)}%)`;
console.log(`Mined defects reported: ${pct(found.length)}; as error or warning: ${pct(loud.length)}; a rule looked there but did not report: ${rows.filter((row) => !row.best && row.closest).length}; no rule looked: ${rows.filter((row) => !row.closest).length}`);
console.table(
  [...Map.groupBy(rows, (row) => row.defect.kind)].map(([kind, of]) => ({ kind, mined: of.length, reported: of.filter((row) => row.best).length })).sort((a, b) => b.mined - a.mined),
);
if (values.misses) {
  for (const { defect, best, closest } of rows) {
    console.log(`${best ? `FOUND ${best.severity} ${best.rule} p=${best.p}` : closest ? `PASSED ${closest.rule} p=${closest.p}` : "UNSEEN"}  ${defect.kind}  ${defect.file.split("/").slice(-1)[0]}:${defect.line}  ${String(defect.text).replace(/\s+/g, " ").slice(0, 90)}`);
  }
}
