// Is the `candidate` wrapper around a one-candidate state worth its indirection? Runs identical input
// through both state shapes: on the fixtures it compares accuracy and the gap between the bad and good
// cases, on real input it counts candidates that change reported/not-reported status. Both shapes are
// asked cold in the same execution, so neither inherits answers the other run cached. A second wrapped
// run comes along as a control: it shows how many flips run-to-run variance alone produces.
// Usage: varlock run -- node scripts/state-shape-experiment.ts
//        varlock run -- node scripts/state-shape-experiment.ts <file|dir|url>... [--axe <report.json>] [--rule <id>]
import { globSync, readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { readAxeReport, type AxeResult } from "../src/axe/report.ts";
import { createAsk } from "../src/engine/client.ts";
import { run, type SourceFile } from "../src/engine/run.ts";
import type { Classification, StateShape } from "../src/engine/types.ts";
import { allRules } from "../src/rules/index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { axe: { type: "string" }, rule: { type: "string", multiple: true } },
});

const rules = values.rule ? allRules.filter((rule) => values.rule!.includes(rule.id)) : allRules;
const ask = createAsk();
const mean = (values: number[]) => (values.reduce((sum, value) => sum + value, 0) / (values.length || 1)).toFixed(2);
const read = (dir: string) => globSync(`${dir}/**/*.{html,ts,js}`).sort().map((path) => ({ path, source: readFileSync(path, "utf8") }));

const SHAPES: StateShape[] = ["wrapped", "flat"];

async function onFixtures(): Promise<void> {
  const rows = [];
  const tokens: Record<string, number> = { wrapped: 0, flat: 0 };
  for (const rule of rules) {
    for (const stateShape of SHAPES) {
      const dir = `fixtures/${rule.target}/${rule.id}`;
      const [bad, good] = await Promise.all(
        ["bad", "good"].map(async (label) => {
          // No cache: a shape that ran before would otherwise report zero tokens.
          const result = await run(read(`${dir}/${label}`), { rules: [rule], ask, isolation: "candidate", stateShape });
          tokens[stateShape] += result.stats.inputTokens;
          return result.classifications;
        }),
      );
      const ps = { bad: bad!.map((j) => j.p), good: good!.map((j) => j.p) };
      rows.push({
        shape: stateShape,
        rule: rule.id,
        recall: `${bad!.filter((j) => j.severity !== null).length}/${bad!.length}`,
        "false positives": `${good!.filter((j) => j.severity !== null).length}/${good!.length}`,
        "mean p (bad)": mean(ps.bad),
        "mean p (good)": mean(ps.good),
        // The smallest distance between a case that must be reported and one that must not.
        gap: (Math.min(...ps.bad) - Math.max(...ps.good)).toFixed(2),
      });
    }
  }
  console.table(rows.toSorted((a, b) => a.rule.localeCompare(b.rule) || a.shape.localeCompare(b.shape)));
  console.log(`input tokens: wrapped ${tokens.wrapped}, flat ${tokens.flat}`);
}

const keyOf = (j: Classification) => `${j.ruleId} ${j.file} ${j.candidate.loc.line}:${j.candidate.loc.col}`;

async function onFiles(files: SourceFile[]): Promise<void> {
  const variants: { name: string; stateShape: StateShape }[] = [
    { name: "wrapped", stateShape: "wrapped" },
    { name: "wrapped (repeat)", stateShape: "wrapped" },
    { name: "flat", stateShape: "flat" },
  ];
  const results = [];
  for (const { name, stateShape } of variants) {
    const { classifications, stats } = await run(files, { rules, ask, isolation: "candidate", stateShape });
    results.push({ name, stats, by: new Map(classifications.map((j) => [keyOf(j), j])) });
  }

  const [baseline] = results;
  const rows = [];
  for (const { name, stats, by } of results) {
    const drift = [...by].map(([key, j]) => Math.abs(j.p - baseline!.by.get(key)!.p));
    const flipped = [...by].filter(([key, j]) => (j.severity === null) !== (baseline!.by.get(key)!.severity === null));
    rows.push({
      variant: name,
      candidates: by.size,
      reported: [...by.values()].filter((j) => j.severity !== null).length,
      requests: stats.requests,
      "input tokens": stats.inputTokens,
      "mean |Δp|": mean(drift),
      "flips vs wrapped": `${flipped.length}/${by.size}`,
    });
    for (const [key, j] of flipped) {
      const was = baseline!.by.get(key)!;
      console.log(`FLIP  ${name}  ${key}  ${was.p.toFixed(2)} ${was.severity} → ${j.p.toFixed(2)} ${j.severity}  ${JSON.stringify(j.candidate.data)}`);
    }
  }
  console.table(rows);
}

if (positionals.length === 0 && !values.axe) {
  await onFixtures();
} else {
  const isUrl = (value: string) => /^https?:\/\//.test(value);
  const axeByUrl = values.axe ? readAxeReport(values.axe) : new Map<string, AxeResult[]>();
  const targets = positionals.length > 0 ? positionals : [...axeByUrl.keys()];
  const paths = targets.flatMap((target) =>
    isUrl(target) || !statSync(target).isDirectory()
      ? [target]
      : globSync(`${target}/**/*.{html,js,mjs,cjs,jsx,ts,mts,cts,tsx}`, { exclude: (name) => name === "node_modules" }).sort(),
  );
  const renderer = paths.some(isUrl) ? await import("../src/html/render.ts") : undefined;
  const files: SourceFile[] = [];
  for (const path of paths) {
    if (!isUrl(path)) {
      files.push({ path, source: readFileSync(path, "utf8") });
      continue;
    }
    const axe = axeByUrl.get(path);
    // Rendered once and reused by every variant, so all three classify the same DOM.
    files.push({ path, source: await renderer!.renderPage(path, axe), ...(axe && { axe }) });
  }
  await renderer?.closeBrowser();
  await onFiles(files);
}
