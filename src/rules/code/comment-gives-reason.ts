import { noul } from "@typesafe-ai/sdk";
import { defineCodeRule } from "../../engine/types.ts";
import { commentCandidates } from "./shared.ts";

export default defineCodeRule({
  id: "comment-gives-reason",
  description: "A comment should say why, not restate what the code already says.",
  // A redundant comment costs little today. It is reported because it is the comment most likely to go stale.
  thresholds: { error: 1.1, warn: 0.85, review: 0.7 },

  select: commentCandidates,

  questions: (ref) => ({
    only_restates: noul(
      `${ref("comment")} sits directly above ${ref("code")}. Does the comment only restate what the code itself already says?`,
      {
        true: "It paraphrases the operation the code performs. A reader who understands the language would learn nothing from it that the code does not show.",
        false:
          "It adds something the code cannot say: why this is done, its purpose, a constraint, a consequence, a warning, a reference, or what a non-obvious expression means in the problem domain.",
      },
    ),
  }),

  assess: ({ only_restates }, candidate) => ({
    p: only_restates.noul,
    message: `Comment "${candidate.data.comment}" restates the code. Say why, or remove it.`,
  }),
});
