import { noul } from "@typesafe-ai/sdk";
import { defineRule } from "../../engine/types.ts";
import { attr, locOf, text, truncateWords } from "../../html/parse.ts";
import { limits } from "../limits.ts";

export default defineRule({
  id: "alert-is-urgent",
  description: 'role="alert" and aria-live="assertive" interrupt the user, so they should carry something urgent.',

  // Only text present in the markup is seen. A live region filled by script later is out of reach here.
  select: (doc) =>
    doc.elements
      .filter((el) => attr(el, "role") === "alert" || attr(el, "aria-live") === "assertive")
      .map((el) => ({ el, message: text(el) }))
      .filter(({ message }) => message.split(" ").length >= 2)
      // An unrendered template slot such as "{{ message }}" is filled by script later; its text is not the message.
      .filter(({ message }) => !/\{\{.*\}\}|\$\{.*\}|<%.*%>/.test(message))
      .map(({ el, message }) => ({
        loc: locOf(el),
        data: { message: truncateWords(message, limits.alertMessageWords) },
        meta: { announced_by: attr(el, "role") === "alert" ? 'role="alert"' : 'aria-live="assertive"' },
      })),

  questions: (ref) => ({
    is_urgent: noul(
      `${ref("message")} is announced to screen reader users immediately, interrupting whatever they are doing. Is it urgent enough to justify interrupting them?`,
      {
        true: "It reports a failure of something the user just did, a security or time-critical warning, or data loss.",
        false:
          'It is a success confirmation, a routine status update, marketing, a greeting, or a cookie notice, which should be announced politely or not at all. So is a validation note attached to a single form field, such as "This field is required": it belongs to the field, not in an interruption.',
      },
    ),
  }),

  assess: ({ is_urgent }, candidate) => ({
    p: 1 - is_urgent.noul,
    message: `${candidate.meta!.announced_by} interrupts the user for a message that is not urgent: "${candidate.data.message}"`,
    hint: 'role="status" or aria-live="polite" announces it without interrupting.',
  }),
});
