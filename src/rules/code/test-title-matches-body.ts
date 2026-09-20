import { noul } from "@typesafe-ai/sdk";
import { defineCodeRule } from "../../engine/types.ts";
import { clip } from "./shared.ts";

export default defineCodeRule({
  id: "test-title-matches-body",
  description: "A test should check what its title claims.",
  // Real tests often assert through helpers and mapped values, which takes reasoning to connect to the
  // title. Those land between 0.55 and 0.75; tests that assert something else entirely land above 0.9.
  thresholds: { error: 0.95, warn: 0.88, review: 0.8 },

  select: (doc) => doc.tests.map((test) => ({ loc: test.loc, data: { title: test.title, body: clip(test.body) } })),

  questions: (ref) => ({
    // No criteria: the boundary is plain, and removing them changed nothing (scripts/criteria-experiment.ts).
    checks_what_title_claims: noul(`${ref("title")} is a test's title and ${ref("body")} is the test code. Do the assertions in the test check the behaviour the title claims?`),
  }),

  assess: ({ checks_what_title_claims }, candidate) => ({
    p: 1 - checks_what_title_claims.noul,
    message: `Test "${candidate.data.title}" does not check what its title claims.`,
  }),
});
