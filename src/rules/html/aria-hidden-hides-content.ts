import { noul } from "@typesafe-ai/sdk";
import { defineRule } from "../../engine/types.ts";
import { attr, closest, locOf, text, truncateWords, type Element } from "../../html/parse.ts";
import { limits } from "../limits.ts";

const isHidden = (el: Element) => attr(el, "aria-hidden") === "true";

function hasHiddenAncestor(el: Element): boolean {
  for (let node = el.parentNode; node && "tagName" in node; node = node.parentNode) if (isHidden(node)) return true;
  return false;
}

/** The same words are available to a screen reader elsewhere in the parent, so hiding this copy loses nothing. */
function isExposedNearby(el: Element, hidden: string): boolean {
  const parent = el.parentNode;
  if (!parent || !("tagName" in parent)) return false;
  const siblings = parent.childNodes.filter((node) => node !== el).map((node) => text(node)).join(" ");
  return siblings.toLowerCase().includes(hidden.toLowerCase());
}

/** aria-labelledby and aria-describedby read their targets even when the target is hidden, so a referenced element is exposed. */
function referencedIds(elements: Element[]): Set<string> {
  const ids = elements.flatMap((el) => `${attr(el, "aria-labelledby") ?? ""} ${attr(el, "aria-describedby") ?? ""}`.split(/\s+/));
  return new Set(ids.filter(Boolean));
}

export default defineRule({
  id: "aria-hidden-hides-content",
  description: 'aria-hidden="true" should hide decoration, not information a screen reader user needs.',

  select: (doc) => {
    const referenced = referencedIds(doc.elements);
    return doc.elements
      // The outermost hidden element stands for everything inside it.
      .filter((el) => isHidden(el) && !hasHiddenAncestor(el))
      // In a rendered page the browser has marked what a sighted user cannot see either: closed dialogs
      // and collapsed panels, which on the corpus were nearly every report. From source this is unknown.
      .filter((el) => attr(el, "data-jev-not-visible") === undefined)
      // Hiding an icon is what aria-hidden is for. The only text in an <svg> is its <title>, a fallback name.
      .filter((el) => el.tagName !== "svg")
      .filter((el) => !referenced.has(attr(el, "id") ?? ""))
      .map((el) => ({ el, hidden: text(el) }))
      .filter(({ hidden }) => hidden.length > 1)
      // A control named by aria-label never exposes its content anyway; the label is what is heard.
      .filter(({ el }) => !closest(el, ["a", "button"]) || !attr(closest(el, ["a", "button"])!, "aria-label"))
      .filter(({ el, hidden }) => !isExposedNearby(el, hidden))
      .map(({ el, hidden }) => ({ loc: locOf(el), data: { hidden_text: truncateWords(hidden, limits.hiddenTextWords) } }));
  },

  questions: (ref) => ({
    is_needed: noul(
      `${ref("hidden_text")} is inside an element with aria-hidden="true", so screen reader users never hear it. Does it carry information or instructions that a user needs?`,
      {
        true: "It states a fact, status, error, price, instruction, or other content a user would miss.",
        false: "It is decoration or a visual duplicate: separators, bullets, arrows, star glyphs, icon ligature names, or punctuation.",
      },
    ),
  }),

  assess: ({ is_needed }, candidate) => ({
    p: is_needed.noul,
    message: `aria-hidden="true" hides content a screen reader user needs: "${candidate.data.hidden_text}"`,
    hint: "The same words are not exposed anywhere else in the parent element.",
  }),
});
