import { noul } from "@typesafe-ai/sdk";
import { defineCodeRule } from "../../engine/types.ts";
import { clip } from "./shared.ts";

// An event handler or lifecycle hook is named for when it runs, not for what it does, and side effects
// are its whole job. On real code `onEnd`, `onTestEnd` and `attributeChangedCallback` were all reported.
const NAMED_FOR_WHEN_IT_RUNS = /^(on|handle)[A-Z_]|(Callback|Handler|Listener|Hook)$|^(main|init|setup|teardown|render|run|start|stop)$/;

// A capitalised function is a component or a constructor: named for what it is, not for an action
// whose side effects could surprise. React's `Snippet`, with its hooks and clipboard call, was reported.
const NAMED_FOR_WHAT_IT_IS = /^[A-Z]/;

export default defineCodeRule({
  id: "function-name-matches-body",
  description: "A function should not have side effects its name gives no reason to expect.",

  select: (doc) =>
    doc.functions
      // A one or two letter name promises nothing that could be broken.
      .filter((fn) => fn.name.length > 2 && !NAMED_FOR_WHEN_IT_RUNS.test(fn.name) && !NAMED_FOR_WHAT_IT_IS.test(fn.name))
      .map((fn) => ({ loc: fn.loc, data: { name: fn.name, body: clip(fn.body) } })),

  // "Does it do only what the name says" read too strictly on real code: most functions do a little
  // more than their name. What harms a caller is a side effect the name gives no reason to expect.
  questions: (ref) => ({
    surprising_side_effect: noul(
      `${ref("name")} is a function's name and ${ref("body")} is its code. Would a caller who read only the name be surprised by a side effect in the body?`,
      {
        true: "The body writes, deletes, sends, navigates, or changes shared state, and nothing in the name suggests it. For example a function named get, is, has, format, calculate, or validate that also saves, deletes, posts, or redirects.",
        false: "The body only does what the name leads a caller to expect. Local variables, logging, caching, argument checks, and error handling are not surprising. A vague or short name is not by itself a surprise.",
      },
    ),
  }),

  assess: ({ surprising_side_effect }, candidate) => ({
    p: surprising_side_effect.noul,
    message: `Function "${candidate.data.name}" has a side effect its name does not suggest.`,
  }),
});
