import { styleText } from "node:util";
import type { Finding, RunStats, Severity } from "../engine/types.ts";
import { byElement } from "./group.ts";

const COLORS = { error: "red", warn: "yellow", review: "cyan" } as const satisfies Record<Severity, string>;

// Input tokens only; Jev does not charge for output. See https://docs.typesafe.ai/models
const USD_PER_MILLION_TOKENS = 0.042;

// A merged finding lists where it occurs. The JSON report has them all; a terminal needs only enough to start.
const SHOWN_PLACES = 8;

const dim = (value: string) => styleText("dim", value);

function measurement(value: Finding["measurements"][string]): string {
  return typeof value === "number" ? value.toFixed(2) : `${value.choice} (${value.probability.toFixed(2)})`;
}

/** One block per element: what it is, each finding about it, and the evidence behind each. */
export function stylish(findings: Finding[], stats: RunStats, options: { evidence: boolean }): string {
  const lines: string[] = [];
  for (const [file, inFile] of Map.groupBy(findings, (f) => f.file)) {
    lines.push("", styleText("underline", file));
    for (const element of byElement(inFile)) {
      lines.push("", `  ${`${element.loc.line}:${element.loc.col}`.padEnd(8)} ${dim(element.snippet ?? "")}`);
      for (const f of element.findings) {
        lines.push(`    ${styleText(COLORS[f.severity], f.severity.padEnd(6))} ${f.message}  ${dim(`${f.ruleId} p=${f.p.toFixed(2)}`)}`);
        if (f.hint) lines.push(`           ${f.hint}`);
        if (f.occurrences) {
          const places = f.occurrences.map(({ loc }) => `${loc.line}:${loc.col}`);
          lines.push(dim(`           at ${places.slice(0, SHOWN_PLACES).join(", ")}${places.length > SHOWN_PLACES ? ` and ${places.length - SHOWN_PLACES} more` : ""}`));
        }
        const approved = (f.axe ?? []).filter((a) => a.checksSameThing && a.outcome === "passed");
        if (approved.length > 0) lines.push(`           ${styleText("magenta", "valid but false")}  axe passed ${approved.map((a) => a.rule).join(", ")} on this element`);
        if (!options.evidence) continue;
        for (const [name, value] of Object.entries(f.measurements)) lines.push(dim(`           jev   ${name}: ${measurement(value)}`));
        for (const [name, value] of Object.entries(f.facts)) if (value !== "") lines.push(dim(`           code  ${name}: ${value}`));
      }
    }
  }

  const count = (severity: Severity) => findings.filter((f) => f.severity === severity).length;
  const cost = (stats.inputTokens / 1_000_000) * USD_PER_MILLION_TOKENS;
  lines.push(
    "",
    `${count("error")} errors, ${count("warn")} warnings, ${count("review")} to review, on ${byElement(findings).length} elements`,
    dim(
      `${stats.questions} questions, ${stats.cacheHits} cached, ${stats.requests} requests, ${stats.inputTokens} input tokens (~$${cost.toFixed(5)})${stats.unanswered > 0 ? `, ${stats.unanswered} candidates unjudged (cache only)` : ""}`,
    ),
  );
  return lines.join("\n");
}
