import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Inclusive, 1-based line ranges of a file that a diff added or rewrote. */
export type LineRanges = [first: number, last: number][];

/**
 * Reads the new-side line ranges out of `git diff -U0` output. A hunk header is
 * `@@ -old[,count] +new[,count] @@`; a count of 0 on the new side is a pure deletion, after new line `new`.
 */
export function parseDiff(diff: string): Map<string, LineRanges> {
  const changed = new Map<string, LineRanges>();
  let current: LineRanges | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = unquoted(line.slice(4).trim());
      current = path === "/dev/null" ? undefined : [];
      if (current) changed.set(path.replace(/^b\//, ""), current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !current) continue;
    const first = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    // A pure deletion (`+N,0`) leaves no new line to point at, and can still break what is left: deleting the
    // one real assertion from a test, or a `return` from a getter. The lines either side of the gap stand for it.
    current.push(count > 0 ? [first, first + count - 1] : [Math.max(first, 1), first + 1]);
  }
  return changed;
}

/**
 * Git writes a path with a quote, a backslash or a control character in it (and, unless told otherwise, any
 * non-ASCII one) in C-quoted form: `"b/caf\303\251.ts"`. This gives the path back as it is on disk.
 */
function unquoted(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  const inner = path.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== "\\") {
      bytes.push(...Buffer.from(inner[i]!, "utf8"));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(escapes[inner[i + 1]!] ?? inner.charCodeAt(i + 1));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// core.quotePath=false: non-ASCII file names are printed as they are, not as octal escapes.
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/**
 * Lines changed in the working tree under `cwd` since `base`, keyed by absolute path. `cwd` is the directory being
 * linted, which need not be the one jev-lint runs from, so the diff is of the project and not of the tool. With a branch or tag as `base`
 * the comparison starts where the current branch left it (the merge base), which is what a pull request shows.
 * Untracked files count as changed in full: they are exactly the code a review has not seen.
 */
export function changedSince(base: string, cwd: string): Map<string, LineRanges> {
  const from = base === "HEAD" ? "HEAD" : git(cwd, ["merge-base", base, "HEAD"]).trim();
  const changed = new Map<string, LineRanges>();
  // --relative: paths come back relative to `cwd`, and only changes under it are listed. The prefixes are
  // pinned because a user's `diff.mnemonicPrefix` or `diff.noprefix` would otherwise change what `+++` shows.
  for (const [path, ranges] of parseDiff(git(cwd, ["diff", "-U0", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--relative", from, "--"]))) changed.set(resolve(cwd, path), ranges);
  // -z: names are separated by NUL and never quoted, so a name with a newline or a quote in it survives.
  for (const path of git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) {
    changed.set(resolve(cwd, path), [[1, readFileSync(resolve(cwd, path), "utf8").split("\n").length]]);
  }
  return changed;
}

export const touches = (ranges: LineRanges, lines: { first: number; last: number }) => ranges.some(([first, last]) => first <= lines.last && last >= lines.first);
