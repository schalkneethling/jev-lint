import { relative, resolve } from "node:path";
import type { Question, ResultFor } from "@typesafe-ai/sdk";
import { FORM_CHECKS, type AxeResult } from "../axe/report.ts";
import { DYNAMIC, parseJsx } from "../code/jsx.ts";
import { isCodeFile, parseCode } from "../code/parse.ts";
import { parseHtml } from "../html/parse.ts";
import { fingerprintOf } from "./baseline.ts";
import { toBatches, type Batch, type Item } from "./batch.ts";
import { AnswerCache } from "./cache.ts";
import { touches, type LineRanges } from "./changed.ts";
import { MODEL, type Ask } from "./client.ts";
import { readSuppressions, suppressionsFrom, type Suppressions } from "./suppress.ts";
import {
  severityFor,
  type AnyRule,
  type Assessment,
  type Candidate,
  type Finding,
  type Isolation,
  type Classification,
  type RuleQuestions,
  type RunStats,
  type StateShape,
} from "./types.ts";

export interface RunOptions {
  rules: AnyRule[];
  ask: Ask;
  isolation: Isolation;
  /** Upper bound on candidates sharing one state in `rule` and `file` isolation. */
  maxCandidates?: number;
  /** `candidate` isolation only: whether the candidate's fields are named directly or nested under `candidate`. */
  stateShape?: StateShape;
  /**
   * Never call the model: answer from the cache, and leave unclassified whatever the cache cannot answer.
   * For re-reading results after a change to code or policy, and for runs with no credentials at hand.
   */
  cacheOnly?: boolean;
  cache?: AnswerCache;
  concurrency?: number;
  /**
   * Changed lines per file path. When given, only candidates whose lines overlap a change are classified,
   * and a file that is not listed has none. This is the mode for a pull request or a pre-commit hook: the
   * words most likely to have gone false are the ones next to code that just changed.
   */
  changed?: Map<string, LineRanges>;
  /** The project's conventions, in plain sentences, for the rules that read them (`Rule.readsConventions`). */
  conventions?: string[];
  /**
   * Fingerprints of findings the project has already recorded (`baseline.ts`), and the directory its file
   * paths are relative to. A finding in the baseline is counted and not reported.
   */
  baseline?: { known: Set<string>; root: string };
  /**
   * The directory being linted. Rules that read a file's path (is this a test file?) see it relative to this
   * directory, so that a project checked out under `~/work/test-harness/` is not taken for one big test.
   */
  root?: string;
}

export interface RunResult {
  classifications: Classification[];
  /** Every classification that reached a severity and was not switched off in the source: what a new baseline records. */
  reported: Classification[];
  findings: Finding[];
  stats: RunStats;
}

export interface SourceFile {
  path: string;
  source: string;
  /** axe's element-level results for this page, indexed by the numbers stamped on its elements. */
  axe?: AxeResult[];
}

/** Runs the tasks at most `limit` at a time and returns their results in the order given. */
export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

const SNIPPET_LIMIT = 160;

function measurementOf(answer: ResultFor<Question>): Finding["measurements"][string] {
  if (answer.type === "noul") return answer.noul;
  if (answer.type === "score") return answer.score;
  // Rules classify words. A Box locates something in an image, which no rule asks for.
  if (answer.type === "box") throw new Error("A rule asked a Box question; rules classify text only.");
  return { choice: answer.choice, probability: answer.probabilities[answer.choice]! };
}

function toFinding(j: Classification, severity: Finding["severity"], { source, axe }: SourceFile): Finding {
  const { span } = j.candidate.loc;
  const quoted = span && source.slice(span.start, span.end).replace(/ data-jev-(axe|not-visible)="[^"]*"/g, "").replace(/\s+/g, " ");
  const onElement = axe && (j.candidate.loc.axe ?? []).map((index) => axe[index]!);
  return {
    ruleId: j.ruleId,
    file: j.file,
    loc: j.candidate.loc,
    severity,
    p: j.p,
    message: j.message,
    ...(j.hint !== undefined && { hint: j.hint }),
    ...(j.pattern !== undefined && { pattern: j.pattern }),
    ...(quoted && { snippet: quoted.length > SNIPPET_LIMIT ? `${quoted.slice(0, SNIPPET_LIMIT)}…` : quoted }),
    checked: j.candidate.data,
    measurements: Object.fromEntries(Object.entries(j.answers).map(([name, answer]) => [name, measurementOf(answer)])),
    facts: { ...j.candidate.meta, ...(j.candidate.loc.widget && { "third-party widget": j.candidate.loc.widget }) },
    ...(onElement && {
      axe: onElement.map(({ rule, outcome, help }) => ({ rule, outcome, help, checksSameThing: (FORM_CHECKS[j.ruleId] ?? []).includes(rule) })),
    }),
  };
}

