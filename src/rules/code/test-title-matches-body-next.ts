import { choice, noul } from "@typesafe-ai/sdk";
import { defineCodeRule } from "../../engine/types.ts";
import { clip } from "./shared.ts";

export default defineCodeRule({
  id: "test-title-matches-body-next",
  // The assertions are the part of a test that checks anything, so they are what a reader compares the title with.
  compares: [{ field: "assertions", label: "It asserts" }, { field: "body", label: "The test" }],
  description: "A test should check what its title claims (asks for the defect, and reads the enclosing suites).",
  // Experimental. A rewrite of `test-title-matches-body` that sends the `describe` titles, gates on whether
  // the title names an outcome at all, and asks whether the assertions check something else. It answers what
  // two panels and a question review raised, and a panel on unseen code called 3 of its 10 errors and warnings
  // right (findings §31), against 1 of 6 for the rule it rewrites. Since that panel it asks the second
  // question twice, in two wordings, and reports where both agree.
  optIn: true,
  // `assess` takes a geometric mean, which stays on the scale of one answer. On unseen code (findings §32) a
  // blind panel called 10 of 12 reports at 0.8 and above right and 1 of 7 between 0.6 and 0.8, so the lower
  // band is review.
  thresholds: { error: 0.9, warn: 0.8, review: 0.6 },

  select: (doc) =>
    doc.tests
      // A test with no assertion is a smoke test: it claims only that the code runs. Whether that is enough
      // is a team's policy and a parser's job (jest/expect-expect), not a question about the title.
      .filter((test) => test.hasAssertion)
      // A test whose assertions cannot fail is `test-assertions-can-fail`'s to report, once.
      .filter((test) => !test.assertionsAllConstant)
      .map((test) => ({
        loc: test.loc,
        meta: { assertions: test.assertions.join("\n") },
        // A title inside `describe` blocks is often half a sentence: "should be false by default" under
        // "silent". The suites are sent only when there are any, so a test without them costs nothing more.
        data: { ...(test.suites.length > 0 && { suite: test.suites.join(" > ") }), title: test.title, body: clip(test.body) },
      })),

  questions: (ref, candidate) => {
    const titled = "suite" in candidate.data ? `${ref("title")} is a test's title, inside the suite ${ref("suite")}` : `${ref("title")} is a test's title`;
    return {
      // About the title alone, so that it cannot collapse into the question it gates. A title that names
      // only a scenario or an issue promises nothing an assertion could fail to check.
      names_outcome: noul(`${titled}. Classify the title by itself: does it name a behaviour or an outcome that an assertion could check?`, {
        true: 'It says what should happen or what should be true: for example "returns null for an empty list", "rejects a duplicate email", "sorts entries by date".',
        false: 'It names only a scenario, a fixture, an issue, or a topic, or says only that something works: for example "issue #482", "large file", "basic", "works", "edge cases".',
      }),
      // Asks for the defect. On real tests "do the assertions check what the title claims" did not rank
      // below 0.88: indirect, partial and helper-based assertions all read as "not what the title says".
      checks_something_else: noul(`${titled}, and ${ref("body")} is the test code. Do the assertions check something other than what the title names?`, {
        true: {
          definition: "The assertions are about a different function, feature, or outcome than the title names, or they would pass whether or not the named behaviour works.",
          examples: ['the title says "sorts entries by date" and the only assertion is that three entries are returned', "the title says a missing file is reported and the test asserts only that a function was called"],
        },
        false: {
          definition: "The assertions check the behaviour the title names.",
          still_checks_it: [
            "indirectly, through a helper, or by observing a consequence, such as the call completing without throwing",
            "only in part, or with a single example input",
            "with a snapshot (`toMatchSnapshot`, `toMatchInlineSnapshot`) of the output the title names",
            "while also checking more than the title says",
          ],
        },
      }),
      // A second wording of the same classification, as a choice that names the two defects reviewers called
      // right: a test of something else, and assertions that cannot fail on the named behaviour. A test that
      // asserts the opposite of its title has its own answer so that it can be left out: every such report a
      // panel read was a file that titles each test after a rule and asserts the state the rule changes.
      relation: choice(`${titled}, and ${ref("body")} is the test code. How do the assertions relate to the behaviour the title names?`, {
        checks_it: "At least one assertion, or the test throwing, would show that the named behaviour is broken. This includes checking it through a helper, in part, with a snapshot, by an exact comparison of a whole value, or by a success signal when the title promises only that something can be done.",
        different_subject: 'The test calls a different function, or passes a different input or case, than the title names: for example the title says "removes the last item" and the test calls an add function, or the title says "with an expired token" and the test passes a valid one.',
        too_weak: 'The test runs the named behaviour, and its assertions would pass whatever the result was: for example the title says "sorts entries by date" and the only assertion is that three entries are returned, or the only assertion sits inside an `if` that may not run.',
        opposite: 'The assertions require the opposite of what the title says: for example the title says "hides the banner" and the test asserts the banner is visible.',
        no_claim: "The title names only a scenario or a topic, so there is nothing for the assertions to miss.",
      }),
    };
  },

  // The two wordings are wrong about different tests, so a report needs both: their geometric mean is high
  // only where they agree. The gate on the title multiplies in, as before.
  assess: ({ names_outcome, checks_something_else, relation }, candidate) => ({
    p: names_outcome.noul * Math.sqrt(checks_something_else.noul * (relation.probabilities.different_subject + relation.probabilities.too_weak)),
    message: `Test "${candidate.data.title}" does not check what its title claims.`,
  }),
});
