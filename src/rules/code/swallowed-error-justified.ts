import { choice } from "@typesafe-ai/sdk";
import type { CodeDoc, CodeEmptyCatch } from "../../code/parse.ts";
import { defineCodeRule } from "../../engine/types.ts";
import { limits } from "../limits.ts";
import { clip, isTestFile } from "./shared.ts";

/**
 * The innermost named function or test around the handler, as the code a reader sees with it. Undefined at the
 * top level and inside an anonymous callback that no named function or test holds. The parser lists named
 * functions only, so a handler in an arrow callback gets the named function that holds the callback. A test
 * is included because its assertions after the handler are what check whether the failure mattered.
 */
function enclosing(doc: CodeDoc, handler: CodeEmptyCatch): string | undefined {
  const at = handler.loc;
  const holders = [
    ...doc.functions.map((fn) => ({ loc: fn.loc, head: `function ${fn.name}${fn.params}`, body: fn.body })),
    ...doc.tests.map((test) => ({ loc: test.loc, head: `test ${JSON.stringify(test.title)}:`, body: test.body })),
  ].filter(
    (holder) =>
      holder.loc.lines !== undefined &&
      at.lines !== undefined &&
      holder.loc.lines.first <= at.lines.first &&
      holder.loc.lines.last >= at.lines.last &&
      // On one line, the line numbers cannot tell a function beside the handler from one around it.
      holder.body.includes(handler.tried) &&
      // Starts before the handler, so that a function written inside the handler is never its own context.
      (holder.loc.span?.start ?? 0) < (at.span?.start ?? 0),
  );
  const inner = holders.reduce<(typeof holders)[number] | undefined>((best, holder) => (!best || holder.loc.lines!.first >= best.loc.lines!.first ? holder : best), undefined);
  return inner && `${inner.head} ${around(inner.body, handler.tried)}`;
}

/**
 * The function's code with the handler in it. A long function is cut to a window around the handler, two
 * thirds before it, because a condition or comment that explains the handler is usually above it and a
 * fallback directly below.
 */
function around(body: string, tried: string): string {
  if (body.length <= limits.codeChars) return body;
  const anchor = body.indexOf(tried);
  if (anchor === -1) return clip(body);
  const start = Math.max(0, anchor - Math.round((limits.codeChars * 2) / 3));
  const end = Math.min(body.length, start + limits.codeChars);
  return `${start > 0 ? "/* … */\n" : ""}${body.slice(start, end)}${end < body.length ? "\n/* … */" : ""}`;
}

// The whole `try` block is one assignment to `module.exports` or to a property of `exports`.
const EXPORTS_WHERE_IT_CAN = /^\{?\s*(module\.exports|exports\.\w+)\s*=[^;\n]*;?\s*\}?$/;

