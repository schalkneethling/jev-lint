#!/usr/bin/env node
import { globSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readAxeReport, type AxeResult } from "./axe/report.ts";
import { AnswerCache } from "./engine/cache.ts";
import { createAsk } from "./engine/client.ts";
import { run, type SourceFile } from "./engine/run.ts";
import type { Isolation } from "./engine/types.ts";
import { html } from "./report/html.ts";
import { json } from "./report/json.ts";
import { stylish } from "./report/stylish.ts";
import { allRules } from "./rules/index.ts";

const ISOLATIONS: Isolation[] = ["candidate", "rule", "file"];
const SOURCE_FILES = "**/*.{html,js,mjs,cjs,jsx,ts,mts,cts,tsx}";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    axe: { type: "string" },
    isolation: { type: "string", default: "candidate" },
    rule: { type: "string", multiple: true },
    format: { type: "string", default: "stylish" },
    output: { type: "string" },
    evidence: { type: "boolean", default: false },
    "no-cache": { type: "boolean", default: false },
    "cache-only": { type: "boolean", default: false },
  },
});

if ((positionals.length === 0 && !values.axe) || !ISOLATIONS.includes(values.isolation as Isolation)) {
  console.error(
    [
      "Usage: jev-lint <file|dir|url>... [options]",
      "       jev-lint --axe <full-report.json>    lint every page in an axe-aggregate-reporter report and join the results",
      "",
      "  --rule <id>          run only this rule (repeatable)",
      "  --format <name>      stylish (default), json, html, or html-fragment (page content only, for hosts with their own shell)",
      "  --output <file>      write the report to a file instead of stdout",
      "  --evidence           stylish: show Jev's measurements and code's facts under each finding",
      "  --isolation <mode>   candidate (default), rule, or file",
      "  --no-cache           ask Jev again even for unchanged input",
      "  --cache-only         never call Jev; judge only what the cache can answer (needs no API key)",
    ].join("\n"),
  );
  process.exit(2);
}

const isUrl = (value: string) => /^https?:\/\//.test(value);
const axeByUrl = values.axe ? readAxeReport(values.axe) : new Map<string, AxeResult[]>();
const targets = positionals.length > 0 ? positionals : [...axeByUrl.keys()];

const paths = targets.flatMap((target) =>
  isUrl(target) || !statSync(target).isDirectory()
    ? [target]
    : globSync(`${target}/${SOURCE_FILES}`, { exclude: (name) => name === "node_modules" }).sort(),
);

const urls = paths.filter(isUrl);
// Playwright is only loaded when a page has to be rendered.
const renderer = urls.length > 0 ? await import("./html/render.ts") : undefined;
const files: SourceFile[] = [];
for (const path of paths) {
  if (!isUrl(path)) {
    // A saved snapshot was stamped when it was fetched, so its axe results join the same way a live page's do.
    const stamped = axeByUrl.get(path);
    files.push({ path, source: readFileSync(path, "utf8"), ...(stamped && { axe: stamped }) });
    continue;
  }
  const axe = axeByUrl.get(path);
  files.push({ path, source: await renderer!.renderPage(path, axe), ...(axe && { axe }) });
}
await renderer?.closeBrowser();

const rules = values.rule ? allRules.filter((rule) => values.rule!.includes(rule.id)) : allRules;
const { findings, judgements, stats } = await run(files, {
  rules,
  // Without credentials the client cannot even be built, and cache-only mode never uses it.
  ask: values["cache-only"] ? async () => Promise.reject(new Error("cache-only")) : createAsk(),
  cacheOnly: values["cache-only"],
  isolation: values.isolation as Isolation,
  cache: values["no-cache"] ? undefined : new AnswerCache(".jev-lint-cache"),
});

const judged = new Map<string, number>();
for (const j of judgements) judged.set(j.ruleId, (judged.get(j.ruleId) ?? 0) + 1);

const report =
  values.format === "json"
    ? json(findings, stats)
    : values.format === "html" || values.format === "html-fragment"
      ? html(findings, stats, { targets, judged, withAxe: values.axe !== undefined, standalone: values.format === "html" })
      : stylish(findings, stats, { evidence: values.evidence });

if (values.output) {
  writeFileSync(values.output, report);
  console.error(`Wrote ${values.output}`);
} else {
  console.log(report);
}
process.exitCode = findings.some((f) => f.severity === "error") ? 1 : 0;
