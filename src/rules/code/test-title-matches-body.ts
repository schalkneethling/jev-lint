import { noul } from "@typesafe-ai/sdk";
import { defineCodeRule } from "../../engine/types.ts";
import { clip } from "./shared.ts";

export default defineCodeRule({
  id: "test-title-matches-body",
  // The assertions are the part of a test that checks anything, so they are what a reader compares the title with.
  compares: [{ field: "assertions", label: "It asserts" }, { field: "body", label: "The test" }],
  description: "A test should check what its title claims.",
  // Real tests often assert through helpers and mapped values, which takes reasoning to connect to the
  // title. Below 0.88 two blind panels called most reports wrong (smoke tests, thin assertions that still
  // touch the named behaviour). Of the ten reports the rule still makes at 0.88 and above, they called six
  // right, three contested and one wrong (one test was labelled twice, once agreed and once split; it counts as split). So there is no review band.
  //
  // Opt-in since a third panel, on code this threshold was not tuned against (findings §31), called 1 of 6
  // reports right. Both labellers called four of the other five false: the test checks what its title says
  // in a way the question does not recognise (a constructor that must not throw, an assertion on rendered text).
  optIn: true,
  thresholds: { error: 0.95, warn: 0.88, review: 0.88 },

  select: (doc) =>
    doc.tests
      // A test with no assertion is a smoke test: it claims only that the code runs. Whether that is enough
      // is a team's policy and a parser's job (jest/expect-expect), not a question about the title.
      .filter((test) => test.hasAssertion)
      .map((test) => ({ loc: test.loc, meta: { assertions: test.assertions.join("\n") }, data: { title: test.title, body: clip(test.body) } })),

  questions: (ref) => ({
    // No criteria: the boundary is plain, and removing them changed nothing (scripts/criteria-experiment.ts).
    checks_what_title_claims: noul(`${ref("title")} is a test's title and ${ref("body")} is the test code. Do the assertions in the test check the behaviour the title claims?`),
  }),

  assess: ({ checks_what_title_claims }, candidate) => ({
    p: 1 - checks_what_title_claims.noul,
    message: `Test "${candidate.data.title}" does not check what its title claims.`,
  }),
});