/**
 * A page that repeats its visible text in two hundred aria-labels has one habit, not two hundred defects.
 * Classifications stay per element; only the report merges them, at the first place the pattern occurs.
 */
export function mergePatterns(findings: Finding[]): Finding[] {
  const groups = Map.groupBy(findings, (f) => (f.pattern === undefined ? Symbol() : `${f.file}\0${f.ruleId}\0${f.severity}\0${f.pattern}`));
  return [...groups.values()].map((group) => {
    const [first] = group;
    if (group.length === 1) return first!;
    return {
      ...first!,
      p: Math.max(...group.map((f) => f.p)),
      message: `${group.length} elements in this file: ${first!.pattern}`,
      occurrences: group.map(({ loc, snippet, checked }) => ({ loc, ...(snippet !== undefined && { snippet }), checked })),
    };
  });
}

/** A file's path as rules see it: relative to the linted directory when the file is inside it. */
function nameIn(root: string | undefined, path: string): string {
  if (root === undefined) return path;
  const inside = relative(resolve(root), resolve(path));
  return inside.startsWith("..") ? path : inside;
}

/** Gives each rule that derives facts across candidates its own classifications, and takes back what it restates. */
function reconciled(classifications: Classification[], rules: AnyRule[]): Classification[] {
  const restated = new Map<Classification, Classification>();
  for (const rule of rules) {
    if (!rule.reconcile) continue;
    const mine = classifications.filter((j) => j.ruleId === rule.id);
    const assessments = rule.reconcile(mine.map((j) => ({ candidate: j.candidate, file: j.file, assessment: { p: j.p, message: j.message, ...(j.hint !== undefined && { hint: j.hint }), ...(j.pattern !== undefined && { pattern: j.pattern }) } })));
    mine.forEach((j, i) => restated.set(j, { ...j, ...assessments[i]!, severity: severityFor(assessments[i]!.p, rule.thresholds) }));
  }
  return classifications.map((j) => restated.get(j) ?? j);
}

