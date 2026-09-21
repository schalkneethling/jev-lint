// Where should a truncation limit sit? Jev takes 64k tokens a request and 32k of state, and every
// limit in src/rules/limits.ts was chosen for thrift rather than measured. This runs the same
// labelled input at several values of one limit, cold, in one execution, and repeats the current
// value as the control for the ±0.03 of run-to-run variance in §6 of the findings.
//
// The limit is injected through src/rules/limits.ts, which the rules read at select time, so no rule
// is forked or copied here and a normal run keeps the defaults exactly.
//
//   node scripts/truncation-experiment.ts --facts [dir]...
//       No model. How often each limit actually bites: function, test, comment and try-block sizes in
//       the given directories, and the word counts behind every HTML limit across the corpus.
//
//   varlock run -- node scripts/truncation-experiment.ts --limit <name> [--rule <id>] [--values a,b,none]
//       The labelled long fixtures under fixtures/<target>-long/<rule-id>/{bad,good}.
//
//   varlock run -- node scripts/truncation-experiment.ts --limit <name> --rule <id> <dir>...
//       Real input: how many candidates exceed each value, and how many change reported status.
//
//   varlock run -- node scripts/truncation-experiment.ts --limit hiddenTextWords --labels
//       The blind-labelled corpus classifications for the rule, re-classified at each value.
import { existsSync, globSync, readFileSync, readdirSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseCode } from "../src/code/parse.ts";
import { createAsk } from "../src/engine/client.ts";
import { run, type SourceFile } from "../src/engine/run.ts";
import type { AnyRule, Classification } from "../src/engine/types.ts";
import { parseHtml } from "../src/html/parse.ts";
import { allRules } from "../src/rules/index.ts";
import { limits, withLimit, type LimitName } from "../src/rules/limits.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    facts: { type: "boolean", default: false },
    limit: { type: "string" },
    rule: { type: "string" },
    values: { type: "string" },
    labels: { type: "boolean", default: false },
    corpus: { type: "string", default: "corpus" },
  },
});

const mean = (numbers: number[]) => numbers.reduce((sum, value) => sum + value, 0) / (numbers.length || 1);
const read = (dir: string) => globSync(`${dir}/**/*.{html,ts,js,tsx,jsx,mjs,cjs}`, { exclude: (name) => name === "node_modules" }).sort();
const words = (value: string) => value.split(/\s+/).filter(Boolean).length;
/** Share of `sizes` above each cut, as "12/301 (4%)". */
const over = (sizes: number[], cut: number) => {
  const n = sizes.filter((size) => size > cut).length;
  return `${n}/${sizes.length} (${sizes.length === 0 ? 0 : Math.round((n / sizes.length) * 100)}%)`;
};
const percentile = (sizes: number[], fraction: number) => (sizes.length === 0 ? 0 : sizes.toSorted((a, b) => a - b)[Math.min(sizes.length - 1, Math.floor(sizes.length * fraction))]!);

// ---------------------------------------------------------------- no model at all

