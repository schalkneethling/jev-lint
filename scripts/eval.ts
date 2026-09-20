// Measures each rule against its labelled fixtures: every candidate under `bad/` should be
// reported and every candidate under `good/` should not. Run with `pnpm eval [--isolation <mode>]`.
import { globSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AnswerCache } from "../src/engine/cache.ts";
import { createAsk } from "../src/engine/client.ts";
import { run } from "../src/engine/run.ts";
import type { Isolation, Judgement } from "../src/engine/types.ts";
import { allRules } from "../src/rules/index.ts";

const { values } = parseArgs({ options: { isolation: { type: "string", multiple: true } } });
const isolations = (values.isolation ?? ["candidate", "rule", "file"]) as Isolation[];

const ask = createAsk();
const cache = new AnswerCache(".jev-lint-cache");
const read = (dir: string) => globSync(`${dir}/**/*.{html,ts,js}`).sort().map((path) => ({ path, source: readFileSync(path, "utf8") }));
const mean = (js: Judgement[]) => (js.reduce((sum, j) => sum + j.p, 0) / (js.length || 1)).toFixed(2);

const rows: Record<string, string | number>[] = [];
const misses: string[] = [];

for (const isolation of isolations) {
  // In `file` mode every rule shares one state per file, so all rules run together as they would in real use.
  const rules = allRules;
  let tokens = 0;
  for (const rule of rules) {
    const dir = `fixtures/${rule.target}/${rule.id}`;
    const active = isolation === "file" ? rules : [rule];
    const [bad, good] = await Promise.all(
      ["bad", "good"].map(async (label) => {
        const result = await run(read(`${dir}/${label}`), { rules: active, ask, isolation, cache });
        tokens += result.stats.inputTokens;
        return result.judgements.filter((j) => j.ruleId === rule.id);
      }),
    );
    const flagged = (j: Judgement) => j.severity !== null;
    const tp = bad!.filter(flagged).length;
    const fp = good!.filter(flagged).length;
    rows.push({
      isolation,
      rule: rule.id,
      recall: `${tp}/${bad!.length}`,
      "false positives": `${fp}/${good!.length}`,
      "mean p (bad)": mean(bad!),
      "mean p (good)": mean(good!),
    });
    for (const j of bad!.filter((j) => !flagged(j))) misses.push(`MISSED  ${isolation} ${rule.id} p=${j.p.toFixed(2)} ${JSON.stringify(j.candidate.data)}`);
    for (const j of good!.filter(flagged)) misses.push(`FALSE+  ${isolation} ${rule.id} p=${j.p.toFixed(2)} ${j.severity} ${JSON.stringify(j.candidate.data)}`);
  }
  console.log(`${isolation}: ${tokens} uncached input tokens`);
}

console.table(rows);
console.log(misses.join("\n") || "No misclassifications.");
