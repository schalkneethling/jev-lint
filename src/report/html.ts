import type { Finding, RunStats, Severity } from "../engine/types.ts";
import { byElement } from "./group.ts";

const USD_PER_MILLION_TOKENS = 0.042;
const SEVERITIES: Severity[] = ["error", "warn", "review"];

// Everything in a report can come from a linted page, so everything is escaped.
const esc = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const isValidButFalse = (f: Finding) => (f.axe ?? []).some((a) => a.checksSameThing && a.outcome === "passed");

function measurement(value: Finding["measurements"][string]): string {
  return typeof value === "number" ? value.toFixed(2) : `${esc(value.choice)} <span class="quiet">${value.probability.toFixed(2)}</span>`;
}

function evidence(f: Finding): string {
  const rows = [
    ...Object.entries(f.measurements).map(([name, value]) => ["jev", name, measurement(value)]),
    ...Object.entries(f.facts).filter(([, value]) => value !== "").map(([name, value]) => ["code", name, esc(value)]),
    ...(f.axe ?? []).filter((a) => a.checksSameThing).map((a) => ["axe", a.rule, `${a.outcome}: ${esc(a.help)}`]),
  ];
  return `<dl class="evidence">${rows
    .map(([origin, name, value]) => `<div><dt><span class="origin origin-${origin}">${origin}</span>${esc(name!.replaceAll("_", " "))}</dt><dd>${value}</dd></div>`)
    .join("")}</dl>`;
}

function finding(f: Finding): string {
  const vbf = isValidButFalse(f);
  return `<li class="finding" data-severity="${f.severity}" data-rule="${esc(f.ruleId)}" data-vbf="${vbf}">
  <div class="finding-head">
    <span class="pill pill-${f.severity}">${f.severity}</span>
    ${vbf ? '<span class="pill pill-vbf">valid but false</span>' : ""}
    <span class="rule">${esc(f.ruleId)}</span>
    <span class="meter" role="img" aria-label="Violation probability ${f.p.toFixed(2)}"><span style="inline-size:${Math.round(f.p * 100)}%"></span></span>
    <span class="p">${f.p.toFixed(2)}</span>
  </div>
  <p class="message">${esc(f.message)}</p>
  ${f.hint ? `<p class="hint">${esc(f.hint)}</p>` : ""}
  ${f.occurrences ? `<p class="places">At lines ${f.occurrences.map(({ loc }) => loc.line).join(", ")}</p>` : ""}
  ${evidence(f)}
</li>`;
}

