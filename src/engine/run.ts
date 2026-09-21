import type { Question, ResultFor } from "@typesafe-ai/sdk";
import { FORM_CHECKS, type AxeResult } from "../axe/report.ts";
import { DYNAMIC, parseJsx } from "../code/jsx.ts";
import { isCodeFile, parseCode } from "../code/parse.ts";
import { parseHtml } from "../html/parse.ts";
import { toBatches, type Batch, type Item } from "./batch.ts";
import { AnswerCache } from "./cache.ts";
import { MODEL, type Ask } from "./client.ts";
import {
  severityFor,
  type AnyRule,
  type Assessment,
  type Finding,
  type Isolation,
  type Judgement,
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
   * Never call the model: answer from the cache, and leave unjudged whatever the cache cannot answer.
   * For re-reading results after a change to code or policy, and for runs with no credentials at hand.
   */
  cacheOnly?: boolean;
  cache?: AnswerCache;
  concurrency?: number;
}

export interface SourceFile {
  path: string;
  source: string;
  /** axe's element-level results for this page, indexed by the numbers stamped on its elements. */
  axe?: AxeResult[];
}

export interface RunResult {
  judgements: Judgement[];
  findings: Finding[];
  stats: RunStats;
}

async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
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
  return { choice: answer.choice, probability: answer.probabilities[answer.choice]! };
}

function toFinding(j: Judgement, severity: Finding["severity"], { source, axe }: SourceFile): Finding {
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
    ...(quoted && { snippet: quoted.length > SNIPPET_LIMIT ? `${quoted.slice(0, SNIPPET_LIMIT)}…` : quoted }),
    checked: j.candidate.data,
    measurements: Object.fromEntries(Object.entries(j.answers).map(([name, answer]) => [name, measurementOf(answer)])),
    facts: { ...j.candidate.meta, ...(j.candidate.loc.widget && { "third-party widget": j.candidate.loc.widget }) },
    ...(onElement && {
      axe: onElement.map(({ rule, outcome, help }) => ({ rule, outcome, help, checksSameThing: (FORM_CHECKS[j.ruleId] ?? []).includes(rule) })),
    }),
  };
}

export async function run(files: SourceFile[], options: RunOptions): Promise<RunResult> {
  const { rules, ask, isolation, maxCandidates, stateShape, cache, cacheOnly = false, concurrency = 8 } = options;
  const stats: RunStats = { requests: 0, questions: 0, cacheHits: 0, inputTokens: 0, unanswered: 0 };

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
      stats.inputTokens += result.usage.input_tokens;
      missing.forEach((key, i) => {
        const answer = result.answers[`q${i}`] as ResultFor<Question>;
        answers.set(key, answer);
        cache?.set(key, answer);
      });
    }
    return keys.map((key) => answers.get(key));
  }

  async function judge(file: string, batch: Batch): Promise<Judgement[]> {
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
      // Only in cache-only mode: a candidate missing any answer is left out, never judged on a guess.
      if (named.some(([, answer]) => answer === undefined)) return (stats.unanswered++, []);
      const answers = Object.fromEntries(named) as Judgement["answers"];
      return [toJudgement(file, item, item.rule.assess(answers, item.candidate), answers)];
    });
  }

  function toJudgement(file: string, item: Item, assessment: Assessment, answers: Judgement["answers"]): Judgement {
    return {
      ...assessment,
      ruleId: item.rule.id,
      file,
      candidate: item.candidate,
      answers,
      severity: severityFor(assessment.p, item.rule.thresholds),
    };
  }

  const decided: Judgement[] = [];
  const perFile = await Promise.all(
    files.map(async (file) => {
      // A JS or TS file is read twice: as code, and for the markup in its JSX, which the HTML rules judge.
      const docs = isCodeFile(file.path)
        ? ([["code", await parseCode(file.path, file.source)], ["html", await parseJsx(file.path, file.source)]] as const)
        : ([["html", parseHtml(file.path, file.source)]] as const);
      const items: Item[] = docs.flatMap(([target, doc]) =>
        rules
          .filter((rule) => rule.target === target)
          .flatMap((rule) => rule.select(doc).map((candidate) => ({ rule, candidate })))
          // Words computed at run time cannot be judged from source; half a label would be a guess.
          .filter(({ candidate }) => !JSON.stringify(candidate.data).includes(DYNAMIC)),
      );
      // Candidates that code already decided are reported directly and never reach the model.
      for (const item of items) if (item.candidate.decided) decided.push(toJudgement(file.path, item, item.candidate.decided, {}));
      return toBatches(items.filter((item) => !item.candidate.decided), isolation, maxCandidates, stateShape).map(
        (batch) => () => judge(file.path, batch),
      );
    }),
  );
  const tasks = perFile.flat();

  const judgements = [...decided, ...(await pool(tasks, concurrency)).flat()];
  const sources = new Map(files.map((file) => [file.path, file]));
  const findings: Finding[] = judgements
    .flatMap((j) => (j.severity === null ? [] : [toFinding(j, j.severity, sources.get(j.file)!)]))
    .sort((a, b) => a.file.localeCompare(b.file) || a.loc.line - b.loc.line || a.loc.col - b.loc.col);

  return { judgements, findings, stats };
}
