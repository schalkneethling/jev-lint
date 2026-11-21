import { choice, noul } from "@typesafe-ai/sdk";
import { defineCodeRule, type Candidate } from "../../engine/types.ts";
import { boundOfCondition, describeBound, differs, LIMIT_KINDS, numberIn, sameLimit, type Bound, type LimitKind } from "./boundary.ts";

// A message with no words about the input ("Invalid", "Error", "Not found") says nothing a condition could contradict.
const SAYS_SOMETHING = /\w+\s+\w+\s+\w+/;

export default defineCodeRule({
  id: "error-message-matches-guard",
  description: "An error message should describe the condition that throws it.",
  // Experimental. A blind panel called 0 of 5 of the first version's errors and warnings right. The causes
  // were what the condition alone cannot show (an early return above the guard, a helper's meaning), a
  // question that condemned a message for saying more than its one condition tests, and boundaries Jev does
  // not weigh (`<` against "not greater than"). All three are addressed below.
  optIn: true,
  // A product of two answers, so it runs lower than a single answer would.
  // Two blind panels on unseen code called 0 of 17 reports below 0.8 right (findings §31 and §32): the message
  // matched the condition once the lines above the guard were read. Below 0.7 nothing is reported.
  thresholds: { error: 0.9, warn: 0.8, review: 0.7 },

  // `if (!user.email) throw new Error("name is required")`, and `assert(count >= 20, "Must be greater than 20")`,
  // where the message is raised when the check fails: the parser pairs the condition with the message,
  // and whether the words fit the test is what is left for Jev. Found by reading real files, not invented:
  // 18 of the 184 defects that model reviewers found by reading the code corpus, and that a second reviewer
  // did not refute, were an error, log or assertion message at odds with what triggers it.
  select: (doc) => {
    // Split validation throws one message from several guards (`typeof s !== "string"`, then `s.length === 0`,
    // both "must be a non-empty string"). The message describes them together, so they are one candidate,
    // reported at the first of them. Only within one function: the same words in another function are about
    // another value.
    const groups = Map.groupBy(doc.guards.filter((guard) => SAYS_SOMETHING.test(guard.message)), (guard) => `${guard.scope}\0${guard.message}`);
    return [...groups.values()].map((guards): Candidate => {
      const first = guards[0]!;
      const last = guards.at(-1)!;
      // A numeric limit is compared in code. The condition's side of it is read here, when a lone guard is
      // one comparison with a number and its message holds one number close to it. The message's side is
      // Jev's to classify (`limit` below).
      const bound = guards.length === 1 ? boundOfCondition(first.check ?? first.condition, first.form === "assert" ? "accepted" : "rejected") : undefined;
      const said = numberIn(first.message);
      const comparable = bound !== undefined && said !== undefined && sameLimit(bound, said);
      return {
        // From the first guard to the last, so that a change to any of them reaches the candidate.
        loc: { ...first.loc, ...(first.loc.lines && last.loc.lines && { lines: { first: first.loc.lines.first, last: last.loc.lines.last } }) },
        data: {
          // What had to be true to get here is part of what the message may be describing: "Expected no
          // definition, but got one" under `expected === undefined` is right inside `if (definition !== undefined)`.
          ...(first.reachedWhen.length > 0 && { only_reached_when: first.reachedWhen.join(" && ") }),
          condition: guards.length === 1 ? first.condition : guards.map((guard) => `(${guard.condition})`).join(" || "),
          error_message: first.message,
        },
        meta: { guards: String(guards.length), ...(comparable && { accepts: describeBound(bound), bound: JSON.stringify(bound), said: String(said) }) },
      };
    });
  },

  questions: (ref, candidate) => ({
    // About the message alone, so that it cannot collapse into the question it gates.
    states_requirement: noul(
      `${ref("error_message")} is the message of an error thrown in source code. Classify the message by itself: does it state a specific requirement, limit, or reason?`,
      {
        true: 'It says what a value must be, must not be, or why it was rejected: for example "must be at least 3", "is required", "cannot be empty", "expected a string", "already exists".',
        false: 'It only announces a failure without saying what was required: for example "Invalid input", "Something went wrong", "Failed to load", "Unsupported operation".',
      },
    ),
    // One direction only. The earlier wording also condemned a message that states more than its condition
    // tests, which is every message shared by two guards.
    contradicts: noul(
      `In source code, an error with ${ref("error_message")} is thrown exactly when ${ref("condition")} is true${
        "only_reached_when" in candidate.data ? `, in code that runs only when ${ref("only_reached_when")} is true` : ""
      }. Does the message describe the rejected value in a way the condition contradicts?`,
      {
        true: {
          definition: "The condition rejects some value that the message describes as acceptable, or the message is about a different value than the one the condition tests.",
          examples: ['condition `list.length > 0`, message "list must not be empty"', 'condition `!user.email`, message "name is required"', 'condition `typeof id === "string"`, message "id must be a string"'],
        },
        false: {
          definition: "Every value the condition rejects is one the message calls wrong.",
          still_consistent: [
            'the message states more requirements than this condition tests, such as "must be a non-empty string" under `typeof s !== "string"`; other checks may test the rest',
            'the message names the value by a description or a fuller name, such as `cb` as "callback" or `opts.out` as "output directory"',
            "the condition calls helpers or reads variables whose meaning is not shown; assume they do what their names say",
          ],
        },
      },
    ),
    // Jev classifies, code compares. Asked only where code has a bound to compare with: about the message
    // alone, so that the condition cannot pull the answer towards agreeing with it.
    limit: candidate.meta?.bound
      ? choice(`${ref("error_message")} is the message of an error thrown in source code, and it contains one number. Classify the message by itself: what does it require of the value, relative to that number?`, LIMIT_KINDS)
      : undefined,
  }),

  assess: ({ states_requirement, contradicts, limit }, candidate) => {
    const contradiction = states_requirement.noul * contradicts.noul;
    const general = { p: contradiction, message: `Error message "${candidate.data.error_message}" does not match the condition that throws it: ${candidate.data.condition}` };
    if (!limit || !candidate.meta?.bound) return general;
    const bound = JSON.parse(candidate.meta.bound) as Bound;
    const said = Number(candidate.meta.said);
    // The probability that the message states a limit the code does not have: every kind that would differ, added up.
    const differing = (Object.keys(LIMIT_KINDS) as LimitKind[]).filter((kind) => differs(bound, kind, said));
    const mismatch = differing.reduce((sum, kind) => sum + limit.probabilities[kind], 0);
    if (mismatch <= contradiction || differing.length === 0) return general;
    // The finding names the likeliest reading that differs, which need not be the likeliest reading overall.
    const likeliest = differing.reduce((best, kind) => (limit.probabilities[kind] > limit.probabilities[best] ? kind : best));
    const stated = `${likeliest.replace("_", " ")} ${said}`;
    return { p: mismatch, message: `Error message "${candidate.data.error_message}" asks for ${stated}, and the code accepts ${candidate.meta.accepts}.`, hint: `The condition is: ${candidate.data.condition}` };
  },
});
