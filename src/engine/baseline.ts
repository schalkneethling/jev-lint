import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { Classification } from "./types.ts";

/**
 * A baseline lets a project adopt the linter without first fixing, or suppressing one by one, everything
 * it already reports: record today's findings once, and from then on be told only about new ones.
 *
 * A finding is identified by its rule, its file, and the words that were classified, not by its line. So
 * moving code keeps it in the baseline, and changing the comment, the name, or the body takes it out: a
 * finding about words that have since changed is a new finding.
 */
export interface Baseline {
  version: 1;
  /** Fingerprints, each with the rule and file it came from so the file can be read and reviewed. */
  findings: { fingerprint: string; rule: string; file: string }[];
}

const pathIn = (root: string, file: string) => (/^https?:\/\//.test(file) ? file : relative(root, resolve(file)).replaceAll("\\", "/"));

export function fingerprintOf(j: Pick<Classification, "ruleId" | "file" | "candidate">, root: string): string {
  // The project's conventions travel in the candidate's data and are not its words: adding a convention to
  // the config must not bring every recorded finding back as new.
  const { project_conventions: _conventions, ...words } = j.candidate.data;
  return createHash("sha256").update(JSON.stringify([j.ruleId, pathIn(root, j.file), words])).digest("hex").slice(0, 32);
}

/**
 * The directory a baseline's file paths are relative to: the one the baseline file is in. Tying it to the file,
 * and not to how the linter was called, means `jev-lint .` and `jev-lint src/a.ts src/b.ts` agree on a fingerprint.
 */
export const rootOf = (baselineFile: string) => dirname(resolve(baselineFile));

export function readBaseline(file: string): Set<string> {
  if (!existsSync(file)) throw new Error(`Baseline file not found: ${file}. Create it with --write-baseline ${file}`);
  const baseline = JSON.parse(readFileSync(file, "utf8")) as Baseline;
  if (baseline.version !== 1 || !Array.isArray(baseline.findings)) throw new Error(`${file} is not a jev-lint baseline.`);
  return new Set(baseline.findings.map((finding) => finding.fingerprint));
}

/** Writes every reported classification as the new baseline, sorted so that the file diffs cleanly. */
export function writeBaseline(file: string, reported: Classification[], root: string): number {
  const findings = reported
    .map((j) => ({ fingerprint: fingerprintOf(j, root), rule: j.ruleId, file: pathIn(root, j.file) }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.fingerprint.localeCompare(b.fingerprint));
  const baseline: Baseline = { version: 1, findings };
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
  return findings.length;
}