async function facts(): Promise<void> {
  const dirs = positionals.length > 0 ? positionals : ["src", "scripts", "test"];
  const codeRows = [];
  for (const dir of dirs) {
    const sizes = { function: [] as number[], test: [] as number[], "comment's statement": [] as number[], "try block": [] as number[] };
    for (const path of read(dir).filter((path) => /\.(ts|js|tsx|jsx|mjs|cjs)$/.test(path))) {
      const doc = await parseCode(path, readFileSync(path, "utf8"));
      sizes.function.push(...doc.functions.map((fn) => fn.body.length));
      sizes.test.push(...doc.tests.map((test) => test.body.length));
      sizes["comment's statement"].push(...doc.comments.map((comment) => comment.code.length));
      sizes["try block"].push(...doc.emptyCatches.map((handler) => handler.tried.length));
    }
    for (const [kind, all] of Object.entries(sizes)) {
      codeRows.push({
        input: dir,
        kind,
        n: all.length,
        median: percentile(all, 0.5),
        p90: percentile(all, 0.9),
        max: Math.max(0, ...all),
        "over 1500": over(all, 1500),
        "over 3000": over(all, 3000),
        "over 6000": over(all, 6000),
      });
    }
  }
  console.log("Characters of code, against the 1,500 character `clip` limit:");
  console.table(codeRows);

  if (!existsSync(`${values.corpus}/manifest.json`)) return console.log(`No corpus at ${values.corpus}; skipping the HTML limits.`);
  const manifest: { pages: { file: string }[] } = JSON.parse(readFileSync(`${values.corpus}/manifest.json`, "utf8"));
  const pages = manifest.pages.filter((page) => existsSync(page.file));

  // Select with the limits off, so what is measured is the untruncated text each rule would send.
  const field: Record<string, { rule: string; key: string; limit: number }> = {
    hiddenTextWords: { rule: "aria-hidden-hides-content", key: "hidden_text", limit: limits.hiddenTextWords },
    alertMessageWords: { rule: "alert-is-urgent", key: "message", limit: limits.alertMessageWords },
    fieldDescriptionWords: { rule: "describedby-describes", key: "description_announced_after_label", limit: limits.fieldDescriptionWords },
    pageContentWords: { rule: "description-matches-page", key: "start_of_page_content", limit: limits.pageContentWords },
  };
  const counts = new Map<string, number[]>(Object.keys(field).map((name) => [name, []]));
  for (const name of Object.keys(field) as LimitName[]) limits[name] = Infinity;
  for (const page of pages) {
    const doc = parseHtml(page.file, readFileSync(page.file, "utf8"));
    for (const [name, { rule, key }] of Object.entries(field)) {
      const target = allRules.find((candidate) => candidate.id === rule)!;
      for (const candidate of target.select(doc)) counts.get(name)!.push(words(String(candidate.data[key] ?? "")));
    }
  }
  console.log(`\nWords of text per candidate over ${pages.length} corpus pages, against each rule's limit:`);
  console.table(
    Object.entries(field).map(([name, { rule, limit }]) => {
      const all = counts.get(name)!;
      return {
        limit: name,
        rule,
        value: limit,
        candidates: all.length,
        median: percentile(all, 0.5),
        p90: percentile(all, 0.9),
        max: Math.max(0, ...all),
        "over the limit": over(all, limit),
        "over 2x": over(all, limit * 2),
      };
    }),
  );
}

// ---------------------------------------------------------------- the variants of one limit

const NO_LIMIT = Infinity;
const label = (value: number) => (value === NO_LIMIT ? "none" : String(value));

function variantsOf(limit: LimitName): { name: string; value: number }[] {
  const current = limits[limit];
  const chosen = values.values
    ? values.values.split(",").map((text) => (text.trim() === "none" ? NO_LIMIT : Number(text)))
    : [current, current * 2, current * 4, current * 8, NO_LIMIT];
  // The control is the current value asked a second time, cold: everything below that size is noise.
  return [
    { name: `${label(chosen[0]!)} (current)`, value: chosen[0]! },
    { name: `${label(chosen[0]!)} again (control)`, value: chosen[0]! },
    ...chosen.slice(1).map((value) => ({ name: label(value), value })),
  ];
}

const ruleFor = (limit: LimitName): AnyRule => {
  const byLimit: Partial<Record<LimitName, string>> = {
    hiddenTextWords: "aria-hidden-hides-content",
    alertMessageWords: "alert-is-urgent",
    fieldDescriptionWords: "describedby-describes",
    pageContentWords: "description-matches-page",
  };
  const id = values.rule ?? byLimit[limit];
  if (!id) throw new Error(`--limit ${limit} covers several rules; name one with --rule.`);
  const rule = allRules.find((candidate) => candidate.id === id);
  if (!rule) throw new Error(`No rule ${id}.`);
  return rule;
};

/** Reported or not, per candidate, so two runs can be compared without depending on classification order. */
const statusOf = (classifications: Classification[]) => new Map(classifications.map((j) => [`${j.file}:${j.candidate.loc.line}:${j.candidate.loc.col}`, j]));
const flips = (before: Map<string, Classification>, after: Map<string, Classification>) =>
  [...before].filter(([key, j]) => (j.severity === null) !== ((after.get(key)?.severity ?? null) === null)).map(([key]) => key);

// ---------------------------------------------------------------- the long labelled fixtures

