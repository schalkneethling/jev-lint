import type { Finding, Loc } from "../engine/types.ts";

export interface ElementReport {
  file: string;
  loc: Loc;
  snippet?: string;
  findings: Finding[];
}

/** Several rules can report the same element. A reader wants one entry per element, not one per rule. */
export function byElement(findings: Finding[]): ElementReport[] {
  const groups = Map.groupBy(findings, (f) => `${f.file}:${f.loc.line}:${f.loc.col}`);
  return [...groups.values()].map((group) => ({
    file: group[0]!.file,
    loc: group[0]!.loc,
    ...(group[0]!.snippet !== undefined && { snippet: group[0]!.snippet }),
    findings: group.toSorted((a, b) => b.p - a.p),
  }));
}
