import { noul } from "@typesafe-ai/sdk";
import type { CodeFunction } from "../../code/parse.ts";
import { defineCodeRule, type Candidate } from "../../engine/types.ts";
import { clip, DIRECTIVE } from "./shared.ts";

/** The prose of a doc comment: what comes before its first tag. Tags are a type checker's and a linter's to verify. */
const summaryOf = (doc: string) => doc.split(/(?:^|\s)@\w+/)[0]!.trim();

// A summary of one or two words ("Constructor.", "Helper") claims nothing the body could contradict.
const SAYS_SOMETHING = /\w+\s+\w+\s+\w+/;

// A summary that points elsewhere ("Deprecated.", "Use createStore instead.", "Alias of …") makes no claim about this body.
const POINTS_ELSEWHERE = /^(deprecated\b|use\s+\S+\s+instead|alias\s+(of|for)\b|see\s+)/i;

// `@returns {Type} description`. The type is optional, and so is the description.
const RETURNS = /@returns?\s+(?:\{([^}]*)\})?\s*([^@]*)/;
// Ways of documenting that nothing comes back, which a body that returns nothing agrees with.
const NOTHING = /^(void|undefined|never|null|this|Promise\.?<\s*(void|undefined)\s*>)$/i;
const SAYS_NOTHING = /^(nothing|none|void|undefined)\b/i;

/**
 * What the doc comment says the function returns, when it says something comes back. One tag is the
 * parser's to check after all: whether a value is returned at all is a fact about the syntax tree.
 */
function promisedReturn(fn: CodeFunction): string | undefined {
  const tag = RETURNS.exec(fn.doc);
  if (!tag) return undefined;
  // `!Promise<void>` and `?string` are Closure's non-null and nullable marks on the same type.
  const type = (tag[1] ?? "").trim().replace(/^[!?]/, "");
  const description = (tag[2] ?? "").trim();
  if (NOTHING.test(type) || SAYS_NOTHING.test(description) || (type === "" && description === "")) return undefined;
  // An async function returns a promise with or without a `return`. Unless the tag names what the promise
  // resolves to, in a type (`{Promise<Settings>}`), "a promise" is all it promised, and it kept that.
  // The type may itself be generic (`Promise<Array<Item>>`), and `Promise<null>` resolves to nothing, as a bare `null` returns nothing.
  if (fn.async && !/^Promise\.?<(?!\s*(?:void|undefined|null)\s*>).+>$/is.test(type)) return undefined;
  return type === "" ? description : `{${type}}`;
}

// A review: the fact is certain, and a value can still leave through a callback the tag forgot to mention.
const RETURN_PROMISED = 0.7;

export default defineCodeRule({
  id: "doc-matches-function",
  compares: [{ field: "body", label: "The function" }],
  description: "A function's documentation comment should be true of the function.",
  // A product of two answers about real functions, which often do a little more than their summary says.
  // Few candidates and few reports, so this is the least measured default rule. Of 410 functions with a
  // JSDoc block in the code corpus, 2 scored above 0.5: a blind panel called 1 right and 1 wrong (at 0.70),
  // and called real 2 that scored 0.47 and 0.38. Hence a wide review band, which reports 7 of the 410.
  // Plain block comments and runs of line comments above a function count as documentation since then;
  // those candidates have not been classified yet.
  thresholds: { error: 0.85, warn: 0.75, review: 0.35 },

  // `comment-describes-code` leaves doc blocks out because describing what a function does is their job. That job can
  // still be done wrongly: a doc block copied from a sibling function, or left behind when the body changed.
  select: (doc) =>
    doc.functions
      // A stub's documentation describes the contract an implementation must meet, not its own empty body.
      .filter((fn) => !fn.stub && fn.body.replace(/\s/g, "") !== "{}")
      .map((fn) => ({ fn, summary: summaryOf(fn.doc) }))
      // A TODO, a tool directive or a licence line above a function is not its documentation.
      // A doc block that is all tags has no summary to classify, and can still promise a return value.
      .filter(({ fn, summary }) => (SAYS_SOMETHING.test(summary) && !POINTS_ELSEWHERE.test(summary) && !DIRECTIVE.test(summary)) || (promisedReturn(fn) !== undefined && !fn.returnsValue))
      .map(({ fn, summary }): Candidate => {
        const candidate: Candidate = { loc: fn.loc, data: { documentation: summary, name: fn.name, body: clip(fn.body) } };
        const promised = promisedReturn(fn);
        // In two code corpora 304 functions had a `@returns` tag. One of them promised a value and returned
        // none, and a reviewer had independently listed that one as a defect.
        return promised !== undefined && !fn.returnsValue
          ? { ...candidate, decided: { p: RETURN_PROMISED, message: `The documentation of "${fn.name}" says it returns ${promised}, and no path through it returns a value.` } }
          : candidate;
      }),

  questions: (ref) => ({
    contradicted: noul(
      `${ref("documentation")} is the documentation comment of the function ${ref("name")}, whose code is ${ref("body")}. Does the documentation say something specific that the code contradicts?`,
      {
        true: "The documentation names a different subject, a different operation, a return value, a condition, or a limit than the one in the code: for example it says the function returns all items and the code filters them, or it describes another function entirely.",
        false:
          "Nothing the documentation says is contradicted by the code. Leaving out details, describing the purpose at a higher level than the code, or mentioning behaviour that happens in a function the code calls is not a contradiction.",
      },
    ),
    // No criteria: the boundary is plain, as it is for `comment-describes-code`.
    accurate: noul(`${ref("documentation")} is the documentation comment of the function ${ref("name")}, whose code is ${ref("body")}. Is the documentation an accurate description of what this function does?`),
  }),

  assess: ({ contradicted, accurate }, candidate) => ({
    p: contradicted.noul * (1 - accurate.noul),
    message: `The documentation of "${candidate.data.name}" says something the function does not do: "${candidate.data.documentation}"`,
  }),
});
