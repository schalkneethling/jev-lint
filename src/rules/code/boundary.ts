/**
 * Numbers are code's to compare, and words are Jev's to read. `assert(parsed >= 500, "Must be greater than
 * 500ms")` is a mismatch between a bound in a condition and a bound in a sentence. The condition's bound is
 * read here, exactly. What the sentence asks for is a classification (`error-message-matches-guard` asks
 * Jev which kind of limit the message states), and this file then compares the two.
 *
 * An earlier version read the sentence with patterns as well ("at least N", "no more than N", a modal verb
 * before it). Three reviews each found correct messages it reported: the "cannot" of one clause negating the
 * limit in the next, "no bigger than" read as "bigger than", "must never be more than", seconds against
 * milliseconds. A pattern over prose is a meaning judgement wearing a regex, and that finding was raised
 * with no model in the loop to soften it. The patterns are gone.
 */
export interface Bound {
  /** `min`: the value must be this or above. `max`: this or below. */
  side: "min" | "max";
  value: number;
  inclusive: boolean;
}

const COMPARISON = /^\s*(?:(?<left>[\w$.#?()[\]'"]+?)\s*(?<op><=|>=|<|>)\s*(?<number>-?\d[\d_]*(?:\.\d+)?)|(?<number2>-?\d[\d_]*(?:\.\d+)?)\s*(?<op2><=|>=|<|>)\s*(?<right>[\w$.#?()[\]'"]+?))\s*$/;

const FLIP: Record<string, string> = { "<": ">", ">": "<", "<=": ">=", ">=": "<=" };
const NEGATE: Record<string, string> = { "<": ">=", ">": "<=", "<=": ">", ">=": "<" };

const toBound = (op: string, value: number): Bound => ({ side: op.startsWith(">") ? "min" : "max", value, inclusive: op.endsWith("=") });

/**
 * The bound a value must meet to be accepted, given a comparison and whether the comparison holding means
 * the value is accepted (`assert(x >= 20, …)`) or rejected (`if (x > 50) throw …`). `undefined` unless the
 * condition is one comparison of something with a number.
 */
export function boundOfCondition(comparison: string, holdsWhen: "accepted" | "rejected"): Bound | undefined {
  const match = COMPARISON.exec(comparison);
  if (!match?.groups) return undefined;
  const { op, number, op2, number2 } = match.groups;
  // `20 <= x` is `x >= 20`.
  const written = op ?? FLIP[op2!]!;
  const value = Number((number ?? number2!).replaceAll("_", ""));
  return toBound(holdsWhen === "accepted" ? written : NEGATE[written]!, value);
}

/** The one number a message contains, or `undefined` when it has none or several (a range, a count and an index). */
export function numberIn(message: string): number | undefined {
  // Not the digits of an interpolated expression (`${MAX_ITEMS_V2}`), and not digits that are part of a
  // word or a dotted name (`sha256`, `utf8`, `v2.1`): neither is a number the message states.
  const prose = message.replace(/\$\{[^}]*\}/g, " ");
  // A unit may follow directly ("500ms"); a word character may not come before.
  const numbers = prose.match(/(?<![\w$.])-?\d[\d,_]*(?:\.\d+)?/g) ?? [];
  if (numbers.length !== 1) return undefined;
  const value = Number(numbers[0]!.replaceAll(/[,_]/g, ""));
  return Number.isFinite(value) ? value : undefined;
}

/** The kinds of limit a message can state about a value and the number in it. Jev picks one; code compares. */
export const LIMIT_KINDS = {
  at_least: "The value must be that number or more: at least, minimum, no less than, that number or greater.",
  more_than: "The value must be strictly greater than that number: more than, greater than, above, must exceed.",
  at_most: "The value must be that number or less: at most, maximum, up to, no more than, cannot exceed.",
  less_than: "The value must be strictly less than that number: less than, fewer than, below, under.",
  not_a_limit:
    "None of the above. The number is not a limit on the value, the message describes what went wrong and not what is required, the limit is on something else, or the number is in a unit the code may hold differently (seconds against milliseconds, a percentage, megabytes).",
} as const;

export type LimitKind = keyof typeof LIMIT_KINDS;

const KIND_BOUND: Record<Exclude<LimitKind, "not_a_limit">, { side: Bound["side"]; inclusive: boolean }> = {
  at_least: { side: "min", inclusive: true },
  more_than: { side: "min", inclusive: false },
  at_most: { side: "max", inclusive: true },
  less_than: { side: "max", inclusive: false },
};

/** The same bound on whole numbers: "more than 19" and "at least 20" accept the same counts. */
const onIntegers = (bound: Bound) => (bound.inclusive ? bound.value : bound.side === "min" ? bound.value + 1 : bound.value - 1);

export const describeBound = (bound: Bound) => `${bound.side === "min" ? (bound.inclusive ? "at least" : "more than") : bound.inclusive ? "at most" : "less than"} ${bound.value}`;

/**
 * Whether a message that states `kind` of limit at `value` asks for a different bound than `code` accepts.
 * Bounds that differ only as "more than 19" and "at least 20" do agree: most limits are on counts and
 * lengths, and reporting those would be wrong more often than right.
 */
export function differs(code: Bound, kind: LimitKind, value: number): boolean {
  if (kind === "not_a_limit") return false;
  const said: Bound = { ...KIND_BOUND[kind], value };
  return code.side !== said.side || onIntegers(code) !== onIntegers(said);
}

/**
 * Whether the two numbers are close enough to be the same limit. When they are far apart the message may
 * be in another unit, or about another quantity, and the comparison says nothing.
 */
export const sameLimit = (code: Bound, value: number) => Math.abs(code.value - value) <= 1;
