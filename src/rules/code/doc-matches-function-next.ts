import { choice, noul } from "@typesafe-ai/sdk";
import { defineCodeRule } from "../../engine/types.ts";
import { clip, DIRECTIVE } from "./shared.ts";

// A doc comment of one or two words claims nothing the function could contradict.
const SAYS_SOMETHING = /\w+\s+\w+\s+\w+/;

// A file's licence header sits directly above its first function and says nothing about that function.
// `DIRECTIVE` only sees a header that starts with the word; many start with the name of the library.
const LICENCE = /copyright\s*\(c\)|free software|without any warranty|licensed under|spdx-/i;

// A body that only returns a constant is a placeholder or a sketch of an interface: like a stub, its
// documentation describes the contract an implementation must meet.
const RETURNS_A_CONSTANT = /^\{\s*return\s*(\[\s*\]|\{\s*\}|null|true|false|undefined|""|''|\d+)?\s*;?\s*\}$/;

const PARAM_TAG = /@(?:param|arg|argument)\s+(?:\{[^}]*\}\s*)?\[?([A-Za-z_$][\w$]*)/g;

/**
 * A parameter the documentation names in a tag and the function does not take: the mark of a comment
 * copied from a sibling or left behind by a rename. Nothing is concluded when the list destructures,
 * because a destructured parameter has no name of its own and its tag has to invent one.
 */
function undeclaredParameter(doc: string, params: string, body: string): string | undefined {
  // A function that reads `arguments`, or takes a rest parameter, documents values it does not name one by one.
  if (/[{[]|\.\.\./.test(params) || /\barguments\b/.test(body)) return undefined;
  const declared = new Set(params.match(/[A-Za-z_$][\w$]*/g) ?? []);
  return [...doc.matchAll(PARAM_TAG)].map((tag) => tag[1]!).find((name) => !declared.has(name));
}

// On two code corpora 3 functions had such a tag, and reviewers reading the files had listed all 3 as
// defects. Three is few, so the fact raises the classified probability and does not decide by itself: it is
// kept below the rule's review threshold, which a report then needs some of Jev's answer to reach.
const UNDECLARED_PARAMETER = 0.45;

// The comment above a function is not always its documentation. A reason or a piece of background
// ("the user watches these pages, so they stay open") is true or false of the project, and reading it as
// a description of the body produced contradictions that reviewers rejected.
const KINDS = {
  describes: "It says what the function does, what it takes, or what it returns.",
  explains: "It gives a reason, a constraint, a warning, or background, and does not say what the function does.",
  other: "None of the above: a heading, a licence or authorship line, a note about work still to do, or commented-out code.",
} as const;

export default defineCodeRule({
  id: "doc-matches-function-next",
  compares: [{ field: "body", label: "The function" }],
  description: "A function's documentation comment, its tags included, should be true of the function.",
  // Experimental. `doc-matches-function` sends only the summary, on the reasoning that tags are a type
  // checker's to verify. Reviewers reading real files disagreed: of the doc defects they found, many were in
  // what a tag says in words ("@param filter the id to remove", "@returns the previous value"), which no type
  // checker reads. Scored against those defects, the summary-only rule gave nearly every one a probability
  // under 0.30, whichever way its two answers were combined, because the words at fault were never sent.
  // This sends the whole comment and the parameter list, and asks for the defect. A panel on unseen code
  // called 5 of its 12 errors and warnings right at the engine's default thresholds (findings §31).
  // Since then: five rewordings of the question (is it accurate, would a caller be misled, was it written
  // for another function, a stricter "proves false", a choice of relations) were classified on both corpora.
  // Each ranked the defects reviewers found no better than the question below, alone or multiplied in,
  // because their answers rise and fall together. So the question stays, and what changed is around it:
  // what is selected, what kind of comment it is, one fact from the tags, and where a report becomes loud.
  optIn: true,
  // Of the labelled reports, those at 0.9 and above were all right, and those between 0.6 and 0.8 were
  // right less than half the time: the documentation left a detail out, or defined a term the body tests
  // in its own way. That middle band is a review, not a warning.
  thresholds: { error: 0.9, warn: 0.8, review: 0.5 },

  select: (doc) =>
    doc.functions
      .filter((fn) => !fn.stub && fn.body.replace(/\s/g, "") !== "{}")
      .filter((fn) => !RETURNS_A_CONSTANT.test(fn.body.trim()))
      .filter((fn) => SAYS_SOMETHING.test(fn.doc) && !DIRECTIVE.test(fn.doc) && !LICENCE.test(fn.doc))
      .map((fn) => ({ loc: fn.loc, meta: { undeclared: undeclaredParameter(fn.doc, fn.params, fn.body) ?? "" }, data: { documentation: fn.doc, name: fn.name, ...(fn.params !== "" && { parameters: fn.params }), body: clip(fn.body) } })),

  questions: (ref, candidate) => ({
    contradicted: noul(
      `${ref("documentation")} is the documentation comment of the function ${ref("name")}${"parameters" in candidate.data ? `, which takes ${ref("parameters")}` : ""}, and ${ref("body")} is its code. Does the documentation say something specific that the function contradicts?`,
      {
        true: {
          definition: "The documentation names a subject, an operation, a parameter's meaning, a return value, a condition, or a limit, and the code shows a different one.",
          examples: [
            "it says the function returns all items and the code filters them",
            "it describes a parameter as the id to remove and the code uses that parameter as a list of names",
            "it says the previous value is returned and the code returns the new one",
            "it describes another function: the width where this one computes the height",
          ],
        },
        false: {
          definition: "Nothing the documentation says is contradicted by the code shown.",
          not_contradicted: [
            "it leaves out details, or describes the purpose at a higher level than the code",
            "it describes behaviour that happens in a function the code calls",
            "it describes code after the `/* … truncated */` marker",
            "it says what is returned, and the code returns a promise of that",
            "a type in braces differs in notation only, such as `{Object}` for a record",
          ],
        },
      },
    ),
    // Asked of the comment alone, so that it is an answer about the words and not a second reading of the code.
    kind: choice(`${ref("documentation")} is a comment written above the function ${ref("name")} in source code. Classify the comment by itself: what kind of comment is it?`, KINDS),
  }),

  assess: ({ contradicted, kind }, candidate) => {
    // A soft branch: a comment the model is 60% sure is a description keeps 60% of the finding.
    const classified = contradicted.noul * kind.probabilities.describes;
    const undeclared = candidate.meta?.undeclared ?? "";
    return undeclared === ""
      ? { p: classified, message: `The documentation of "${candidate.data.name}" says something the function does not do.` }
      : {
          p: 1 - (1 - classified) * (1 - UNDECLARED_PARAMETER),
          message: `The documentation of "${candidate.data.name}" describes a parameter "${undeclared}" that the function does not take.`,
          hint: "The comment may have been copied from another function, or left behind when a parameter was renamed.",
        };
  },
});
