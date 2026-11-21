import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JsonStore } from "./cache.ts";
import { pool } from "./run.ts";
import type { Confirmation, Finding } from "./types.ts";

/**
 * The second stage. Jev narrows a codebase to a short list from each candidate's own words; a reader that
 * can open the file settles what those words could not. On 187 reports from code no rule was tuned against,
 * Jev alone was right on 30%, and what a Sonnet reader kept was right on 91% (findings §32).
 */

/** What the reader is told to do with each finding. Also the instructions a person hands their own agent. */
export const INSTRUCTIONS = readFileSync(new URL("./verify-instructions.md", import.meta.url), "utf8");

/** The shape the reader must answer in, as a JSON Schema. */
export const VERDICTS_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", description: "The finding's id, as given." },
          true: { type: "boolean", description: "The message is true of the code." },
          worth_raising: { type: "boolean", description: "A careful, senior reviewer would want it raised." },
          reason: { type: "string", description: "One or two sentences naming the code that decided it." },
        },
        required: ["id", "true", "worth_raising", "reason"],
      },
    },
  },
  required: ["verdicts"],
} as const;

/**
 * Sends one prompt to a model that can open files and returns what it answered, which should match
 * `VERDICTS_SCHEMA` and is checked here either way. `claude.ts` has the reader the CLI uses.
 */
export type Reader = (prompt: string) => Promise<{ output: unknown; costUsd?: number }>;

interface Verdict {
  keep: boolean;
  reason: string;
}

export interface VerifyOptions {
  read: Reader;
  /** Names the reader in the report and in the cache key. */
  model: string;
  /** Each file's source by path, as the findings name it. A finding about anything else (a URL) is not verified. */
  sources: Map<string, string>;
  /** Verdicts already given. A verdict is reused while the finding and its file's source are unchanged. */
  cache?: JsonStore<Verdict>;
  /**
   * Findings per prompt. Readers handed about 100 gave one shared sentence as the reason for most
   * rejections, which suggests they skimmed, so the default stays at a few dozen at most.
   */
  batchSize?: number;
  /** Characters of source per prompt, after which a new batch starts. One finding is always sent, whatever its size. */
  sourceBudget?: number;
  concurrency?: number;
}

export interface Rejection {
  finding: Finding;
  reason: string;
}

export interface VerifyStats {
  model: string;
  confirmed: number;
  rejected: number;
  /** Findings reported as Jev left them: about a page rather than a file, or in a batch the reader failed on. */
  unverified: number;
  /** Verdicts reused from an earlier run. */
  cached: number;
  costUsd: number;
  /** Why batches failed, each distinct reason once. */
  failures: string[];
}

export interface VerifyResult {
  /** Confirmed findings, each with the reader's reason, and unverified ones unchanged, in the order given. */
  findings: Finding[];
  rejected: Rejection[];
  stats: VerifyStats;
}

const BATCH_SIZE = 20;
const SOURCE_BUDGET = 150_000;
// Lines of source given on each side of a finding. Enough to hold the enclosing `describe`, the imports of
// a small file and the sibling functions of a large one.
const CONTEXT_LINES = 150;

interface Pending {
  id: number;
  finding: Finding;
  /** The lines of the file given to the reader for this finding, counted from 1. */
  window: { first: number; last: number };
  /** Characters in those lines: what the finding adds to a prompt, at most. */
  size: number;
}

function windowOf(finding: Finding, lines: string[]): Pending["window"] {
  const { line, lines: own } = finding.loc;
  const places = [line, own?.first ?? line, own?.last ?? line, ...(finding.occurrences ?? []).map(({ loc }) => loc.line)];
  return { first: Math.max(1, Math.min(...places) - CONTEXT_LINES), last: Math.min(lines.length, Math.max(...places) + CONTEXT_LINES) };
}

/**
 * The source each finding of the batch is about, with line numbers, each line once. It is in the prompt so
 * that reading the context does not depend on the reader choosing to: handed only the findings, a reader
 * with tools to open files answered twenty of them without opening one.
 */
function excerpts(batch: Pending[], sources: Map<string, string>): string {
  return [...Map.groupBy(batch, ({ finding }) => finding.file)]
    .map(([file, inFile]) => {
      const lines = sources.get(file)!.split("\n");
      const wanted = new Set(inFile.flatMap(({ window }) => Array.from({ length: window.last - window.first + 1 }, (_, i) => window.first + i)));
      const numbered = [...wanted].sort((a, b) => a - b).map((n, i, all) => `${i > 0 && all[i - 1] !== n - 1 ? "…\n" : ""}${n}: ${lines[n - 1]}`);
      // Absolute, so that it names the same file whatever directory the reader starts in.
      return `=== ${resolve(file)} (${lines.length} lines) ===\n${numbered.join("\n")}`;
    })
    .join("\n\n");
}

