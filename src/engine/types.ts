import type { JsonValue, Question, ResultFor } from "@typesafe-ai/sdk";
import type { CodeDoc } from "../code/parse.ts";
import type { HtmlDoc } from "../html/parse.ts";

export interface Loc {
  line: number;
  col: number;
  /** Character offsets of the source text to quote in a report, such as an element's start tag. */
  span?: { start: number; end: number };
  /** Indexes into the page's axe results for this element, when an axe report was supplied. */
  axe?: number[];
  /** The third-party widget this element belongs to, which the page's author cannot edit. */
  widget?: "accessibility overlay";
}

/** A small, self-contained slice of a file for Jev to judge. `data` is all the model sees. */
export interface Candidate {
  loc: Loc;
  data: { [key: string]: JsonValue };
  /** Facts for `assess` to compare against. Never sent to the model. */
  meta?: { [key: string]: string };
  /** Set when code alone can decide. The candidate is reported as is and nothing is asked. */
  decided?: Assessment;
}

/** What a rule concludes from an answer: how likely a violation is, and how to describe it. */
export interface Assessment {
  /** Probability from 0 to 1 that the candidate violates the rule. */
  p: number;
  message: string;
  /** A fact code holds that points at the fix, such as the nearest heading or the right `type`. */
  hint?: string;
}

export type Severity = "error" | "warn" | "review";

/** Minimum violation probability for each severity. Below `review`, nothing is reported. */
export type Thresholds = Record<Severity, number>;

export const DEFAULT_THRESHOLDS: Thresholds = { error: 0.8, warn: 0.6, review: 0.4 };

/**
 * Questions a rule asks about one candidate. A question may be left out for a candidate whose answer
 * the rule would ignore, which keeps it out of the request.
 */
export type RuleQuestions = { [name: string]: Question | undefined };

export type AnswersFor<Q extends RuleQuestions> = { [K in keyof Q]: ResultFor<NonNullable<Q[K]>> };

/**
 * Names one field of the candidate the way the instructions must quote it, backticks included.
 * The rule does not know how the state is shaped, only which field it means.
 */
export type Ref = (field: string) => string;

export type Target = "html" | "code";

export interface Rule<Q extends RuleQuestions = RuleQuestions, D = HtmlDoc> {
  id: string;
  /** Which kind of file the rule reads: rendered or source HTML, or JS/TS source. */
  target: Target;
  description: string;
  thresholds?: Partial<Thresholds>;
  /** Deterministic extraction. Anything a parser can decide is decided here. */
  select(doc: D): Candidate[];
  /**
   * One atomic judgement per question, all asked of the same candidate in one request. They cannot see
   * each other's answers. A question code already knows is moot is left out, and never sent.
   */
  questions(ref: Ref, candidate: Candidate): Q;
  /** Combines the independent answers, and any withheld facts, into one violation probability. */
  assess(answers: AnswersFor<Q>, candidate: Candidate): Assessment;
}

/** A rule with its question type erased, so rules of different shapes fit in one list. */
export type AnyRule = Rule<any, any>;

export const defineRule = <const Q extends RuleQuestions>(rule: Omit<Rule<Q, HtmlDoc>, "target">): AnyRule => ({
  ...rule,
  target: "html",
});

export const defineCodeRule = <const Q extends RuleQuestions>(rule: Omit<Rule<Q, CodeDoc>, "target">): AnyRule => ({
  ...rule,
  target: "code",
});

export function severityFor(p: number, thresholds: Partial<Thresholds> = {}): Severity | null {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  if (p >= t.error) return "error";
  if (p >= t.warn) return "warn";
  if (p >= t.review) return "review";
  return null;
}

export type Isolation = "candidate" | "rule" | "file";

/**
 * How one candidate's fields sit in the state it is sent as: `flat` names them at the top level,
 * `wrapped` nests them under `candidate`. Only `candidate` isolation can be flat; the other modes
 * put several candidates in one state and need an index to tell them apart.
 */
export type StateShape = "flat" | "wrapped";

/** One judged candidate, kept in full so the eval harness can inspect raw answers. */
export interface Judgement extends Assessment {
  ruleId: string;
  file: string;
  candidate: Candidate;
  answers: { [name: string]: ResultFor<Question> };
  severity: Severity | null;
}

/**
 * A flag alone moves nobody. A finding carries what was checked and why it was reported, so a person
 * or a coding agent can act on it without re-deriving the judgement. Fixing it is out of scope.
 */
export interface Finding extends Assessment {
  ruleId: string;
  file: string;
  loc: Loc;
  severity: Severity;
  /** The source text the finding is about. */
  snippet?: string;
  /** The words Jev was shown. */
  checked: Candidate["data"];
  /** What Jev answered, per question: a yes-probability, or the chosen option and its probability. */
  measurements: { [question: string]: number | { choice: string; probability: number } };
  /** What code established without the model. */
  facts: { [key: string]: string };
  /** What axe concluded about the same element, when an axe report was supplied. */
  axe?: { rule: string; outcome: "passed" | "failed"; help: string; checksSameThing: boolean }[];
}

export interface RunStats {
  requests: number;
  questions: number;
  cacheHits: number;
  inputTokens: number;
  /** Candidates left unjudged in cache-only mode because an answer they need was never asked. */
  unanswered: number;
}
