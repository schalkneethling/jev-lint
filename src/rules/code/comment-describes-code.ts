import { noul } from "@typesafe-ai/sdk";
import { defineCodeRule } from "../../engine/types.ts";
import { commentCandidates } from "./shared.ts";

export default defineCodeRule({
  id: "comment-describes-code",
  description: "A comment should be true of the code directly below it.",
  // The probability is a product of two answers, so it runs lower than a single answer would.
  thresholds: { error: 0.85, warn: 0.7, review: 0.5 },

  select: commentCandidates,

  // Accuracy can only be classified for a comment that says what the code does. A comment that gives a
  // reason is not something the code can confirm, so asking whether it is "true of the code" misfires.
  questions: (ref) => ({
    // About the comment alone. Phrased against the code, a stale comment "does not state what this
    // code does", and this question collapses into the accuracy question it is meant to gate.
    describes_behaviour: noul(
      `${ref("comment")} is a comment in source code. Classify the comment by itself and ignore any code: does it describe an operation that code performs?`,
      {
        true: "It names an operation, such as removing, sorting, retrying, caching, checking, skipping, or returning something, even if it also gives a reason.",
        false: "It names no operation. It only explains why, gives background, states a fact about the domain, warns, or records a decision.",
      },
    ),
    // No criteria: the boundary is plain, and removing them changed nothing (scripts/criteria-experiment.ts).
    accurate: noul(`${ref("comment")} sits directly above ${ref("code")}. Does this code do what the comment says it does?`),
  }),

  assess: ({ describes_behaviour, accurate }, candidate) => ({
    p: describes_behaviour.noul * (1 - accurate.noul),
    message: `Comment "${candidate.data.comment}" says something the code below it does not do.`,
  }),
});