function styles(): string {
  return `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root {
  --ground: #F6F8F5; --surface: #FFFFFF; --ink: #18201D; --muted: #5A6760; --line: #D8DED7;
  --jev: #0F6B5C; --vbf: #8A2D7A; --vbf-ground: #F6E9F3;
  --error: #B3261E; --warn: #8F5400; --review: #2C5F9E; --code-ground: #EDF1EC;
  --sans: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #111514; --surface: #181D1B; --ink: #E4EBE7; --muted: #93A19A; --line: #2A3330;
    --jev: #55C7B2; --vbf: #E08BD0; --vbf-ground: #2C1B29;
    --error: #F2776C; --warn: #E2AA4E; --review: #82B3EC; --code-ground: #1F2623;
  }
}
:root[data-theme="dark"] {
  --ground: #111514; --surface: #181D1B; --ink: #E4EBE7; --muted: #93A19A; --line: #2A3330;
  --jev: #55C7B2; --vbf: #E08BD0; --vbf-ground: #2C1B29;
  --error: #F2776C; --warn: #E2AA4E; --review: #82B3EC; --code-ground: #1F2623;
}
* { box-sizing: border-box; }
body { background: var(--ground); color: var(--ink); font: 400 15px/1.55 var(--sans); padding-inline: clamp(16px, 4vw, 48px); padding-block: 32px 64px; }
.wrap { max-inline-size: 60rem; margin-inline: auto; display: grid; gap: 40px; }
h1 { font-size: 1.75rem; line-height: 1.2; font-weight: 600; margin: 0; text-wrap: balance; }
h2 { font-size: 1.05rem; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
p { margin: 0; }
.quiet, .lede { color: var(--muted); }
.lede { max-inline-size: 65ch; }
header { display: grid; gap: 10px; }
.eyebrow { font: 500 0.75rem/1 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--jev); }

.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
.stat { background: var(--surface); padding: 14px 16px; display: grid; gap: 2px; }
.stat b { font: 500 1.6rem/1.1 var(--mono); font-variant-numeric: tabular-nums; }
.stat span { font-size: 0.8rem; color: var(--muted); }
.stat-vbf b { color: var(--vbf); } .stat-error b { color: var(--error); } .stat-warn b { color: var(--warn); } .stat-review b { color: var(--review); }
.cost { font: 400 0.8rem/1.5 var(--mono); color: var(--muted); }

.rules { display: grid; gap: 8px; }
.rule-row { display: grid; grid-template-columns: minmax(0, 15rem) 1fr 5.5rem; gap: 12px; align-items: center; font: 400 0.82rem/1.3 var(--mono); }
.rule-row > span:first-child { overflow-wrap: anywhere; }
.bar { display: flex; block-size: 10px; background: var(--code-ground); }
.bar i { display: block; } .bar .error { background: var(--error); } .bar .warn { background: var(--warn); } .bar .review { background: var(--review); }
.rule-row .n { text-align: end; font-variant-numeric: tabular-nums; color: var(--muted); }

.filters { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; font-size: 0.88rem; padding-block: 12px; border-block: 1px solid var(--line); }
.filters label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
.filters select { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line); padding: 3px 6px; max-inline-size: 100%; }
:focus-visible { outline: 2px solid var(--jev); outline-offset: 2px; }

.file { display: grid; gap: 16px; }
.file > h2 { padding-block-end: 8px; border-block-end: 2px solid var(--ink); }
.element { display: grid; gap: 10px; }
.where { display: flex; gap: 12px; align-items: baseline; }
.loc { font: 500 0.78rem/1.4 var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
pre { margin: 0; font: 400 0.8rem/1.5 var(--mono); background: var(--code-ground); padding: 8px 10px; overflow-x: auto; flex: 1; min-inline-size: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
ul.findings { list-style: none; margin: 0; padding: 0 0 0 16px; border-inline-start: 1px solid var(--line); display: grid; gap: 14px; }
.finding { display: grid; gap: 4px; }
.finding-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.pill { font: 500 0.7rem/1 var(--mono); letter-spacing: 0.04em; text-transform: uppercase; padding: 4px 6px; border: 1px solid currentColor; }
.pill-error { color: var(--error); } .pill-warn { color: var(--warn); } .pill-review { color: var(--review); }
.pill-vbf { color: var(--vbf); background: var(--vbf-ground); border-color: transparent; }
.rule { font: 400 0.8rem/1 var(--mono); color: var(--muted); }
.meter { inline-size: 64px; block-size: 6px; background: var(--code-ground); margin-inline-start: auto; }
.meter span { display: block; block-size: 100%; background: var(--ink); }
.p { font: 500 0.8rem/1 var(--mono); font-variant-numeric: tabular-nums; }
.message { max-inline-size: 70ch; }
.hint { color: var(--jev); max-inline-size: 70ch; }
.places { color: var(--muted); max-inline-size: 70ch; font-variant-numeric: tabular-nums; }
.evidence { margin: 4px 0 0; display: grid; gap: 2px; font: 400 0.78rem/1.5 var(--mono); color: var(--muted); }
.evidence div { display: grid; grid-template-columns: minmax(0, 17rem) 1fr; gap: 12px; }
.evidence dt, .evidence dd { margin: 0; overflow-wrap: anywhere; }
.evidence dd { color: var(--ink); }
.origin { display: inline-block; inline-size: 2.8rem; font-weight: 500; }
.origin-jev { color: var(--jev); } .origin-code { color: var(--muted); } .origin-axe { color: var(--vbf); }
.empty { color: var(--muted); }
@media (max-width: 34rem) {
  .rule-row { grid-template-columns: 1fr 5.5rem; } .rule-row .bar { grid-column: 1 / -1; grid-row: 2; }
  .evidence div { grid-template-columns: 1fr; gap: 0; } .where { flex-direction: column; gap: 4px; }
  .meter { margin-inline-start: 0; }
}
</style>`;
}

const SCRIPT = `<script>
(() => {
  const controls = [...document.querySelectorAll(".filters input, .filters select")];
  const apply = () => {
    const shown = new Set(controls.filter((c) => c.name === "severity" && c.checked).map((c) => c.value));
    const vbfOnly = document.getElementById("filter-vbf")?.checked ?? false;
    const rule = document.getElementById("filter-rule").value;
    for (const finding of document.querySelectorAll(".finding")) {
      finding.hidden = !shown.has(finding.dataset.severity) || (vbfOnly && finding.dataset.vbf !== "true") || (rule !== "" && finding.dataset.rule !== rule);
    }
    for (const element of document.querySelectorAll(".element")) element.hidden = !element.querySelector(".finding:not([hidden])");
    for (const file of document.querySelectorAll(".file")) file.hidden = !file.querySelector(".element:not([hidden])");
    document.getElementById("nothing").hidden = !!document.querySelector(".file:not([hidden])");
  };
  controls.forEach((control) => control.addEventListener("change", apply));
})();
</script>`;