function promptFor(batch: Pending[], sources: Map<string, string>): string {
  const items = batch.map(({ id, finding }) => ({
    id,
    file: resolve(finding.file),
    line: finding.loc.line,
    rule: finding.ruleId,
    message: finding.message,
    checked: finding.checked,
  }));
  return `${INSTRUCTIONS}\nAnswer with one verdict per finding, using each finding's \`id\`.\n\nFindings:\n\n${JSON.stringify(items, null, 2)}\n\nSource:\n\n${excerpts(batch, sources)}\n`;
}

/** Consecutive findings share a batch, so one file's findings are read together, until either limit is reached. */
function toBatches(pending: Pending[], batchSize: number, sourceBudget: number): Pending[][] {
  const batches: Pending[][] = [];
  let size = 0;
  for (const item of pending) {
    const current = batches.at(-1);
    if (current === undefined || current.length >= batchSize || size + item.size > sourceBudget) {
      batches.push([item]);
      size = item.size;
    } else {
      current.push(item);
      size += item.size;
    }
  }
  return batches;
}

function verdictsFrom(output: unknown): Map<number, Verdict> {
  const listed = (output as { verdicts?: unknown } | null)?.verdicts;
  const verdicts = new Map<number, Verdict>();
  for (const entry of Array.isArray(listed) ? listed : []) {
    const { id, true: isTrue, worth_raising: worthRaising, reason } = (entry ?? {}) as Record<string, unknown>;
    // A malformed verdict is no verdict: its finding stays reported, marked as not verified.
    if (typeof id !== "number" || typeof isTrue !== "boolean" || typeof worthRaising !== "boolean" || typeof reason !== "string") continue;
    verdicts.set(id, { keep: isTrue && worthRaising, reason });
  }
  return verdicts;
}

/**
 * Keeps the findings a file-reading model confirms. A finding is never dropped without a verdict: when the
 * reader fails or leaves one out, the finding is reported as Jev left it and counted as unverified.
 */
export async function verify(findings: Finding[], options: VerifyOptions): Promise<VerifyResult> {
  const { read, model, sources, cache, batchSize = BATCH_SIZE, sourceBudget = SOURCE_BUDGET, concurrency = 4 } = options;
  const stats: VerifyStats = { model, confirmed: 0, rejected: 0, unverified: 0, cached: 0, costUsd: 0, failures: [] };
  const verdicts = new Map<number, Verdict>();
  const keys = new Map<number, string>();
  const pending: Pending[] = [];

  findings.forEach((finding, id) => {
    const source = sources.get(finding.file);
    if (source === undefined) return;
    // The reader may open other files, which the key cannot see: a verdict that turned on a sibling file
    // outlives a change to that file. `--no-cache` asks again.
    const key = JsonStore.hash([model, INSTRUCTIONS, finding.ruleId, finding.message, finding.checked, source]);
    keys.set(id, key);
    const known = cache?.get(key);
    if (known === undefined) {
      const lines = source.split("\n");
      const window = windowOf(finding, lines);
      const size = lines.slice(window.first - 1, window.last).reduce((total, line) => total + line.length + 1, 0);
      return void pending.push({ id, finding, window, size });
    }
    verdicts.set(id, known);
    stats.cached++;
  });

  await pool(
    toBatches(pending, batchSize, sourceBudget).map((batch) => async () => {
      try {
        const { output, costUsd = 0 } = await read(promptFor(batch, sources));
        stats.costUsd += costUsd;
        const answered = verdictsFrom(output);
        for (const { id } of batch) {
          const verdict = answered.get(id);
          if (verdict === undefined) continue;
          verdicts.set(id, verdict);
          cache?.set(keys.get(id)!, verdict);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!stats.failures.includes(reason)) stats.failures.push(reason);
      }
    }),
    concurrency,
  );

  const kept: Finding[] = [];
  const rejected: Rejection[] = [];
  findings.forEach((finding, id) => {
    const verdict = verdicts.get(id);
    if (verdict === undefined) return void (stats.unverified++, kept.push(finding));
    if (!verdict.keep) return void (stats.rejected++, rejected.push({ finding, reason: verdict.reason }));
    stats.confirmed++;
    kept.push({ ...finding, confirmed: { by: model, reason: verdict.reason } satisfies Confirmation });
  });
  return { findings: kept, rejected, stats };
}
