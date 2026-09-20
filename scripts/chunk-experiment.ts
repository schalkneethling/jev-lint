// How many candidates can share one state before judgements drift from the isolated baseline?
// Usage: varlock run -- node scripts/chunk-experiment.ts <file.html> <rule-id>
import { readFileSync } from "node:fs";
import { AnswerCache } from "../src/engine/cache.ts";
import { createAsk } from "../src/engine/client.ts";
import { run } from "../src/engine/run.ts";
import { htmlRules } from "../src/rules/index.ts";

const [path, ruleId] = process.argv.slice(2);
const rules = htmlRules.filter((rule) => rule.id === ruleId);
const files = [{ path: path!, source: readFileSync(path!, "utf8") }];
const ask = createAsk();
const cache = new AnswerCache(".jev-lint-cache");

const baseline = await run(files, { rules, ask, cache, isolation: "candidate" });
const rows = [];
for (const maxCandidates of [2, 4, 8, 16, 32, 64, Infinity]) {
  const { judgements, stats } = await run(files, { rules, ask, cache, isolation: "rule", maxCandidates });
  const drift = judgements.map((j, i) => Math.abs(j.p - baseline.judgements[i]!.p));
  const flips = judgements.filter((j, i) => (j.severity === null) !== (baseline.judgements[i]!.severity === null)).length;
  rows.push({
    "candidates per state": maxCandidates,
    requests: stats.requests,
    "input tokens": stats.inputTokens,
    "mean |Δp|": (drift.reduce((a, b) => a + b, 0) / drift.length).toFixed(3),
    "max |Δp|": Math.max(...drift).toFixed(2),
    "reported/not flips": `${flips}/${judgements.length}`,
  });
}
console.log(`baseline: ${baseline.judgements.length} candidates, ${baseline.stats.requests} requests, ${baseline.stats.inputTokens} tokens (cached answers cost 0)`);
console.table(rows);