export interface HtmlOptions {
  /** What was linted, as given on the command line. */
  targets: string[];
  /** How many candidates each rule classified, reported or not. A short report should still show what was examined. */
  classified: Map<string, number>;
  withAxe: boolean;
  /** A complete document. When false, only the page content, for hosts that supply their own shell. */
  standalone?: boolean;
}

export function html(findings: Finding[], stats: RunStats, { targets, classified, withAxe, standalone = true }: HtmlOptions): string {
  const elements = byElement(findings);
  const count = (severity: Severity) => findings.filter((f) => f.severity === severity).length;
  const vbf = findings.filter(isValidButFalse).length;
  const cost = (stats.inputTokens / 1_000_000) * USD_PER_MILLION_TOKENS;
  const subject = targets.length === 1 ? targets[0]! : /^https?:/.test(targets[0] ?? "") ? new URL(targets[0]!).hostname : `${targets.length} targets`;
  const reported = Map.groupBy(findings, (f) => f.ruleId);
  const byRule = [...classified].map(([rule, total]) => [rule, reported.get(rule) ?? [], total] as const).sort((a, b) => b[1].length - a[1].length || b[2] - a[2]);

  const stat = (kind: string, value: number | string, label: string) => `<div class="stat stat-${kind}"><b>${value}</b><span>${label}</span></div>`;

  const body = `<div class="wrap">
<header>
  <p class="eyebrow">jev-lint meaning report</p>
  <h1>${esc(subject)}</h1>
  <p class="lede">Each finding is a classification about what the words mean, not whether the markup or code is valid. It lists what Jev measured, what code established${withAxe ? ", and what axe concluded about the same element" : ""}, so you can act on it without repeating the classification.</p>
</header>

<section class="summary" aria-label="Summary">
  ${withAxe ? stat("vbf", vbf, "valid but false: axe passed, meaning fails") : ""}
  ${stat("error", count("error"), "errors")}
  ${stat("warn", count("warn"), "warnings")}
  ${stat("review", count("review"), "to review")}
  ${stat("plain", elements.length, "elements or statements")}
  ${stat("plain", new Set(findings.map((f) => f.file)).size, "files or pages with findings")}
</section>
<p class="cost">${stats.questions} questions · ${stats.cacheHits} answered from cache · ${stats.requests} requests · ${stats.inputTokens.toLocaleString("en")} input tokens · about $${cost.toFixed(4)}</p>

<section class="rules" aria-label="Checked and reported, per rule">
  <p class="quiet">Reported, out of everything each rule examined.</p>
  ${byRule
    .map(
      ([rule, group, total]) => `<div class="rule-row"><span>${esc(rule)}</span><span class="bar">${SEVERITIES.map(
        (s) => `<i class="${s}" style="inline-size:${(group.filter((f) => f.severity === s).length / Math.max(1, total)) * 100}%"></i>`,
      ).join("")}</span><span class="n">${group.length} of ${total}</span></div>`,
    )
    .join("\n  ")}
</section>

<form class="filters" aria-label="Filter findings" onsubmit="return false">
  ${SEVERITIES.map((s) => `<label><input type="checkbox" name="severity" id="filter-${s}" value="${s}" checked> ${s}</label>`).join("\n  ")}
  ${withAxe ? '<label><input type="checkbox" id="filter-vbf"> valid but false only</label>' : ""}
  <label>rule <select id="filter-rule"><option value="">all</option>${byRule.filter(([, group]) => group.length > 0).map(([rule]) => `<option>${esc(rule)}</option>`).join("")}</select></label>
</form>

<p class="empty" id="nothing" ${findings.length > 0 ? "hidden" : ""}>Nothing to show.</p>

${[...Map.groupBy(elements, (e) => e.file)]
  .map(
    ([file, group]) => `<section class="file">
  <h2>${esc(file)}</h2>
  ${group
    .map(
      (element) => `<article class="element">
    <div class="where"><span class="loc">${element.loc.line}:${element.loc.col}</span>${element.snippet ? `<pre>${esc(element.snippet)}</pre>` : ""}</div>
    <ul class="findings">${element.findings.map(finding).join("")}</ul>
  </article>`,
    )
    .join("\n  ")}
</section>`,
  )
  .join("\n\n")}
</div>`;

  const title = `<title>${esc(subject)} meaning report</title>`;
  if (!standalone) return `${title}\n${styles()}\n${body}\n${SCRIPT}`;
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${title}\n${styles()}\n</head>\n<body>\n${body}\n${SCRIPT}\n</body>\n</html>`;
}
