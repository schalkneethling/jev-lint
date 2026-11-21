import type { CodeComment, CodeDoc } from "../../code/parse.ts";
import type { Candidate } from "../../engine/types.ts";
import type { CommentKindAnswer } from "./comment-kind.ts";
import { limits } from "../limits.ts";

/**
 * Long bodies are cut, but far less than they were: a side effect late in a body is exactly what
 * `function-name-matches-body` is for, and at 1,500 characters it was invisible. See `limits.codeChars`.
 */
export const clip = (code: string) => (code.length > limits.codeChars ? `${code.slice(0, limits.codeChars)}\n/* … truncated */` : code);

// Instructions to tools, markers, and licence headers are not statements about the code below them.
// Whole words only: "Todos are loaded lazily" and "Licenses the seat to a user" are prose that starts like a marker.
export const DIRECTIVE = /^(jev-lint|eslint|prettier|biome|istanbul|c8|v8|@ts-|@vite|#|!|note:|\(c\)|(?:todo|fixme|xxx|hack|copyright|spdx|license)\b)/i;

/**
 * Comments that explain a statement. API docs are left out: describing what a function does is their job.
 * So is a comment over code the parser could not read (pseudo-code in a cheat sheet): the words it would be
 * classified against are fragments. So is a comment whose own text parses as code: a statement someone
 * commented out, or a one-word label.
 */
const explanatory = (comment: CodeComment) => comment.kind !== "doc" && !DIRECTIVE.test(comment.text) && comment.text.length > 3 && !comment.unparsed && !comment.isCode;

/**
 * The candidates a comment rule draws from. A rule narrows them in its own way; rules that keep the same
 * candidate carry the same words, so the engine sends that comment once and asks their questions side by side.
 */
export const commentCandidates = (doc: CodeDoc): Candidate[] =>
  doc.comments.filter(explanatory).map((comment) => ({
    loc: comment.loc,
    // The section, not the first paragraph: a comment that heads a block is true or false of the block.
    data: { comment: comment.text, code: clip(comment.section) },
    meta: { statements: comment.section.includes("\n") ? "several" : "one", heads: comment.headsDeclaration ? "declaration" : "statements" },
  }));

/** Test files hold stubs, spies and fixtures: functions whose names are dictated by what they stand in for. */
export const isTestFile = (path: string) => /(^|[\/._-])(tests?|specs?|__tests__|__mocks__|mocks?|fixtures?|e2e|cypress)([\/._-]|$)/i.test(path);

/**
 * How likely the comment says something the code could contradict: a reason, a description, or an example.
 * An example of output is a claim too: `// "…then $0.02/call"` above a template that produces "…each".
 */
export const makesAClaim = (kind: CommentKindAnswer): number => kind.probabilities.explains_why + kind.probabilities.describes_behaviour + kind.probabilities.gives_example;
