import type { Finding, RunStats } from "../engine/types.ts";
import type { Rejection, VerifyStats } from "../engine/verify.ts";
import { byElement } from "./group.ts";

/**
 * For coding agents and CI. Each element lists its findings with the words checked, Jev's
 * measurements, and the facts code established, which is what an agent needs to act without
 * repeating the classification.
 *
 * After `--verify`, each finding the second reader kept carries `confirmed`, and the report lists what the
 * reader rejected and why, so that a rejection can be checked.
 */
export function json(findings: Finding[], stats: RunStats, verification?: { stats: VerifyStats; rejected: Rejection[] }): string {
  const elements = byElement(findings).map(({ file, loc, snippet, findings: group }) => ({
    file,
    line: loc.line,
    column: loc.col,
    snippet,
    findings: group.map(({ ruleId, severity, p, message, hint, compared, confirmed, checked, measurements, facts, axe, occurrences }) => ({
      rule: ruleId,
      severity,
      probability: Number(p.toFixed(3)),
      message,
      hint,
      compared,
      confirmed,
      checked,
      measurements,
      facts,
      axe,
      occurrences: occurrences?.map(({ loc, snippet, checked }) => ({ line: loc.line, column: loc.col, snippet, checked })),
    })),
  }));
  const rejected = verification?.rejected.map(({ finding, reason }) => ({
    file: finding.file,
    line: finding.loc.line,
    column: finding.loc.col,
    rule: finding.ruleId,
    message: finding.message,
    reason,
  }));
  return JSON.stringify({ elements, stats, ...(verification && { verification: verification.stats, rejected }) }, null, 2);
}