export async function run(files: SourceFile[], options: RunOptions): Promise<RunResult> {
  const { rules, ask, isolation, maxCandidates, stateShape, cache, cacheOnly = false, concurrency = 8, changed, conventions = [], baseline, root } = options;
  const stats: RunStats = { requests: 0, questions: 0, cacheHits: 0, inputTokens: 0, unanswered: 0, suppressed: 0, unchanged: 0, baselined: 0 };

  // Identical candidates (the same "Read more" link thirty times) produce identical requests.
  // Sharing the in-flight promise means each distinct request is sent once per run.
  const inflight = new Map<string, Promise<(ResultFor<Question> | undefined)[]>>();

  async function answersFor(batch: Batch, questions: Question[]): Promise<(ResultFor<Question> | undefined)[]> {
    const keys = questions.map((question) => AnswerCache.key(MODEL, batch.state, question));
    const answers = new Map<string, ResultFor<Question> | undefined>(keys.map((key) => [key, cache?.get(key)]));
    // The same question about the same words is asked once, however many elements share it.
    const missing = [...answers].flatMap(([key, answer]) => (answer === undefined ? [key] : []));
    stats.cacheHits += keys.length - missing.length;
    if (missing.length > 0 && !cacheOnly) {
      const byKey = new Map(keys.map((key, i) => [key, questions[i]!]));
      const result = await ask(batch.state, Object.fromEntries(missing.map((key, i) => [`q${i}`, byKey.get(key)!])));
      stats.requests += 1;
      stats.inputTokens += result.usage.input_tokens ?? 0;
      missing.forEach((key, i) => {
        const answer = result.answers[`q${i}`] as ResultFor<Question>;
        answers.set(key, answer);
        cache?.set(key, answer);
      });
    }
    return keys.map((key) => answers.get(key));
  }

  async function classify(file: string, batch: Batch): Promise<Classification[]> {
    // A rule leaves out the questions it would ignore for this candidate, so the set varies per entry.
    const perEntry = batch.entries.map((entry) =>
      Object.entries(entry.item.rule.questions(entry.ref, entry.item.candidate) as RuleQuestions).filter(
        (named): named is [string, Question] => named[1] !== undefined,
      ),
    );
    const questions: Question[] = perEntry.flatMap((named) => named.map(([, question]) => question));
    stats.questions += questions.length;
    const requestKey = JSON.stringify([batch.state, questions]);
    let pending = inflight.get(requestKey);
    if (pending === undefined) {
      pending = answersFor(batch, questions);
      inflight.set(requestKey, pending);
    } else {
      stats.cacheHits += questions.length;
    }
    const flat = await pending;

    let next = 0;
    return batch.entries.flatMap(({ item }, i) => {
      const named = perEntry[i]!.map(([name]) => [name, flat[next++]] as const);
      // Only in cache-only mode: a candidate missing any answer is left out, never classified on a guess.
      if (named.some(([, answer]) => answer === undefined)) return (stats.unanswered++, []);
      const answers = Object.fromEntries(named) as Classification["answers"];
      return [toClassification(file, item, item.rule.assess(answers, item.candidate), answers)];
    });
  }

  function toClassification(file: string, item: Item, assessment: Assessment, answers: Classification["answers"]): Classification {
    return {
      ...assessment,
      ruleId: item.rule.id,
      file,
      candidate: item.candidate,
      answers,
      severity: severityFor(assessment.p, item.rule.thresholds),
    };
  }

  const decided: Classification[] = [];
  const codeSuppressions = new Map<string, Suppressions>();
  const perFile = await Promise.all(
    files.map(async (file) => {
      // A JS or TS file is read twice: as code, and for the markup in its JSX, which the HTML rules classify.
      const code = isCodeFile(file.path) ? await parseCode(file.path, file.source) : undefined;
      if (code) codeSuppressions.set(file.path, suppressionsFrom(code.rawComments));
      const docs = code
        ? ([["code", { ...code, file: nameIn(root, file.path) }], ["html", await parseJsx(file.path, file.source)]] as const)
        : ([["html", parseHtml(file.path, file.source)]] as const);
      const selected: Item[] = docs.flatMap(([target, doc]) =>
        rules
          .filter((rule) => rule.target === target)
          .flatMap((rule) =>
            rule.select(doc).map((candidate: Candidate) => ({
              rule,
              // Conventions are facts about the project that the candidate's own words cannot show.
              candidate: rule.readsConventions && conventions.length > 0 ? { ...candidate, data: { ...candidate.data, project_conventions: conventions } } : candidate,
            })),
          )
          // Words computed at run time cannot be classified from source; half a label would be a guess.
          .filter(({ candidate }) => !JSON.stringify(candidate.data).includes(DYNAMIC)),
      );
      const ranges = changed?.get(file.path) ?? [];
      // A candidate with no recorded lines is kept: leaving it out would be a silent loss of recall.
      const items = changed ? selected.filter(({ candidate }) => !candidate.loc.lines || touches(ranges, candidate.loc.lines)) : selected;
      stats.unchanged += selected.length - items.length;
      // Candidates that code already decided are reported directly and never reach the model.
      for (const item of items) if (item.candidate.decided) decided.push(toClassification(file.path, item, item.candidate.decided, {}));
      return toBatches(items.filter((item) => !item.candidate.decided), isolation, maxCandidates, stateShape).map(
        (batch) => () => classify(file.path, batch),
      );
    }),
  );
  const tasks = perFile.flat();

  const classifications = reconciled([...decided, ...(await pool(tasks, concurrency)).flat()], rules);
  const sources = new Map(files.map((file) => [file.path, file]));
  // A code file's directives come from the comments its parser found; markup is scanned for them.
  const suppressions = new Map(files.map((file) => [file.path, codeSuppressions.get(file.path) ?? readSuppressions(file.source)]));
  const reported = classifications.filter((j) => {
    if (j.severity === null) return false;
    const { line, lines } = j.candidate.loc;
    const off = suppressions.get(j.file)!.covers(j.ruleId, line, ...(lines ? [lines.first] : []));
    if (off) stats.suppressed++;
    return !off;
  });
  const fresh = baseline ? reported.filter((j) => !baseline.known.has(fingerprintOf(j, baseline.root))) : reported;
  stats.baselined = reported.length - fresh.length;
  const findings: Finding[] = mergePatterns(fresh.map((j) => toFinding(j, j.severity!, sources.get(j.file)!)))
    .sort((a, b) => a.file.localeCompare(b.file) || a.loc.line - b.loc.line || a.loc.col - b.loc.col);

  return { classifications, reported, findings, stats };
}
