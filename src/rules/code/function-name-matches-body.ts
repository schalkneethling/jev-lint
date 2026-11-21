import { noul } from "@typesafe-ai/sdk";
import { defineCodeRule, type Candidate } from "../../engine/types.ts";
import { clip, isTestFile } from "./shared.ts";

/**
 * Names that promise an answer and nothing else: a question (`is`, `has`), a lookup (`get`, `find`), or a
 * conversion (`parse`, `format`, `to`). These are the names for which a side effect is a broken promise.
 *
 * The rule used to classify every function. On the code corpus a panel of labellers called 5 of 16 reports
 * right. Four had a name of this kind (`isMixReady`, `getVolumn`, `checkIfSignedIn`, `readChanges`); the
 * fifth, `stringFrom`, is a noun phrase no prefix list can recognise, and the rule no longer sees it. The
 * eleven wrong ones were names that promise nothing either way (`init…`, `bind`, `size`, `before`,
 * `destroy`) or that a framework chose. `verify` and `assert` are left out: by convention they report or
 * throw, which is their side effect.
 */
const PROMISES_ONLY_AN_ANSWER =
  /^[_#]*(get|is|has|can|should|find|parse|read|to|from|check|validate|decode|encode|format|normali[sz]e|calc|calculate|compute|count|list|resolve|compare|equals|contains|includes|lookup|query|search|filter|sum|measure|diff|match|stringify|serialize|convert|detect|determine|estimate)(?=[A-Z_]|$)/;

// How many functions must share a prefix, and what share of them must be reported, before the reports are
// read as one habit. On the code corpus 43% of this rule's reports came from 5 of 61 repositories, each with
// one house style (every `get…` mutates `this`); a labeller reading one function in isolation called each a defect.
const HOUSE_STYLE_MIN_FUNCTIONS = 5;
const HOUSE_STYLE_MIN_SHARE = 0.5;

const REVIEW = 0.7;
const WARN = 0.8;
// At review: the fact is certain, and what it means depends on the callers, which the rule does not see.
const RETURNS_NOTHING = 0.7;

// The prefixes among `PROMISES_ONLY_AN_ANSWER` for which returning nothing is itself the broken promise.
// `check…` and `validate…` are not among them: by convention they throw or report and return nothing.
// Nor are `compute…` and `calculate…`, which in graphics and geometry code store their result on `this`.
const PROMISES_A_VALUE = /^[_#]*(get|is|has|can|should|find|count|sum|lookup)(?=[A-Z_]|$)/;

// The answer leaves another way: through a callback (`getUser(id, callback)`), or as an HTTP response
// (`getProfile(req, res)`). Returning nothing is then how the function is meant to work.
// Not `\b`: `$scope` starts with a character that is not a word character, so no word boundary precedes it.
const ANSWERS_ELSEWHERE = /(?<![\w$])(callback|cb|done|next|resolve|reject|res|response|reply|ctx|context|\$scope)(?![\w$])/;

const prefixOf = (name: string) => PROMISES_ONLY_AN_ANSWER.exec(name)![1]!;

// The name already says it writes: `getOrCreateUser`, `readAndClear`, `parseAndSave`, `readAndWrite`.
const ANNOUNCES_A_WRITE = /(Or|And|Then)(Create|Insert|Add|Set|Save|Store|Write|Update|Upsert|Init|Initiali[sz]e|Register|Remove|Delete|Clear|Reset|Increment|Send|Emit|Apply|Mark|Cache|Load)(?=[A-Z_]|$)/;

export default defineCodeRule({
  id: "function-name-matches-body",
  description: "A function whose name promises only an answer should not have side effects.",
  // Calibrated on three blind panels. In the first two, every report called right sat at 0.78 or above, and
  // in the second the mean was 0.85 for right reports and 0.62 for wrong ones: a cursor's `read…` advancing
  // its offset, a `parse…` filling the block it was handed, a cache `get` that records recency. All are side
  // effects, and all are what a caller of that name expects. The third panel looked only below 0.78 and
  // called 3 of 6 right between 0.70 and 0.78, so that band is review, and below it nothing is reported.
  //
  // Opt-in since a fourth panel, on code these thresholds were not tuned against (findings §31), called 4 of
  // 10 errors and warnings right. On four of the six others both labellers said the claim is true and not
  // worth raising: the side effect is one the file or the project makes expected.
  //
  // Since then a second question asks whether the side effect is a consequence of its own (see
  // `consequence_of_its_own`), and the warning threshold moved from 0.78 to 0.8. Rescored against the same
  // labels, 6 of 10 reports at 0.8 or above are right over all four panels, and 3 of 6 on the unseen code.
  // Two of the three wrong ones there are a sort of the caller's array that the caller does not reuse, which
  // the function alone cannot show, and a vendored copy of a library.
  optIn: true,
  thresholds: { error: 0.9, warn: WARN, review: REVIEW },
  // "Every get* accessor here memoises" is a house style a reviewer learns once. Told as a fact, it stops
  // the same report on every function that follows it.
  readsConventions: true,

  select: (doc) =>
    isTestFile(doc.file)
      ? []
      : doc.functions
          // A method of an object literal is usually named by a contract: a Proxy trap, an options callback, a hook.
          .filter((fn) => PROMISES_ONLY_AN_ANSWER.test(fn.name) && !ANNOUNCES_A_WRITE.test(fn.name) && fn.container !== "object")
          // A body with no call, assignment, `new`, `await` or `delete` cannot have a side effect.
          .filter((fn) => fn.canAct)
          // A setter is named for the property it sets: `set isOpen(value)` promises no answer and returns none by design.
          .filter((fn) => fn.accessor !== "set")
          // A `calc…`, `check…` or `validate…` that returns nothing exists for its effect: a chart's `calcPositions`
          // stores positions on `this` because it has no other way to hand them over. Only a name that promises
          // a value (`get…`, `is…`) breaks its promise by returning none. On unseen code a blind panel rejected
          // all five reports on void `calc…` methods (findings §32).
          .filter((fn) => fn.returnsValue || fn.stub || PROMISES_A_VALUE.test(fn.name))
          .map((fn): Candidate => {
            const candidate: Candidate = { loc: fn.loc, data: { name: fn.name, body: clip(fn.body) } };
            // A name that asks a question or names a lookup promises an answer. A body that never returns a
            // value gives none, so whatever it does is all side effect. The parser sees that, and `assess`
            // holds the finding at review at least, whatever Jev makes of the body.
            return PROMISES_A_VALUE.test(fn.name) && !fn.returnsValue && !fn.stub && !ANSWERS_ELSEWHERE.test(fn.params) ? { ...candidate, meta: { returns: "nothing" } } : candidate;
          }),

  // "Does it do only what the name says" read too strictly on real code: most functions do a little
  // more than their name. What harms a caller is a side effect the name gives no reason to expect.
  questions: (ref, candidate) => ({
    surprising_side_effect: noul(
      `${ref("name")} is a function's name and ${ref("body")} is its code.${
        "project_conventions" in candidate.data ? ` ${ref("project_conventions")} lists conventions this codebase follows, which every caller knows; a side effect that a convention announces is not a surprise.` : ""
      } Would a caller who read only the name be surprised by a side effect in the body?`,
      {
        true: "The body writes, deletes, sends, navigates, or changes shared state, and nothing in the name suggests it. For example a function named get, is, has, format, calculate, or validate that also saves, deletes, posts, or redirects.",
        false: "The body only does what the name leads a caller to expect. Local variables, logging, caching, argument checks, and error handling are not surprising. A vague or short name is not by itself a surprise.",
      },
    ),
    // The first question asks whether there is a side effect the name does not announce, and on unseen code
    // (findings §31) it was right about that while the report was still not worth raising: a cache `get`
    // that records recency, a lookup that assigns an id on first call and returns it after, memoisation.
    // Labellers wrote the same reason each time: the effect is part of producing the answer. What they
    // called worth raising was an effect a caller has to know about apart from the answer: a lookup that
    // drains the buffer it reads, unstages files, renders a list, or stores its result instead of
    // returning it. This asks for that distinction on its own, so neither answer has to carry both.
    consequence_of_its_own: noul(
      `${ref("name")} is a function's name and ${ref("body")} is its code. Does the body change something that outlives the call, apart from producing its answer, that a caller would need to know about?`,
      {
        true: {
          definition: "The body changes state that callers or other code can observe later, and the change is not needed to produce or speed up the answer the name promises.",
          examples: [
            "a function named loadPrice that also removes the item from the basket",
            "a getter that clears the queue it reads, so a second call returns nothing",
            "a function named findOldest that sorts the caller's array in place",
            "a function named isLoggedIn that redirects to the home page, or returns a handler that does",
            "a function named computeLayout that writes its result into the settings object it was given",
            "a format function that also posts an analytics event",
          ],
        },
        false: {
          definition: "Everything that outlives the call serves the answer itself, or nothing outlives the call at all.",
          examples: [
            "values built in local variables and returned, however many steps it takes",
            "caching or memoising the value it returns, or creating it lazily on the first call and reusing it after",
            "recording which cache entry was used most recently, or counting hits",
            "logging or debug output",
            "advancing a reader or cursor past the bytes it read",
          ],
        },
      },
    ),
  }),

  // A report needs both answers: a side effect the name does not suggest, and one that is a consequence of
  // its own. The square root of their product ranks candidates exactly as the product does, and keeps the
  // scale of one answer, so that two answers of 0.9 still read as 0.9 against the thresholds.
  //
  // A body that returns nothing has no answer for its effects to serve, so the second answer has nothing
  // to separate there, and only the first is read. On unseen code the second question still read a lookup
  // that stores its result on a shared object and returns nothing as half bookkeeping, which both
  // labellers called a defect worth raising.
  assess: ({ surprising_side_effect, consequence_of_its_own }, candidate) =>
    candidate.meta?.returns === "nothing"
      ? {
          p: Math.max(surprising_side_effect.noul, RETURNS_NOTHING),
          message: `Function "${candidate.data.name}" is named for an answer and returns no value on any path, so all it does is a side effect.`,
        }
      : {
          p: Math.sqrt(surprising_side_effect.noul * consequence_of_its_own.noul),
          message: `Function "${candidate.data.name}" has a side effect its name does not suggest.`,
        },

  // A convention derived from the run itself, which cannot go stale the way a declared one can. When at
  // least half of the functions sharing a prefix are reported, callers in this codebase evidently expect
  // it. The reports stay, capped at review and merged per file, and say what to do if the habit is intended.
  reconcile(classified) {
    // The thresholds in force, which a config file may have replaced.
    const review = this.thresholds?.review ?? REVIEW;
    const warn = this.thresholds?.warn ?? WARN;
    const byPrefix = Map.groupBy(classified, ({ candidate }) => prefixOf(String(candidate.data.name)));
    return classified.map(({ candidate, assessment }) => {
      const prefix = prefixOf(String(candidate.data.name));
      const siblings = byPrefix.get(prefix)!;
      const reported = siblings.filter((sibling) => sibling.assessment.p >= review).length;
      if (assessment.p < review || siblings.length < HOUSE_STYLE_MIN_FUNCTIONS || reported / siblings.length < HOUSE_STYLE_MIN_SHARE) return assessment;
      return {
        p: Math.min(assessment.p, warn - 0.01),
        message: assessment.message,
        pattern: `"${prefix}…" functions with a side effect their name does not suggest.`,
        hint: `${reported} of the ${siblings.length} "${prefix}…" functions in this run have such a side effect, which reads as a house style. If it is intended, state it under \`conventions\` in jev-lint.config.ts.`,
      };
    });
  },
});
