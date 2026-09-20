import { choice } from "@typesafe-ai/sdk";
import { defineRule } from "../../engine/types.ts";
import { attr, locOf, text } from "../../html/parse.ts";

const isPlaceholderHref = (href: string) => href === "" || href === "#" || href.startsWith("javascript:");

export default defineRule({
  id: "control-type-intent",
  description: "A link that goes nowhere and whose text names an action should be a button.",

  // Code already knows the link goes nowhere, so little doubt is needed: labelled misses sat at 0.30 to 0.39.
  thresholds: { review: 0.25 },

  select: (doc) =>
    doc.elements
      // A link with a real destination navigates, whatever its text says: on real pages, prose links such
      // as "showModal function" or "Edit shipping address" read as actions and were all false reports.
      // Only a link that goes nowhere leaves its purpose to the words.
      .filter((el) => el.tagName === "a" && attr(el, "role") === undefined && isPlaceholderHref(attr(el, "href") ?? "x"))
      .map((el) => ({ el, label: attr(el, "aria-label") ?? text(el) }))
      .filter(({ label }) => label !== "")
      .map(({ el, label }) => ({
        loc: locOf(el),
        data: { label },
        meta: { href: attr(el, "href")! },
      })),

  questions: (ref) => ({
    effect: choice(
      `${ref("label")} is the visible label of one clickable control on a web page. What does a user expect to happen when they activate a control with this label?`,
      {
        navigates:
          "The user is taken somewhere: another page, another website, a section of this page, a file download, or a sign-in or sign-out page.",
        performs_action:
          "Something changes without going anywhere: data is submitted, saved, deleted, added, or removed, or part of the interface opens, closes, expands, toggles, plays, or is copied.",
        unclear: "The label alone does not indicate either of the above.",
      },
    ),
  }),

  // A link that goes nowhere is already wrong, and code knows it. In blind labelling all 13 sampled
  // candidates were defects, including five the rule had let pass because their label ("Legend",
  // "Weight Bars") did not sound like an action. So the answer can only excuse a link, never be needed
  // to condemn it: what is left is the chance that it navigates, such as "Back to top" on href="#".
  assess: ({ effect }, candidate) => ({
    p: 1 - effect.probabilities.navigates,
    message: `Link "${candidate.data.label}" goes nowhere (href="${candidate.meta!.href}") and does not read as navigation.`,
    hint: 'A <button type="button"> is the element for an action.',
  }),
});
