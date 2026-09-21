import { noul } from "@typesafe-ai/sdk";
import { defineRule, type Candidate } from "../../engine/types.ts";
import { attr, locOf, nearestHeading, text, writtenText, type Element } from "../../html/parse.ts";

const isControl = (el: Element) =>
  (el.tagName === "a" && attr(el, "href") !== undefined) ||
  el.tagName === "button" ||
  ["button", "link"].includes(attr(el, "role") ?? "");

const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

// Which of the two texts contains the other is string containment after one declared normalisation, so
// code decides it. What to make of each case is policy, and one of the four needs a classification.
type Relation = "same" | "label_extends_text" | "label_is_part_of_text" | "unrelated_wording";

function relate(label: string, visible: string): Relation {
  const [l, v] = [normalize(label), normalize(visible)];
  if (l === v) return "same";
  if (l.includes(v)) return "label_extends_text";
  if (v.includes(l)) return "label_is_part_of_text";
  return "unrelated_wording";
}

// WCAG 2.5.3 in its strict reading: the name should contain the words a person sees. When both texts
// still mean the same thing this is a risk for voice control, not a wrong label, so it stays at review.
const LABEL_NOT_IN_NAME = 0.45;

export default defineRule({
  id: "aria-label-justified",
  description:
    "An aria-label on a control with visible text should add what the text leaves out, and must not say something else.",

  select: (doc) => {
    const controls = doc.elements.filter(isControl).map((el) => ({ el, visible: text(el) }));
    const occurrences = Map.groupBy(controls, ({ visible }) => normalize(visible));
    return controls
      // "×", "→" or "☰" is an icon made of text. A label that replaces it is the right thing to do, and
      // WCAG 2.5.3 is about text a person could say aloud, so only visible text with a letter or digit counts.
      // An image's alt is not text anyone sees. Blind labels: a card that is one linked image, labelled
      // with the article's title on purpose, was reported as "says something else" than its alt.
      .filter(({ el }) => /[\p{L}\p{N}]/u.test(writtenText(el)) && (attr(el, "aria-label") ?? "").trim() !== "")
      .map(({ el, visible }) => ({ el, visible, label: attr(el, "aria-label")!.trim() }))
      // A card whose link text is a title plus a paragraph, labelled with the title alone: on the first
      // corpus run this was 739 "errors", most of them one cloud provider's product cards, labelled with the product name. The label's
      // words are on screen, so a voice user can say them, and a shorter name is a kindness.
      .filter(({ visible, label }) => relate(label, visible) !== "label_is_part_of_text")
      .map(({ el, visible, label }): Candidate => {
        const relation = relate(label, visible);
        const candidate: Candidate = {
          loc: locOf(el),
          data: { visible_text: visible, aria_label: label },
          meta: {
            relation,
            controls_with_same_visible_text: String(occurrences.get(normalize(visible))!.length),
            nearest_heading: nearestHeading(doc, el) ?? "",
          },
        };
        // An exact repeat changes nothing a user hears. It is clutter that can drift, not a defect.
        if (relation === "same") {
          candidate.decided = {
            p: 0.45,
            message: `aria-label "${label}" repeats the visible text exactly; it adds nothing and can drift out of step with it.`,
            pattern: "the aria-label repeats the visible text exactly; it adds nothing and can drift out of step with it.",
          };
        }
        return candidate;
      });
  },

  // One question per case, never both: what a label that extends the text adds, or whether a label
  // worded differently still means the same thing.
  questions: (ref, candidate) => ({
    ...(candidate.meta!.relation === "label_extends_text" && {
      // Asks for the defect. The first version asked whether the label "adds the specific subject" and
      // listed items, articles, records, and sections; read literally, "7" labelled "7 Comments" and "No"
      // labelled "No, give us constructive feedback" added none of those, and blind labels put this
      // rule's precision at 38%.
      adds_only_filler: noul(
        `${ref("visible_text")} is what sighted users read on a control and ${ref("aria_label")} replaces it for screen reader users. The label contains the visible text plus some extra words. Are the extra words only filler that tells the user nothing new?`,
        {
          true: 'The extra words only name the kind of element or a gesture, or restate what is already there: for example "link", "button", "click to", "tap", "here", "icon", or the raw URL the control leads to.',
          false:
            'The extra words carry meaning: what a number counts ("7 Comments"), what the control applies to ("Edit shipping address"), what will happen ("No, give us feedback"), where it leads, or any other detail a user would want.',
        },
      ),
    }),
    ...(candidate.meta!.relation === "unrelated_wording" && {
      same_purpose: noul(
        `${ref("visible_text")} is what sighted users read on a control and ${ref("aria_label")} is what screen reader users hear instead. Do both describe the same action or destination?`,
        {
          true: "A person hearing the label and a person reading the text would expect the same thing to happen, even though the wording differs.",
          false: 'They would expect different things: for example the text says "Submit order" and the label says "Close", or the text says "Next" and the label says "Previous slide".',
        },
      ),
    }),
  }),

  assess: ({ adds_only_filler, same_purpose }, candidate) => {
    const { visible_text, aria_label } = candidate.data;
    if (same_purpose) {
      const different = 1 - same_purpose.noul;
      return different > LABEL_NOT_IN_NAME
        ? { p: different, message: `aria-label "${aria_label}" says something else than the visible text "${visible_text}".` }
        : {
            p: LABEL_NOT_IN_NAME,
            message: `aria-label "${aria_label}" does not contain the visible text "${visible_text}", so a voice control user may not be able to activate it by saying what they see (WCAG 2.5.3).`,
            pattern: "the aria-label does not contain the visible text, so a voice control user may not be able to activate the control by saying what they see (WCAG 2.5.3).",
          };
    }
    // A label that adds the subject is welcome even where it was not strictly needed ("Accept" with
    // "Accept all cookies"). What is reported is a label that overrides the text and adds nothing.
    const shared = Number(candidate.meta!.controls_with_same_visible_text) > 1;
    return {
      p: adds_only_filler!.noul,
      message: shared
        ? `aria-label "${aria_label}" does not tell this "${visible_text}" control apart from the others; name what it applies to.`
        : `aria-label "${aria_label}" overrides the visible text "${visible_text}" and adds nothing to it.`,
      ...(shared && candidate.meta!.nearest_heading && { hint: `The nearest heading is "${candidate.meta!.nearest_heading}".` }),
    };
  },
});
