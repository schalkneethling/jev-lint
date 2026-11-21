import type { Finding, Severity } from "../engine/types.ts";

// GitHub Actions workflow commands: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
// A finding to review is a notice: it should be seen on the pull request without failing or alarming it.
const COMMAND = { error: "error", warn: "warning", review: "notice" } as const satisfies Record<Severity, string>;

// Property values escape `%`, CR, LF, `:` and `,`; the message escapes only the first three.
const escapeData = (value: string) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (value: string) => escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");

/**
 * One annotation per finding, printed where a GitHub Actions job can see it, so findings appear on the
 * changed lines of a pull request. Meant for `jev-lint --since origin/main --format github`.
 */
export function github(findings: Finding[]): string {
  return findings
    .map((f) => {
      const text = [f.message, f.hint, f.confirmed && `Confirmed by a second reader: ${f.confirmed.reason}`].filter(Boolean).join(" ");
      return `::${COMMAND[f.severity]} file=${escapeProperty(f.file)},line=${f.loc.line},col=${f.loc.col},title=${escapeProperty(`jev-lint ${f.ruleId}`)}::${escapeData(`${text} (p=${f.p.toFixed(2)})`)}`;
    })
    .join("\n");
}
