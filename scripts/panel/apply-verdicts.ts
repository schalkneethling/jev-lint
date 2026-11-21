// Writes a second reviewer's verdicts into the mined defect files, so that the gold set and the recall
// figure rest on defects two reviewers agree on.
//
//   node scripts/panel/apply-verdicts.ts [--verdicts corpus-code/rounds/verify]
//
// Each defect a miner listed (`<corpus>/rounds/mined/found-<n>.json`) was shown to a verifier of the other
// model, following `verifier.md`. A verdict's id is `c1-<n>-<index>` for corpus-code and `c2-<n>-<index>` for
// corpus-code-2. This sets `verified` ("yes", "no" or "unsure") on each finding, and corrects its `line`
// when the verifier found the words on another line. `gold.ts` and `mined-recall.ts` leave out a finding
// whose `verified` is "no". Running it again is harmless.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { verdicts: { type: "string", default: "corpus-code/rounds/verify" } } });
const CORPORA: Record<string, string> = { c1: "corpus-code", c2: "corpus-code-2" };

interface Verdict {
  id: string;
  confirmed: "yes" | "no" | "unsure";
  line?: number;
  note?: string;
}

const verdicts = readdirSync(values.verdicts)
  .filter((file) => /^verdicts-.+\.json$/.test(file))
  .flatMap((file) => JSON.parse(readFileSync(`${values.verdicts}/${file}`, "utf8")) as Verdict[]);

const tally: Record<string, Record<string, number>> = {};
const byFile = Map.groupBy(verdicts, (verdict) => verdict.id.split("-").slice(0, 2).join("-"));
for (const [key, mine] of byFile) {
  const [corpus, n] = key.split("-") as [string, string];
  const path = `${CORPORA[corpus]}/rounds/mined/found-${n}.json`;
  const found = JSON.parse(readFileSync(path, "utf8")) as { findings: { line: number; verified?: string; verifierNote?: string }[] };
  for (const verdict of mine) {
    const finding = found.findings[Number(verdict.id.split("-")[2])];
    if (!finding) throw new Error(`${verdict.id} names a finding ${path} does not have`);
    finding.verified = verdict.confirmed;
    if (verdict.note) finding.verifierNote = verdict.note;
    if (typeof verdict.line === "number" && verdict.line > 0) finding.line = verdict.line;
    ((tally[CORPORA[corpus]!] ??= {})[verdict.confirmed] ??= 0);
    tally[CORPORA[corpus]!]![verdict.confirmed]!++;
  }
  writeFileSync(path, JSON.stringify(found, null, 1));
}
console.table(tally);
