#!/usr/bin/env node
import { existsSync, globSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { matchesGlob as globMatches } from "node:path";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readAxeReport, type AxeResult } from "./axe/report.ts";
import { configureRules, loadConfig, widen } from "./config.ts";
import { readBaseline, rootOf, writeBaseline } from "./engine/baseline.ts";
import { AnswerCache, JsonStore } from "./engine/cache.ts";
import { changedSince, type LineRanges } from "./engine/changed.ts";
import { createClaudeReader } from "./engine/claude.ts";
import { createAsk } from "./engine/client.ts";
import { run, type SourceFile } from "./engine/run.ts";
import type { Isolation } from "./engine/types.ts";
import { verify, type VerifyResult } from "./engine/verify.ts";
import { github } from "./report/github.ts";
import { html } from "./report/html.ts";
import { json } from "./report/json.ts";
import { stylish } from "./report/stylish.ts";
import { allRules } from "./rules/index.ts";

const ISOLATIONS: Isolation[] = ["candidate", "rule", "file"];
const SOURCE_FILES = "**/*.{html,js,mjs,cjs,jsx,ts,mts,cts,tsx}";
// Directories whose contents nobody in the project wrote by hand, and jev-lint's own cache.
// Copies of other people's libraries are here too: three blind panels called every report on vendored code
// true and not worth raising, because nobody in the project will edit it (findings §32).
const NOT_SOURCE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "vendors",
  "third_party",
  "third-party",
  "bower_components",
  "jspm_packages",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".jev-lint-cache",
]);
const GENERATED = /\.(min|bundle)\.[cm]?js$|\.d\.[cm]?ts$/;

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
    changed: { type: "boolean", default: false },
    since: { type: "string" },
    config: { type: "string" },
    experimental: { type: "boolean", default: false },
    "min-probability": { type: "string" },
    baseline: { type: "string" },
    "write-baseline": { type: "string" },
    verify: { type: "boolean", default: false },
    "verify-model": { type: "string" },
  },
});

if ((positionals.length === 0 && !values.axe) || !ISOLATIONS.includes(values.isolation as Isolation)) {
  console.error(
    [
      "Usage: jev-lint <file|dir|url>... [options]",
      "       jev-lint --axe <full-report.json>    lint every page in an axe-aggregate-reporter report and join the results",
      "",
      "  --rule <id>          run only this rule (repeatable)",
      "  --format <name>      stylish (default), json, github (annotations for a GitHub Actions job), html, or html-fragment",
      "  --output <file>      write the report to a file instead of stdout",
      "  --evidence           stylish: show Jev's measurements and code's facts under each finding",
      "  --isolation <mode>   candidate (default), rule, or file",
      "  --changed            classify only what overlaps uncommitted changes (and untracked files)",
      "  --since <ref>        classify only what changed since the branch left <ref>, as a pull request shows it",
      "  --baseline <file>    leave out findings this baseline file already records",
      "  --write-baseline <file>  record every current finding as the baseline, then exit 0",
      "  --experimental       also run the opt-in rules: those a blind panel called right less than half the time",
      "  --min-probability <p>  also report, for review, everything at this probability or above: a longer list for a second reader to confirm",
      "  --verify             have a second reader open each reported file and keep only the findings it confirms; runs Claude Code (`claude`), which must be installed and signed in",
      "  --verify-model <name>  the same, with the reader you name: sonnet (what --verify uses) or haiku, which scored as well for far less",
      "  --config <file>      config file; by default jev-lint.config.ts (or .mts, .mjs, .js) in the first directory given",
      "  --no-cache           ask Jev again even for unchanged input",
      "  --cache-only         never call Jev; classify only what the cache can answer (needs no API key)",
    ].join("\n"),
  );
  process.exit(2);
}

// A baseline is the whole project's findings. Written from a run that looked at part of it, it would drop
// the rest, and the next full run would report every dropped finding as new.
const partial = (["changed", "since", "rule", "cache-only"] as const).filter((flag) => values[flag] !== undefined && values[flag] !== false);
if (values["write-baseline"] && partial.length > 0) {
  console.error(`--write-baseline records every finding of a full run, so it cannot be combined with --${partial.join(", --")}.`);
  process.exit(2);
}

if (values["no-cache"] && values["cache-only"]) {
  console.error("--no-cache never reads the cache and --cache-only reads nothing else, so together they classify almost nothing.");
  process.exit(2);
}

const isUrl = (value: string) => /^https?:\/\//.test(value);
const axeByUrl = values.axe ? readAxeReport(values.axe) : new Map<string, AxeResult[]>();
const targets = positionals.length > 0 ? positionals : [...axeByUrl.keys()];
const absent = targets.filter((target) => !isUrl(target) && !existsSync(target));
if (absent.length > 0) {
  console.error(`No such file or directory: ${absent.join(", ")}`);
  process.exit(2);
}

// The project being linted is the first directory given, which need not be where jev-lint runs from. Its
// config and its ignore globs are read from there. Changed lines are read per directory given (below).
const isDirectory = (target: string) => !isUrl(target) && statSync(target).isDirectory();
const projectDir = targets.find(isDirectory) ?? ".";
const config = await loadConfig(projectDir, values.config);
const ignored = (path: string) => (config.ignore ?? []).some((pattern) => globMatches(relative(projectDir, path), pattern));

