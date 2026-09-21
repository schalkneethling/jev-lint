// Do a Noul's criteria earn their tokens? TypeSafe's docs say the instruction is enough for most Noul
// questions and criteria are for a subtle boundary between yes and no. This removes the criteria from
// one Noul at a time and compares each rule on its fixtures, then removes them all and counts how many
// real candidates change reported/not-reported status. A repeat of the unchanged rules is the control
// for run-to-run variance. Choice criteria are the options themselves and are left alone.
// Usage: varlock run -- node scripts/criteria-experiment.ts
//        varlock run -- node scripts/criteria-experiment.ts <file|dir|url>... [--axe <report.json>] [--rule <id>] [--without <question>]...
import { globSync, readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { readAxeReport, type AxeResult } from "../src/axe/report.ts";
import { createAsk } from "../src/engine/client.ts";
import { run, type SourceFile } from "../src/engine/run.ts";
import type { AnyRule, Classification, RuleQuestions } from "../src/engine/types.ts";
import { allRules } from "../src/rules/index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { axe: { type: "string" }, rule: { type: "string", multiple: true }, without: { type: "string", multiple: true } },
});

const rules = values.rule ? allRules.filter((rule) => values.rule!.includes(rule.id)) : allRules;
const ask = createAsk();
const read = (dir: string) => globSync(`${dir}/**/*.{html,ts,js}`).sort().map((path) => ({ path, source: readFileSync(path, "utf8") }));
const mean = (ps: number[]) => ps.reduce((sum, p) => sum + p, 0) / (ps.length || 1);

/** The same rule, with the criteria removed from the named Noul, or from every Noul. */
function without(rule: AnyRule, only?: string | string[]): AnyRule {
  return {
    ...rule,
    questions: (ref, candidate) => {
      const questions: RuleQuestions = rule.questions(ref, candidate);
      return Object.fromEntries(
        Object.entries(questions).map(([name, question]) =>
          question?.type === "noul" && (only === undefined || [only].flat().includes(name)) ? [name, { type: "noul", instructions: question.instructions }] : [name, question],
        ),
      );
    },
  };
}

async function fixtures(rule: AnyRule) {
  let tokens = 0;
  const [bad, good] = await Promise.all(
    ["bad", "good"].map(async (label) => {
      // No cache, so every variant pays for and reports its own tokens.
      const result = await run(read(`fixtures/${rule.target}/${rule.id}/${label}`), { rules: [rule], ask, isolation: "candidate" });
      tokens += result.stats.inputTokens;
      return result.classifications;
    }),
  );
  const flagged = (js: Classification[]) => js.filter((j) => j.severity !== null).length;
  return {
    recall: `${flagged(bad!)}/${bad!.length}`,
    "false +": `${flagged(good!)}/${good!.length}`,
    "mean bad": mean(bad!.map((j) => j.p)).toFixed(2),
    "mean good": mean(good!.map((j) => j.p)).toFixed(2),
    gap: (Math.min(...bad!.map((j) => j.p)) - Math.max(...good!.map((j) => j.p))).toFixed(2),
    tokens,
  };
}

async function onFixtures(): Promise<void> {
  const rows = [];
  for (const rule of rules) {
    // Ask the rule what it would send, to learn which of its questions are Nouls with criteria.
    const sample = rule.questions((field) => `\`${field}\``, { loc: { line: 1, col: 1 }, data: { caption_shown_with_image: "x", heading_above_link: "x" }, meta: { destinations_sharing_this_text: "1", controls_with_same_visible_text: "1" } });
    const nouls = Object.entries(sample as RuleQuestions).filter(([, q]) => q?.type === "noul" && q.criteria).map(([name]) => name);
    if (nouls.length === 0) continue;
    rows.push({ rule: rule.id, criteria: "all kept", ...(await fixtures(rule)) });
    for (const name of nouls) rows.push({ rule: "", criteria: `without ${name}`, ...(await fixtures(without(rule, name))) });
  }
  console.table(rows);
}

async function onRealInput(): Promise<void> {
  const isUrl = (value: string) => /^https?:\/\//.test(value);
  const axeByUrl = values.axe ? readAxeReport(values.axe) : new Map<string, AxeResult[]>();
  const targets = positionals.length > 0 ? positionals : [...axeByUrl.keys()];
  const paths = targets.flatMap((t) => (isUrl(t) || !statSync(t).isDirectory() ? [t] : globSync(`${t}/**/*.{html,js,ts}`, { exclude: (n) => n === "node_modules" }).sort()));
  const renderer = paths.some(isUrl) ? await import("../src/html/render.ts") : undefined;
  const files: SourceFile[] = [];
  for (const path of paths) files.push({ path, source: isUrl(path) ? await renderer!.renderPage(path, axeByUrl.get(path)) : readFileSync(path, "utf8") });
  await renderer?.closeBrowser();

  const kept = await run(files, { rules, ask, isolation: "candidate" });
  const control = await run(files, { rules, ask, isolation: "candidate" });
  const stripped = await run(files, { rules: rules.map((rule) => without(rule, values.without)), ask, isolation: "candidate" });
  const flips = (other: Classification[]) => kept.classifications.filter((j, i) => (j.severity === null) !== (other[i]!.severity === null));
  console.table([
    { variant: "criteria kept", reported: kept.classifications.filter((j) => j.severity).length, flips: "", tokens: kept.stats.inputTokens },
    { variant: "kept again (control)", reported: control.classifications.filter((j) => j.severity).length, flips: flips(control.classifications).length, tokens: control.stats.inputTokens },
    { variant: values.without ? `without ${values.without.join(", ")}` : "no Noul criteria", reported: stripped.classifications.filter((j) => j.severity).length, flips: flips(stripped.classifications).length, tokens: stripped.stats.inputTokens },
  ]);
  for (const j of flips(stripped.classifications)) {
    const after = stripped.classifications[kept.classifications.indexOf(j)]!;
    console.log(`${j.severity === null ? "NEW    " : "DROPPED"} ${j.ruleId} ${j.p.toFixed(2)} -> ${after.p.toFixed(2)}  ${JSON.stringify(j.candidate.data).slice(0, 150)}`);
  }
}

await (positionals.length > 0 || values.axe ? onRealInput() : onFixtures());
