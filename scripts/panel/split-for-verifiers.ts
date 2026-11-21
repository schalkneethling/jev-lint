// Prepares the mined defects that no verifier has seen yet for a second reviewer of the other model.
//
//   node scripts/panel/split-for-verifiers.ts --corpus corpus-code-2 --miners 6:opus,7:fable,8:opus [--chunk 40]
//
// `--miners` says which model wrote each `found-<n>.json`. A defect an Opus reviewer listed goes to a Fable
// verifier and the reverse, so that no defect is kept on one model's word. Writes
// corpus-code/rounds/verify/items-<verifier>-<batch>-<k>.json; each verifier follows `verifier.md` and writes
// verdicts-<verifier>-<batch>-<k>.json beside it. `apply-verdicts.ts` then records the verdicts in the found files.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { corpus: { type: "string", default: "corpus-code" }, miners: { type: "string" }, chunk: { type: "string", default: "40" }, out: { type: "string", default: "corpus-code/rounds/verify" } } });
if (!values.miners) throw new Error("--miners is required, for example 6:opus,7:fable");
// The id prefix `apply-verdicts.ts` maps back to a corpus.
const prefix = values.corpus === "corpus-code" ? "c1" : values.corpus === "corpus-code-2" ? "c2" : undefined;
if (!prefix) throw new Error(`No id prefix is defined for ${values.corpus}; add one here and in apply-verdicts.ts.`);

interface Finding {
  file: string;
  line: number;
  kind: string;
  text: string;
  code: string;
  why: string;
  verified?: string;
}
const other = { opus: "fable", fable: "opus" } as const;
const forVerifier: Record<string, object[]> = { opus: [], fable: [] };
for (const pair of values.miners.split(",")) {
  const [n, miner] = pair.split(":") as [string, "opus" | "fable"];
  if (!(miner in other)) throw new Error(`Unknown miner model "${miner}" in --miners`);
  const found = JSON.parse(readFileSync(`${values.corpus}/rounds/mined/found-${n}.json`, "utf8")) as { findings: Finding[] };
  found.findings.forEach((finding, index) => {
    if (finding.verified !== undefined) return;
    forVerifier[other[miner]]!.push({ id: `${prefix}-${n}-${index}`, file: finding.file, line: finding.line, kind: finding.kind, text: finding.text, code: finding.code, why: finding.why });
  });
}

mkdirSync(values.out, { recursive: true });
const batch = Date.now().toString(36);
const size = Number(values.chunk);
for (const [verifier, items] of Object.entries(forVerifier)) {
  for (let k = 0; k * size < items.length; k++) {
    const path = `${values.out}/items-${verifier}-${batch}-${k}.json`;
    writeFileSync(path, JSON.stringify(items.slice(k * size, (k + 1) * size), null, 1));
    console.log(`${path}  ${Math.min(size, items.length - k * size)} items → write verdicts to ${path.replace("items-", "verdicts-")}`);
  }
}
