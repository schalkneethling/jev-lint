import { noul } from "@typesafe-ai/sdk";
import { defineCodeRule } from "../../engine/types.ts";
import { commentKind } from "./comment-kind.ts";
import { commentCandidates, makesAClaim } from "./shared.ts";

export default defineCodeRule({
  id: "comment-describes-code",
  description: "A comment should be true of the code it heads.",
  // Experimental. Two blind panels called 2 of 26 of the earlier version's reports right, and its
  // probabilities did not rank them. This version changes what is sent (the section the comment heads, not
  // its first paragraph), what is asked (a contradiction, not accuracy), and what is selected. A panel on
  // unseen code called 2 of its 6 errors and warnings right (findings §31), so it does not run unless asked for.
  optIn: true,
  // The probability is a product of three answers, so it runs lower than a single answer would.
  thresholds: { error: 0.8, warn: 0.65, review: 0.5 },

  // A comment directly above a function or a class documents its contract, which a stub, an interface method,
  // or a long body can each fail to "do" without the comment being wrong. `doc-matches-function` covers those.
  select: (doc) => commentCandidates(doc).filter((candidate) => candidate.meta!.heads !== "declaration"),

  questions: (ref) => ({
    // A section heading, commented-out code, or a note to self says nothing the code could contradict.
    kind: commentKind(ref),
    // Asks for the defect. "Is the comment accurate" alone read loosely worded and partial comments as
    // inaccurate; a contradiction needs the comment to say something specific that the code does differently.
    // Each excuse under `not_contradicted` is a class of report a panel called wrong.
    contradicted: noul(`${ref("comment")} is a comment written above ${ref("code")}. Does the comment state something specific that this code contradicts?`, {
      true: {
        definition: "The comment names a value, a number, an order, a condition, a subject, or an operation, and the code shown visibly does something different with it.",
        examples: [
          "the comment says the list is capped at 20 entries and the code keeps 50",
          "the comment says ascending and the code sorts descending",
          "the comment says the trailing slash is removed and the code only lowercases the string",
        ],
      },
      false: {
        definition: "Nothing the comment says is contradicted by the code shown.",
        not_contradicted: [
          "the comment is vague, gives a reason, or describes only part of the code",
          "the comment talks about code that is not shown, such as a later return value or the rest of the function",
          "the comment explains what a setting does while the code sets it off or leaves it at its default",
          "the comment describes what a called function does inside, even in words that differ from that function's name",
        ],
      },
    }),
    // No criteria: the boundary is plain, and removing them changed nothing (scripts/criteria-experiment.ts).
    accurate: noul(`${ref("comment")} sits directly above ${ref("code")}. Does this code do what the comment says it does?`),
  }),

  assess: ({ kind, contradicted, accurate }, candidate) => ({
    p: makesAClaim(kind) * contradicted.noul * (1 - accurate.noul),
    message: `Comment "${candidate.data.comment}" says something the code below it does not do.`,
  }),
});
