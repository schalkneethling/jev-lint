import type { CodeComment, CodeDoc } from "../../code/parse.ts";
import type { Candidate } from "../../engine/types.ts";
import { limits } from "../limits.ts";

/**
 * Long bodies are cut, but far less than they were: a side effect late in a body is exactly what
 * `function-name-matches-body` is for, and at 1,500 characters it was invisible. See `limits.codeChars`.
 */
export const clip = (code: string) => (code.length > limits.codeChars ? `${code.slice(0, limits.codeChars)}\n/* … truncated */` : code);

// Instructions to tools, markers, and licence headers are not statements about the code below them.
const DIRECTIVE = /^(eslint|prettier|biome|istanbul|c8|v8|@ts-|@vite|#|!|todo|fixme|note:|xxx|hack|copyright|\(c\)|spdx|license)/i;

/** Comments that explain a statement. API docs are left out: describing what a function does is their job. */
const explanatory = (comment: CodeComment) => comment.kind !== "doc" && !DIRECTIVE.test(comment.text) && comment.text.length > 3;

/**
 * Both comment rules select the same candidates with the same words, so the engine sends each
 * comment once and asks both questions side by side.
 */
export const commentCandidates = (doc: CodeDoc): Candidate[] =>
  doc.comments.filter(explanatory).map((comment) => ({
    loc: comment.loc,
    data: { comment: comment.text, code: clip(comment.code) },
  }));
