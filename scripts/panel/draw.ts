// Draws a blind sample for a panel of model labellers (Opus and Fable agents), one round at a time.
// The panel is a faster, cheaper stand-in for the human label bench: it lets a fix be scored on items it
// has not seen within minutes. It does not replace the human labels; `score.ts --human` reports how
// often the panel agrees with them.
//
//   node scripts/panel/draw.ts --round 1 [--corpus corpus-code] [--reported 12] [--unreported 4] [--chunks 3]
//                              [--rule <id>]... [--include-human] [--from classifications.json]
//
// Writes <corpus>/rounds/panel-<round>/sample.json (hidden: probabilities and severities) and
// items-<n>.json (blind: what each labeller reads). Words drawn in an earlier round are never drawn
// again (<corpus>/rounds/panel-seen.json), so every round is unseen by the fixes before it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { allRules } from "../../src/rules/index.ts";
import { claimOf } from "../corpus/claims.ts";
import { wordsOf, type Saved } from "./draw-shared.ts";

const { values } = parseArgs({
  options: {
    corpus: { type: "string", default: "corpus-code" },
    round: { type: "string" },
    reported: { type: "string", default: "12" },
    unreported: { type: "string", default: "4" },
    chunks: { type: "string", default: "3" },
    seed: { type: "string" },
    rule: { type: "string", multiple: true },
    "include-human": { type: "boolean", default: false },
    from: { type: "string", default: "classifications.json" },
  },
});
if (!values.round) throw new Error("--round is required");

let state = Number(values.seed ?? values.round) * 7919;
const next = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffled = <T>(items: T[]): T[] => items.map((item) => [next(), item] as const).sort(([a], [b]) => a - b).map(([, item]) => item);

const repoOf = (j: Saved) => j.page.split(": ")[0]!;

/** One item per repository in turn, so a house style cannot fill a rule's sample. */
function acrossRepos(items: Saved[]): Saved[] {
  const queues = [...Map.groupBy(items, repoOf).values()];
  const out: Saved[] = [];
  while (queues.some((queue) => queue.length > 0)) for (const queue of queues) if (queue.length > 0) out.push(queue.shift()!);
  return out;
}

const all: Saved[] = JSON.parse(readFileSync(`${values.corpus}/${values.from}`, "utf8"));
const seenFile = `${values.corpus}/rounds/panel-seen.json`;
const seen = new Set<string>(existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, "utf8")) : []);
const rules = allRules.filter((rule) => (values.rule ? values.rule.includes(rule.id) : all.some((j) => j.rule === rule.id)));

const sample: Saved[] = [];
for (const rule of rules) {
  const words = new Set<string>();
  const distinct = shuffled(all.filter((j) => j.rule === rule.id)).filter((j) => {
    const key = wordsOf(j);
    return seen.has(key) || words.has(key) ? false : (words.add(key), true);
  });
  const reported = distinct.filter((j) => j.severity !== null);
  const unreported = distinct.filter((j) => j.severity === null);
  // Errors and warnings first: they are what a developer is interrupted by, so they get most of the sample.
  const bySeverity = ["error", "warn", "review"].map((severity) => acrossRepos(reported.filter((j) => j.severity === severity)));
  const want = Number(values.reported);
  const taken: Saved[] = [...bySeverity[0]!.splice(0, Math.ceil(want / 2)), ...bySeverity[1]!.splice(0, Math.ceil(want / 4))];
  while (taken.length < want && bySeverity.some((group) => group.length > 0)) {
    for (const group of bySeverity) if (group.length > 0 && taken.length < want) taken.push(group.shift()!);
  }
  const near = acrossRepos(unreported.toSorted((a, b) => b.p - a.p)).slice(0, Math.ceil(Number(values.unreported) / 2));
  const random = acrossRepos(unreported.filter((j) => !near.includes(j))).slice(0, Number(values.unreported) - near.length);
  sample.push(...taken, ...near, ...random);
}

// The items a human has labelled, so the panel can be compared with him on the very same words.
if (values["include-human"]) {
  const dir = `${values.corpus}/labels/labels`;
  const human: Saved[] = JSON.parse(readFileSync(`${values.corpus}/label-sample.json`, "utf8"));
  const labelled = new Set(readdirSync(dir).map((file) => file.replace(".json", "")));
  for (const j of human) if (labelled.has(`j${j.id}`)) sample.push({ ...j, id: -j.id });
}

const dir = `${values.corpus}/rounds/panel-${values.round}`;
mkdirSync(dir, { recursive: true });
const ordered = shuffled(sample);
writeFileSync(`${dir}/sample.json`, JSON.stringify(ordered, null, 1));
writeFileSync(seenFile, JSON.stringify([...seen, ...ordered.map(wordsOf)]));

const description = new Map(allRules.map((rule) => [rule.id, rule.description]));
const items = ordered.map((j) => {
  const [repo, rest] = j.page.split(": ") as [string, string];
  const line = Number(rest.slice(rest.lastIndexOf(":") + 1));
  return {
    id: j.id < 0 ? `h${-j.id}` : `p${j.id}`,
    rule: j.rule,
    ruleDescription: description.get(j.rule),
    claim: claimOf(j),
    file: `${values.corpus}/snapshots/${repo.replace("/", "__")}/${rest.slice(0, rest.lastIndexOf(":"))}`,
    line,
    snippet: j.snippet,
    checked: j.checked,
    facts: j.facts,
  };
});
const chunks = Number(values.chunks);
for (let n = 0; n < chunks; n++) writeFileSync(`${dir}/items-${n}.json`, JSON.stringify(items.filter((_, i) => i % chunks === n), null, 1));

console.table(
  rules.map((rule) => {
    const mine = ordered.filter((j) => j.rule === rule.id);
    const count = (severity: string | null) => mine.filter((j) => j.severity === severity).length;
    return { rule: rule.id, error: count("error"), warn: count("warn"), review: count("review"), unreported: count(null), repos: new Set(mine.map(repoOf)).size };
  }),
);
console.log(`${ordered.length} items in ${chunks} chunks → ${dir}`);
