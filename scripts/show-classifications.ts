// Prints every candidate a rule classified, reported or not, with its probability and the words Jev saw.
// A clean report says nothing about how close the calls were; this does.
// Usage: varlock run -- node scripts/show-classifications.ts <file|url> <rule-id>
import { readFileSync } from "node:fs";
import { AnswerCache } from "../src/engine/cache.ts";
import { createAsk } from "../src/engine/client.ts";
import { run } from "../src/engine/run.ts";
import { allRules } from "../src/rules/index.ts";

const [target, ruleId] = process.argv.slice(2);
const isUrl = /^https?:\/\//.test(target!);
const renderer = isUrl ? await import("../src/html/render.ts") : undefined;
const source = isUrl ? await renderer!.renderPage(target!) : readFileSync(target!, "utf8");
await renderer?.closeBrowser();

const { classifications } = await run([{ path: target!, source }], {
  rules: allRules.filter((rule) => rule.id === ruleId),
  ask: createAsk(),
  isolation: "candidate",
  cache: new AnswerCache(".jev-lint-cache"),
});

for (const j of classifications.toSorted((a, b) => b.p - a.p)) {
  const [first, ...rest] = Object.values(j.candidate.data).map((value) => String(value).replace(/\s+/g, " "));
  console.log(`${j.p.toFixed(2)}  ${(j.severity ?? "-").padEnd(6)} ${first}`);
  for (const value of rest) console.log(`               ${value.slice(0, 150)}${value.length > 150 ? "…" : ""}`);
}