async function onFixtures(limit: LimitName, rule: AnyRule): Promise<void> {
  const dir = `fixtures/${rule.target}-long/${rule.id}`;
  if (!existsSync(dir)) throw new Error(`No long fixtures at ${dir}.`);
  const ask = createAsk();
  const files = Object.fromEntries(["bad", "good"].map((side) => [side, read(`${dir}/${side}`).map((path) => ({ path, source: readFileSync(path, "utf8") }))]));

  const rows = [];
  let current: Map<string, Classification> | undefined;
  for (const variant of variantsOf(limit)) {
    // No cache is passed, so every variant is a cold run and pays for its own tokens.
    const { bad, good, tokens } = await withLimit(limit, variant.value, async () => {
      let tokens = 0;
      const sides = await Promise.all(
        ["bad", "good"].map(async (side) => {
          const result = await run(files[side]!, { rules: [rule], ask, isolation: "candidate" });
          tokens += result.stats.inputTokens;
          return result.classifications;
        }),
      );
      return { bad: sides[0]!, good: sides[1]!, tokens };
    });
    const status = statusOf([...bad, ...good]);
    current ??= status;
    const reported = (classifications: Classification[]) => classifications.filter((j) => j.severity !== null).length;
    rows.push({
      [limit]: variant.name,
      recall: `${reported(bad)}/${bad.length}`,
      "false +": `${reported(good)}/${good.length}`,
      "mean bad": mean(bad.map((j) => j.p)).toFixed(2),
      "mean good": mean(good.map((j) => j.p)).toFixed(2),
      gap: (Math.min(...bad.map((j) => j.p)) - Math.max(...good.map((j) => j.p))).toFixed(2),
      "status changes": flips(current, status).length,
      tokens,
    });
  }
  console.log(`${rule.id}, ${limit}, on ${dir}:`);
  console.table(rows);
}

// ---------------------------------------------------------------- real input

async function onRealInput(limit: LimitName, rule: AnyRule): Promise<void> {
  const ask = createAsk();
  const paths = positionals
    .flatMap((target) => (statSync(target).isDirectory() ? read(target) : [target]))
    // A code rule reads no HTML, and parseCode has no grammar for it.
    .filter((path) => (rule.target === "code") === /\.(ts|js|tsx|jsx|mjs|cjs)$/.test(path));
  const files: SourceFile[] = paths.map((path) => ({ path, source: readFileSync(path, "utf8") }));

  // How many candidates the limit actually reaches, measured once with the limit off.
  const untruncated = await withLimit(limit, NO_LIMIT, async () =>
    (await Promise.all(files.map(async (file) => rule.select(rule.target === "code" ? await parseCode(file.path, file.source) : (parseHtml(file.path, file.source) as never)))))
      .flat()
      .map((candidate) => Math.max(...Object.values(candidate.data).map((value) => (typeof value === "string" ? (limit === "codeChars" ? value.length : words(value)) : 0)))),
  );

  const rows = [];
  let current: Map<string, Classification> | undefined;
  for (const variant of variantsOf(limit)) {
    const result = await withLimit(limit, variant.value, () => run(files, { rules: [rule], ask, isolation: "candidate", concurrency: 8 }));
    const status = statusOf(result.classifications);
    current ??= status;
    const changed = flips(current, status);
    rows.push({
      [limit]: variant.name,
      candidates: result.classifications.length,
      "over this value": untruncated ? over(untruncated, variant.value) : "n/a",
      reported: result.classifications.filter((j) => j.severity !== null).length,
      "mean p": mean(result.classifications.map((j) => j.p)).toFixed(3),
      "status changes": changed.length,
      tokens: result.stats.inputTokens,
    });
    for (const key of changed) {
      const before = current.get(key)!;
      const after = status.get(key)!;
      console.log(`  ${before.severity === null ? "NEW    " : "DROPPED"} at ${variant.name}: ${key} ${before.p.toFixed(2)} -> ${after.p.toFixed(2)}  ${JSON.stringify(after.candidate.data).slice(0, 110)}`);
    }
  }
  console.log(`${rule.id}, ${limit}, on ${positionals.join(" ")} (${files.length} files):`);
  console.table(rows);
}

// ---------------------------------------------------------------- the blind-labelled corpus items

interface Drawn {
  id: number;
  rule: string;
  page: string;
  p: number;
  severity: string | null;
  checked: Record<string, unknown>;
}

