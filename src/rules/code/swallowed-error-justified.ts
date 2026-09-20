import { noul } from "@typesafe-ai/sdk";
import { defineCodeRule, type Candidate } from "../../engine/types.ts";
import { clip } from "./shared.ts";

export default defineCodeRule({
  id: "swallowed-error-justified",
  description: "An empty catch block should say why ignoring the error is safe.",

  // ESLint's no-empty is satisfied by any comment inside the block, including "// ignore". Whether a
  // block is empty is the parser's call; whether the comment is a reason is the part left for Jev.
  select: (doc) =>
    doc.emptyCatches.map((handler): Candidate => {
      const candidate: Candidate = { loc: handler.loc, data: { comment_in_empty_catch: handler.comment, code_in_try_block: clip(handler.tried) } };
      if (handler.comment === "") candidate.decided = { p: 0.85, message: "This catch block swallows the error and says nothing about why that is safe." };
      return candidate;
    }),

  questions: (ref) => ({
    gives_reason: noul(
      `${ref("code_in_try_block")} can throw, and the catch block ignores the error. ${ref("comment_in_empty_catch")} is the only thing in the catch block. Does the comment give a reason why ignoring this error is safe?`,
      {
        true: "It says why a failure here is expected, harmless, or handled elsewhere: for example the value is optional, a fallback follows, or the feature is a progressive enhancement.",
        false: 'It only states that the error is ignored, without saying why: for example "ignore", "noop", "swallow", "nothing to do", "TODO", or "should never happen".',
      },
    ),
  }),

  assess: ({ gives_reason }, candidate) => ({
    p: 1 - gives_reason.noul,
    message: `The comment "${candidate.data.comment_in_empty_catch}" does not say why ignoring this error is safe.`,
  }),
});