const paths = targets.flatMap((target) =>
  !isDirectory(target)
    ? [target]
    : globSync(`${target}/${SOURCE_FILES}`, { exclude: (name) => NOT_SOURCE.has(name) })
        // A directory can be named like a source file ("chart.js/"), and the glob matches it by name.
        .filter((path) => !GENERATED.test(path) && !ignored(path) && statSync(path).isFile())
        .sort(),
);

// Keyed by the paths as given on the command line, which is how files are named everywhere else.
let changed: Map<string, LineRanges> | undefined;
if (values.changed || values.since) {
  changed = new Map();
  const byRoot = new Map<string, Map<string, LineRanges>>();
  for (const path of paths.filter((path) => !isUrl(path))) {
    const root = targets.find((target) => isDirectory(target) && resolve(path).startsWith(`${resolve(target)}/`)) ?? dirname(path);
    if (!byRoot.has(root)) byRoot.set(root, changedSince(values.since ?? "HEAD", root));
    const ranges = byRoot.get(root)!.get(resolve(path));
    if (ranges) changed.set(path, ranges);
  }
}

const urls = paths.filter(isUrl);
// Playwright is only loaded when a page has to be rendered.
const renderer = urls.length > 0 ? await import("./html/render.ts") : undefined;
const files: SourceFile[] = [];
for (const path of paths) {
  // An unchanged file has nothing to classify, so it is not even read.
  if (changed && !isUrl(path) && !changed.has(path)) continue;
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

const configured = configureRules(allRules, config);
// Naming a rule runs it, opt-in or not, unless the config switched it off.
const nameable = [...configured, ...allRules.filter((rule) => rule.optIn && config.rules?.[rule.id] === undefined)];
const chosen = values.rule ? nameable.filter((rule) => values.rule!.includes(rule.id)) : values.experimental ? nameable : configured;
const floor = values["min-probability"] === undefined ? undefined : Number(values["min-probability"]);
if (floor !== undefined && !(floor > 0 && floor < 1)) {
  console.error(`--min-probability takes a number between 0 and 1, not "${values["min-probability"]}".`);
  process.exit(2);
}
const rules = floor === undefined ? chosen : widen(chosen, floor);
if (values.rule && rules.length !== values.rule.length) {
  console.error(`Unknown rule. Known rules: ${nameable.map((rule) => rule.id).join(", ")}`);
  process.exit(2);
}
const { findings, classifications, reported, stats } = await run(files, {
  rules,
  // Without credentials the client cannot even be built, and cache-only mode never uses it.
  ask: values["cache-only"] ? async () => Promise.reject(new Error("cache-only")) : createAsk(),
  cacheOnly: values["cache-only"],
  isolation: values.isolation as Isolation,
  cache: values["no-cache"] ? undefined : new AnswerCache(".jev-lint-cache"),
  ...(changed && { changed }),
  ...(config.conventions && { conventions: config.conventions }),
  ...(values.baseline && { baseline: { known: readBaseline(values.baseline), root: rootOf(values.baseline) } }),
  root: projectDir,
});

if (values["write-baseline"]) {
  const count = writeBaseline(values["write-baseline"], reported, rootOf(values["write-baseline"]));
  console.error(`Wrote ${count} findings to ${values["write-baseline"]}. Pass --baseline ${values["write-baseline"]} to be told only about new ones.`);
  process.exit(0);
}

let verification: VerifyResult | undefined;
// Naming the reader's model asks for the reader, so `--verify-model haiku` needs no `--verify` beside it.
if ((values.verify || values["verify-model"] !== undefined) && findings.length > 0) {
  const model = values["verify-model"] ?? "sonnet";
  // The reader may read inside the linted project, and inside the directory of any file given from outside it.
  const cwd = resolve(projectDir);
  const outside = new Set(findings.map((f) => dirname(resolve(f.file))).filter((dir) => relative(cwd, dir).startsWith("..")));
  console.error(`Asking a second reader (${model}) to confirm ${findings.length} findings by opening the files. This can take a few minutes.`);
  verification = await verify(findings, {
    read: createClaudeReader({ model, cwd, dirs: [...outside] }),
    model,
    sources: new Map(files.filter((file) => !isUrl(file.path)).map((file) => [file.path, file.source])),
    ...(!values["no-cache"] && { cache: new JsonStore(".jev-lint-cache/verdicts") }),
  });
  for (const failure of verification.stats.failures) console.error(`The second reader failed on a batch: ${failure}`);
}
const shown = verification?.findings ?? findings;

const classified = new Map<string, number>();
for (const j of classifications) classified.set(j.ruleId, (classified.get(j.ruleId) ?? 0) + 1);

const report =
  values.format === "json"
    ? json(shown, stats, verification)
    : values.format === "github"
      ? github(shown)
    : values.format === "html" || values.format === "html-fragment"
      ? html(shown, stats, { targets, classified, withAxe: values.axe !== undefined, standalone: values.format === "html" })
      : stylish(shown, stats, { evidence: values.evidence, ...(verification && { verification: verification.stats }) });

if (values.output) {
  writeFileSync(values.output, report);
  console.error(`Wrote ${values.output}`);
} else {
  console.log(report);
}
process.exitCode = shown.some((f) => f.severity === "error") ? 1 : 0;
