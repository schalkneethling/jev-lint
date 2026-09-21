// Runs every HTML rule over the corpus and keeps every judgement, reported or not. Precision needs a
// sample of what was reported; recall needs a sample of what was not, so both are saved.
//
//   varlock run -- node scripts/corpus/judge.ts [--corpus corpus]
//   node scripts/corpus/judge.ts --cache-only      re-read after a change to code or policy; asks nothing
//
// Writes <corpus>/judgements.json (gitignored: it quotes other people's pages) and prints, per rule, how
// many candidates were judged, how many were reported at each severity, where the probabilities fall,
// and how many reports are "valid but false", meaning axe passed the form of the same element.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { FORM_CHECKS, readAxeReport } from "../../src/axe/report.ts";
import { AnswerCache } from "../../src/engine/cache.ts";
import { createAsk, type Ask } from "../../src/engine/client.ts";
import { run } from "../../src/engine/run.ts";
import { htmlRules } from "../../src/rules/index.ts";

const { values } = parseArgs({ options: { corpus: { type: "string", default: "corpus" }, "cache-only": { type: "boolean", default: false } } });
const manifest: { pages: { file: string; url: string; kind: string; band: string }[] } = JSON.parse(readFileSync(`${values.corpus}/manifest.json`, "utf8"));
const axeByFile = readAxeReport(`${values.corpus}/axe-report.json`);

// Tens of thousands of requests against a limit of 1,200 a minute: pace them, and retry the ones that
// still fail, because one rejected request would otherwise end a run that takes half an hour.
const REQUESTS_PER_MINUTE = 1000;
const MAX_ATTEMPTS = 6;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function paced(ask: Ask): Ask {
  let nextSlot = Date.now();
  return async (state, questions) => {
    for (let attempt = 1; ; attempt++) {
      const slot = Math.max(nextSlot, Date.now());
      nextSlot = slot + 60_000 / REQUESTS_PER_MINUTE;
      await sleep(slot - Date.now());
      try {
        return await ask(state, questions);
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) throw error;
        await sleep(2 ** attempt * 1000);
      }
    }
  };
}

const files = manifest.pages.map((page) => ({ path: page.file, source: readFileSync(page.file, "utf8"), axe: axeByFile.get(page.file) ?? [] }));
const started = Date.now();
const { judgements, findings, stats } = await run(files, {
  rules: htmlRules,
  ask: values["cache-only"] ? async () => Promise.reject(new Error("cache-only")) : paced(createAsk()),
  cacheOnly: values["cache-only"],
  isolation: "candidate",
  cache: new AnswerCache(".jev-lint-cache"),
  concurrency: 16,
});

const pageOf = new Map(manifest.pages.map((page) => [page.file, page]));
const axeOf = new Map(files.map((file) => [file.path, file.axe]));
const sources = new Map(files.map((file) => [file.path, file.source]));

const saved = judgements.map((j, index) => {
  const { span, axe: stamps = [] } = j.candidate.loc;
  const onElement = stamps.map((stamp) => axeOf.get(j.file)![stamp]!).filter((result) => (FORM_CHECKS[j.ruleId] ?? []).includes(result.rule));
  return {
    id: index,
    rule: j.ruleId,
    page: pageOf.get(j.file)!.url,
    kind: pageOf.get(j.file)!.kind,
    band: pageOf.get(j.file)!.band,
    p: Number(j.p.toFixed(3)),
    severity: j.severity,
    message: j.message,
    hint: j.hint,
    snippet: span ? sources.get(j.file)!.slice(span.start, Math.min(span.end, span.start + 400)).replace(/ data-jev-axe="[^"]*"/g, "").replace(/\s+/g, " ") : "",
    checked: j.candidate.data,
    facts: { ...j.candidate.meta, ...(j.candidate.loc.widget && { "third-party widget": j.candidate.loc.widget }) },
    axePassed: onElement.filter((result) => result.outcome === "passed").map((result) => result.rule),
  };
});
writeFileSync(`${values.corpus}/judgements.json`, JSON.stringify(saved));

const histogram = (ps: number[]) => Array.from({ length: 5 }, (_, i) => ps.filter((p) => Math.min(4, Math.floor(p * 5)) === i).length).join(" ");
const rows = htmlRules.map((rule) => {
  const mine = saved.filter((j) => j.rule === rule.id);
  const reported = mine.filter((j) => j.severity !== null);
  return {
    rule: rule.id,
    judged: mine.length,
    error: mine.filter((j) => j.severity === "error").length,
    warn: mine.filter((j) => j.severity === "warn").length,
    review: mine.filter((j) => j.severity === "review").length,
    "pages reported": new Set(reported.map((j) => j.page)).size,
    "valid but false": reported.filter((j) => j.axePassed.length > 0).length,
    "p: 0-.2 .2-.4 .4-.6 .6-.8 .8-1": histogram(mine.map((j) => j.p)),
  };
});
console.table(rows);
const cost = (stats.inputTokens / 1_000_000) * 0.042;
console.log(
  `${files.length} pages, ${saved.length} judgements, ${findings.length} reported, ${stats.unanswered} unjudged. ${stats.questions} questions, ${stats.cacheHits} cached, ${stats.requests} requests, ${stats.inputTokens.toLocaleString("en")} tokens, $${cost.toFixed(2)}, ${Math.round((Date.now() - started) / 1000)}s`,
);
