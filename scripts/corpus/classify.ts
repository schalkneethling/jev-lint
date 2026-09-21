// Runs every rule the corpus can support over it and keeps every classification, reported or not. Precision
// needs a sample of what was reported; recall needs a sample of what was not, so both are saved.
//
//   varlock run -- node scripts/corpus/classify.ts [--corpus corpus]
//   node scripts/corpus/classify.ts --cache-only      re-read after a change to code or policy; asks nothing
//
// Writes <corpus>/classifications.json (gitignored: it quotes other people's work) and prints, per rule, how
// many candidates were classified, how many were reported at each severity, where the probabilities fall,
// and how many reports are "valid but false", meaning axe passed the form of the same element.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { FORM_CHECKS, readAxeReport } from "../../src/axe/report.ts";
import { AnswerCache } from "../../src/engine/cache.ts";
import { createAsk, type Ask } from "../../src/engine/client.ts";
import { run } from "../../src/engine/run.ts";
import { allRules, htmlRules } from "../../src/rules/index.ts";
import { placeOf, readCorpus } from "./corpus.ts";

const { values } = parseArgs({ options: { corpus: { type: "string", default: "corpus" }, "cache-only": { type: "boolean", default: false } } });
const corpus = readCorpus(values.corpus);
// Nothing in a code corpus was rendered in a browser, so there is no axe report to join against.
const axeByFile = corpus.code ? new Map<string, never[]>() : readAxeReport(`${values.corpus}/axe-report.json`);
const rules = corpus.code ? allRules : htmlRules;

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

const files = corpus.files.map((entry) => ({ path: entry.file, source: readFileSync(entry.file, "utf8"), axe: axeByFile.get(entry.file) ?? [] }));
const started = Date.now();
const { classifications, findings, stats } = await run(files, {
  rules,
  ask: values["cache-only"] ? async () => Promise.reject(new Error("cache-only")) : paced(createAsk()),
  cacheOnly: values["cache-only"],
  isolation: "candidate",
  cache: new AnswerCache(".jev-lint-cache"),
  concurrency: 16,
});

const entryOf = new Map(corpus.files.map((entry) => [entry.file, entry]));
const axeOf = new Map(files.map((file) => [file.path, file.axe]));
const sources = new Map(files.map((file) => [file.path, file.source]));

const MARKUP_SNIPPET_CHARS = 400;
const CODE_SNIPPET_LINES = 60;
const CODE_SNIPPET_CHARS = 4_000;
// Lines above the candidate that go into the snippet. A catch clause starts at the word `catch`, but what a
// labeller has to read is the try block above it. The other code rules start at the top of the thing they are
// about — the comment, the signature, the test's call — so they need no lead-in at all.
const CODE_SNIPPET_LEAD: Record<string, number> = { "swallowed-error-justified": 12 };

/**
 * The source a labeller is shown. Markup collapses to one line, as a report quotes it. Code keeps its own
 * lines, and is a window rather than the span: a code rule's span ends where the words it classifies begin —
 * at the end of a function's name, a test's title — not at the end of the body underneath. The body itself is
 * never missing from the bench, because it is one of the words the model was shown.
 */
function quote(source: string, ruleId: string, span: { start: number; end: number }): string {
  if (!corpus.code) return source.slice(span.start, Math.min(span.end, span.start + MARKUP_SNIPPET_CHARS)).replace(/ data-jev-axe="[^"]*"/g, "").replace(/\s+/g, " ");
  let from = source.lastIndexOf("\n", span.start - 1) + 1;
  for (let lead = CODE_SNIPPET_LEAD[ruleId] ?? 0; lead > 0 && from > 0; lead--) from = source.lastIndexOf("\n", from - 2) + 1;
  const window = source.slice(from).split("\n").slice(0, CODE_SNIPPET_LINES).join("\n");
  return window.length > CODE_SNIPPET_CHARS ? `${window.slice(0, CODE_SNIPPET_CHARS)}\n…` : window;
}

const saved = classifications.map((j, index) => {
  const { span, axe: stamps = [] } = j.candidate.loc;
  const onElement = stamps.map((stamp) => axeOf.get(j.file)![stamp]!).filter((result) => (FORM_CHECKS[j.ruleId] ?? []).includes(result.rule));
  const entry = entryOf.get(j.file)!;
  return {
    id: index,
    rule: j.ruleId,
    page: placeOf(corpus, entry.origin, j.candidate.loc.line),
    kind: entry.kind,
    band: entry.band,
    p: Number(j.p.toFixed(3)),
    severity: j.severity,
    message: j.message,
    hint: j.hint,
    snippet: span ? quote(sources.get(j.file)!, j.ruleId, span) : "",
    checked: j.candidate.data,
    facts: { ...j.candidate.meta, ...(j.candidate.loc.widget && { "third-party widget": j.candidate.loc.widget }) },
    axePassed: onElement.filter((result) => result.outcome === "passed").map((result) => result.rule),
  };
});
writeFileSync(`${values.corpus}/classifications.json`, JSON.stringify(saved));

const histogram = (ps: number[]) => Array.from({ length: 5 }, (_, i) => ps.filter((p) => Math.min(4, Math.floor(p * 5)) === i).length).join(" ");
const unit = corpus.code ? "files" : "pages";
// `page` carries a line number for code, and only for code, so the document it names is everything before it.
const documentOf = (page: string) => (corpus.code ? page.slice(0, page.lastIndexOf(":")) : page);
const rows = rules.map((rule) => {
  const mine = saved.filter((j) => j.rule === rule.id);
  const reported = mine.filter((j) => j.severity !== null);
  return {
    rule: rule.id,
    classified: mine.length,
    error: mine.filter((j) => j.severity === "error").length,
    warn: mine.filter((j) => j.severity === "warn").length,
    review: mine.filter((j) => j.severity === "review").length,
    "% reported": mine.length === 0 ? "" : `${Math.round((reported.length / mine.length) * 100)}%`,
    [`${unit} reported`]: new Set(reported.map((j) => documentOf(j.page))).size,
    "valid but false": reported.filter((j) => j.axePassed.length > 0).length,
    "p: 0-.2 .2-.4 .4-.6 .6-.8 .8-1": histogram(mine.map((j) => j.p)),
  };
});
console.table(rows);
const cost = (stats.inputTokens / 1_000_000) * 0.042;
console.log(
  `${files.length} ${unit}, ${saved.length} classifications, ${findings.length} reported, ${stats.unanswered} unclassified. ${stats.questions} questions, ${stats.cacheHits} cached, ${stats.requests} requests, ${stats.inputTokens.toLocaleString("en")} tokens, $${cost.toFixed(2)}, ${Math.round((Date.now() - started) / 1000)}s`,
);
