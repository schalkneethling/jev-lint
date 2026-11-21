import { choice, type ChoiceResponse } from "@typesafe-ai/sdk";
import type { Ref } from "../../engine/types.ts";

/**
 * A router: one classification that several rules can read. Rules that classify the same words
 * (`commentCandidates`) share it: the engine sends each comment once and asks this question once, however
 * many rules include it. `comment-describes-code` is its one reader today. A rule carries the probability of the kind it applies to into its own result
 * (a soft branch), so a comment the router is 60% sure about costs 40% of the finding, not all of it.
 *
 * The kinds exist because of what the code corpus showed: a rule about comments that say what code does
 * was reporting section dividers ("Enums", "UMD build"), commented-out code, and notes to self, none of
 * which make a claim the code could contradict.
 */
const KINDS = {
  explains_why: "It gives a reason, a constraint, a trade-off, a warning, or background that the code cannot show by itself. It may also say what the code does, as long as it adds why.",
  describes_behaviour: "It says what the code under it does, checks, or returns, and gives no reason.",
  gives_example: "It shows an example of the input, the output, or a call of the code under it, such as a sample value or the string the code produces.",
  labels_section: 'It is a heading or divider that names a group of code and makes no statement: for example "Helpers", "Enums", "Public API", "Step 2", or the name of the thing declared below.',
  disabled_code: "It is source code that has been commented out, not prose.",
  note_to_self: "It records work still to be done, a question, a doubt, or a reminder: for example a TODO or FIXME, or a remark that something is temporary or should be revisited.",
  other: "None of the above: a licence or authorship line, a directive for a tool, or anything else.",
} as const;

export type CommentKind = keyof typeof KINDS;

export const commentKind = (ref: Ref) => choice(`${ref("comment")} is a comment in source code, written above ${ref("code")}. What kind of comment is it?`, KINDS);

export type CommentKindAnswer = ChoiceResponse<typeof KINDS>;