async function onLabels(limit: LimitName, rule: AnyRule): Promise<void> {
  const drawn: Drawn[] = JSON.parse(readFileSync(`${values.corpus}/label-sample.json`, "utf8")).filter((j: Drawn) => j.rule === rule.id);
  const dir = `${values.corpus}/labels/labels`;
  const labels = new Map(readdirSync(dir).map((file) => [file.replace(".json", ""), (JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as { label: string }).label]));
  const manifest: { pages: { file: string; url: string }[] } = JSON.parse(readFileSync(`${values.corpus}/manifest.json`, "utf8"));
  const fileOf = new Map(manifest.pages.map((page) => [page.url, page.file]));

  const ask = createAsk();
  // The labelled item names its page and the words that were classified; the same element is found again
  // at any limit because one of the two texts is always a prefix of the other.
  const anchor = (candidate: { data: Record<string, unknown> }, item: Drawn) =>
    Object.keys(item.checked).every((key) => {
      const [a, b] = [String(item.checked[key] ?? ""), String(candidate.data[key] ?? "")].map((text) => text.replace(/ …$/, ""));
      return a.startsWith(b) || b.startsWith(a);
    });

  const rows = [];
  const track = new Map<number, string[]>();
  for (const variant of variantsOf(limit)) {
    const classified = await withLimit(limit, variant.value, async () => {
      const files: SourceFile[] = [];
      const wanted = new Map<string, Drawn[]>();
      for (const item of drawn) {
        const file = fileOf.get(item.page);
        if (!file || !existsSync(file)) continue;
        wanted.set(file, [...(wanted.get(file) ?? []), item]);
      }
      for (const file of wanted.keys()) files.push({ path: file, source: readFileSync(file, "utf8") });
      const { classifications } = await run(files, { rules: [rule], ask, isolation: "candidate", concurrency: 6 });
      return drawn.map((item) => {
        const onPage = classifications.filter((j) => j.file === fileOf.get(item.page));
        // An exact match first: two headings on one page where one name starts with the other would
        // otherwise be told apart by a prefix test that cannot tell them apart.
        return onPage.find((j) => Object.keys(item.checked).every((key) => String(item.checked[key] ?? "") === String(j.candidate.data[key] ?? ""))) ?? onPage.find((j) => anchor(j.candidate, item));
      });
    });
    for (const [index, item] of drawn.entries()) {
      track.set(item.id, [...(track.get(item.id) ?? []), classified[index] ? classified[index]!.p.toFixed(2) : "—"]);
    }
    const decided = drawn.map((item, index) => ({ given: labels.get(`j${item.id}`), j: classified[index] })).filter((entry) => entry.given === "yes" || entry.given === "no");
    const trueOnes = decided.filter((entry) => entry.given === "yes");
    const falseOnes = decided.filter((entry) => entry.given === "no");
    rows.push({
      [limit]: variant.name,
      found: `${classified.filter(Boolean).length}/${drawn.length}`,
      "mean p, labelled true": mean(trueOnes.map((entry) => entry.j?.p ?? 0)).toFixed(2),
      "mean p, labelled false": mean(falseOnes.map((entry) => entry.j?.p ?? 0)).toFixed(2),
      "reported, true": `${trueOnes.filter((entry) => entry.j?.severity).length}/${trueOnes.length}`,
      "reported, false": `${falseOnes.filter((entry) => entry.j?.severity).length}/${falseOnes.length}`,
      gap: (Math.min(...trueOnes.map((entry) => entry.j?.p ?? 0)) - Math.max(...falseOnes.map((entry) => entry.j?.p ?? 0))).toFixed(2),
    });
  }
  console.log(`${rule.id}, ${limit}, on ${drawn.length} blind-labelled items from ${values.corpus}:`);
  console.table(rows);
  console.table(
    drawn.map((item) => ({
      id: item.id,
      label: labels.get(`j${item.id}`) ?? "—",
      item: String(item.checked.heading ?? Object.values(item.checked)[0] ?? "").slice(0, 34),
      "words classified when labelled": Math.max(...Object.values(item.checked).map((value) => (typeof value === "string" ? words(value) : 0))),
      "p per variant": track.get(item.id)!.join("  "),
    })),
  );
}

// ----------------------------------------------------------------

if (values.facts) {
  await facts();
} else {
  const limit = values.limit as LimitName | undefined;
  if (!limit || !(limit in limits)) throw new Error(`--limit must be one of ${Object.keys(limits).join(", ")}.`);
  const rule = ruleFor(limit);
  if (values.labels) await onLabels(limit, rule);
  else if (positionals.length > 0) await onRealInput(limit, rule);
  else await onFixtures(limit, rule);
}
