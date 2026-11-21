import { defineCodeRule, type Candidate } from "../../engine/types.ts";

// Jest's and AVA's ways of saying "this many assertions must run": with one, a skipped `if` does fail the test.
const COUNTS_ASSERTIONS = /\b(hasAssertions|assertions|plan)\(/;

// A warning and a review. The first is a certain fact that a panel was split on raising. The second a panel
// called right every time, and a second reviewer reading the files refuted two cases of three: the guarded
// element always exists in those tests, so the guard never skips anything.
const ONLY_CONSTANTS = 0.7;
const ALL_CONDITIONAL = 0.5;

export default defineCodeRule({
  id: "test-assertions-can-fail",
  description: "A test's assertions should be able to fail.",

  // Asks Jev nothing. Two shapes of a test that passes whatever the code under test does, both found by
  // reviewers reading real files and neither visible to a question about the title: the assertions the
  // title promises are there, and never run or never fail.
  select: (doc) =>
    doc.tests.flatMap((test): Candidate[] => {
      // An empty list means the tree could not identify the assertions, not that there are none.
      if (test.assertions.length === 0) return [];
      const data = { title: test.title, assertions: test.assertions };
      // With `expect.assertions(1)`, a constant assertion inside a callback proves the callback ran.
      if (test.assertionsAllConstant && !COUNTS_ASSERTIONS.test(test.body)) {
        return [{ loc: test.loc, data, decided: { p: ONLY_CONSTANTS, message: `Test "${test.title}" asserts only constants, so it cannot fail.` } }];
      }
      // In the code corpus 3 of 1,306 tests have this shape. Reviewers reading the files had listed all three.
      if (test.assertionsAllConditional && !COUNTS_ASSERTIONS.test(test.body)) {
        return [{ loc: test.loc, data, decided: { p: ALL_CONDITIONAL, message: `Every assertion in test "${test.title}" is inside an \`if\`, so the test passes when the condition is false.` } }];
      }
      return [];
    }),

  questions: () => ({}),

  // Never reached: every candidate is decided in `select`.
  assess: () => ({ p: 0, message: "" }),
});
