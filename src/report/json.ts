import type { Finding, RunStats } from "../engine/types.ts";
import { byElement } from "./group.ts";

/**
 * For coding agents and CI. Each element lists its findings with the words checked, Jev's
 * measurements, and the facts code established, which is what an agent needs to act without
 * repeating the judgement.
 */
export function json(findings: Finding[], stats: RunStats): string {
  const elements = byElement(findings).map(({ file, loc, snippet, findings: group }) => ({
    file,
    line: loc.line,
    column: loc.col,
    snippet,
    findings: group.map(({ ruleId, severity, p, message, hint, checked, measurements, facts, axe }) => ({
      rule: ruleId,
      severity,
      probability: Number(p.toFixed(3)),
      message,
      hint,
      checked,
      measurements,
      facts,
      axe,
    })),
  }));
  return JSON.stringify({ elements, stats }, null, 2);
}
