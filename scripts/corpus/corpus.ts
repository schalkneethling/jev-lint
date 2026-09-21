// Reads either kind of corpus manifest into the one shape the prevalence, classify, sample, and score
// scripts work from. The two fetchers record different things because they sample different worlds: a page
// has a URL, a rank band, and an axe report; a file has a repository, a star band, and a commit SHA. What
// the scripts downstream actually need is the same three facts either way — where the text is on disk, what
// kind of thing it is, and how to name where a finding sits so a labeller can go and look.
import { readFileSync } from "node:fs";

export interface CorpusFile {
  /** Path of the snapshot on disk. */
  file: string;
  /** `home`, `form`, `article` for pages; `source`, `test`, `jsx` for files. */
  kind: string;
  /** Rank band for pages, star band for repositories. */
  band: string;
  /** Where this came from, as the label bench prints it: a URL, or `owner/repo: path`. */
  origin: string;
}

export interface Corpus {
  dir: string;
  seed: number;
  /**
   * A code corpus runs every rule, because `run()` parses a JS or TS file twice — as code, and for the
   * markup in its JSX — and it has no axe report, because nothing was rendered in a browser.
   */
  code: boolean;
  files: CorpusFile[];
}

interface PageEntry {
  file: string;
  url: string;
  kind: string;
  band: string;
}

interface CodeEntry {
  file: string;
  repo: string;
  path: string;
  kind: string;
  band: string;
}

export function readCorpus(dir: string): Corpus {
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8")) as { seed: number; pages?: PageEntry[]; files?: CodeEntry[] };
  const code = manifest.files !== undefined;
  const files = code
    ? manifest.files!.map((entry) => ({ file: entry.file, kind: entry.kind, band: entry.band, origin: `${entry.repo}: ${entry.path}` }))
    : manifest.pages!.map((entry) => ({ file: entry.file, kind: entry.kind, band: entry.band, origin: entry.url }));
  return { dir, seed: manifest.seed, code, files };
}

/**
 * How a classification names its place for a labeller. A page is one document, so its URL is the whole
 * answer; a source file is hundreds of lines, so the line number is what makes the reference usable.
 */
export const placeOf = (corpus: Corpus, origin: string, line: number): string => (corpus.code ? `${origin}:${line}` : origin);