export default defineCodeRule({
  id: "swallowed-error-justified",
  description: "Code that ignores an error should show why ignoring it is safe.",
  // Experimental. The earlier version, which looked only inside the catch block, had 2 of 12 reports called
  // right by a blind panel. The next sent the lines around the handler, and a panel on unseen code called 6 of
  // its 13 errors and warnings right (findings §31), so it does not run unless asked for. This version adds the
  // enclosing function or test and a "costs nothing" answer, and two panels on unseen code called 2 of 9 and
  // 0 of 4 right (findings §32).
  optIn: true,
  thresholds: { error: 0.8, warn: 0.6, review: 0.4 },

  // ESLint's no-empty is satisfied by any comment inside the block, including "// ignore", and says nothing
  // about `.catch(() => {})`. Whether a handler is empty is the parser's call. Whether the code around it
  // shows why that is safe is what is left for Jev.
  //
  // One fallback the parser can see without help: a `try` that assigns a variable declared outside it leaves
  // that variable at its earlier value on failure. Five of an earlier panel's wrong reports had this shape,
  // and neither of the real defects two reviewers found did, so those are not candidates at all.
  select: (doc) =>
    doc.emptyCatches
      .filter((handler) => handler.keeps.length === 0)
      // In a test, a fixture or a file of type tests, an ignored error is part of the setup: a blind panel
      // called every such report true and not worth raising (findings §32).
      .filter(() => !isTestFile(doc.file))
      // `try { module.exports = Player } catch {}` is how a script that also loads in a browser exports itself:
      // the failure is the expected case there, and the same panel called all four such reports noise.
      .filter((handler) => !EXPORTS_WHERE_IT_CAN.test(handler.tried))
      .map((handler) => {
        // The labellers who rejected reports read the reason in code the statement before and after did not
        // reach: an `if (suppressErrors)` around the handler, a comment two statements up, a `return` after
        // the enclosing `if`. The function holds all three. In a test, the assertions after the handler are what
        // check whether the failure mattered, and the test body holds those.
        const holder = enclosing(doc, handler);
        return {
          loc: handler.loc,
          data: {
            comment_above: handler.commentAbove,
            statement_before: handler.before,
            code_that_can_fail: clip(handler.tried),
            comment_in_handler: handler.comment,
            statement_after: handler.after,
            ...(holder && { enclosing_function: holder }),
          },
          meta: { form: handler.form },
        };
      }),

  questions: (ref, candidate) => {
    const context =
      "enclosing_function" in candidate.data
        ? ` The whole function or test it sits in is ${ref("enclosing_function")}.`
        : "";
    const setting = `In source code, ${ref("code_that_can_fail")} can throw, and the error is caught and ignored: the handler contains only ${ref("comment_in_handler")}, which may be empty. ${ref("comment_above")} is the comment directly above that code, ${ref("statement_before")} the statement before it and ${ref("statement_after")} the statement after it; any of the three may be empty.${context}`;
    return {
      // One classification with four answers, of which only the last is reported. Labellers agreed that an
      // ignored error was unexplained and still did not want it raised when the failure costs nothing anyone
      // relies on: a cache write, a warm-up, a diagnostic message, a demo's sample data. They wanted it raised
      // when the code goes on as if the attempt had worked. So "costs nothing" is an answer of its own, beside
      // the two kinds of reason.
      handling: choice(`${setting} What makes ignoring this error acceptable, if anything?`, {
        reason_stated:
          'A comment in the handler, above the code, or a few lines further up names the failure that is expected, even in two or three words ("file may not exist", "the socket may already be closed", "not a terminal", "unknown locale"), says why a failure is harmless, says where the error is handled instead, or points to where the reason is given.',
        evident_from_code:
          "No comment gives a reason, but the code makes it plain: a default is set before the attempt; the function goes on to return or use a usable value when the attempt fails, even if that return comes after an enclosing block; the handler runs only under a flag or option that asks for errors to be skipped; the attempt is an optional parse or feature detection; or it is clean-up such as removing a listener or closing a handle.",
        costs_nothing: {
          definition:
            "Nothing explains it, but the only thing a failure loses is an optional extra, and the program works the same without it: a cache entry that is rebuilt later, a warm-up or prefetch, a log, metric or diagnostic message, a convenience such as opening a page for the user, clean-up on a path that is already reporting another error, or sample data in an example or demo. In a test, code under test may be allowed to fail so that the assertions after it check the outcome; those assertions are what fail when it matters.",
          examples: [
            "`try { await cache.set(key, value) } catch {}` where reads fall back to fetching",
            "`telemetry.send(event).catch(() => {})`",
            "`try { prefetch(nextPageUrl) } catch {}`",
          ],
        },
        // Kept last: Jev leans towards the first option of a Choice, so the defect must not lead.
        nothing: {
          definition:
            'None of these. No comment names the expected failure, why it is harmless, or where it is handled instead: the handler is empty or its comment only says the error is ignored ("ignore", "noop", "empty", "nothing to do", "should never happen"). The code shows no default or fallback. And a failure loses work the user asked for or a record the program meant to save, or the code goes on as if the attempt had succeeded: it tells the user the action is done, takes a next step that needs the result, or leaves state the rest of the program reads out of step with reality.',
          examples: [
            '`api.saveOrder(order).catch(() => {})` followed by `toast("Order saved")`',
            "`try { await db.commit(tx) } catch {}` in a function that then marks the import complete",
            "`try { await inventory.reserve(items) } catch {}` followed by `chargeCustomer(order)`",
          ],
        },
      }),
    };
  },

  assess: ({ handling }, candidate) => ({
    p: handling.probabilities.nothing,
    message:
      candidate.data.comment_in_handler === ""
        ? "This error is caught and ignored, and nothing nearby says why that is safe."
        : `This error is caught and ignored, and the comment "${candidate.data.comment_in_handler}" does not say why that is safe.`,
  }),
});
