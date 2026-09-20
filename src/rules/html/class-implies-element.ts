import { choice } from "@typesafe-ai/sdk";
import { defineRule, type Candidate } from "../../engine/types.ts";
import { attr, descendants, locOf, type Element } from "../../html/parse.ts";

const OPTIONS = {
  nav: "The whole element is a navigation region: a site menu, navbar, breadcrumb trail, pagination, or table of contents.",
  header: "The whole element is the page header or masthead.",
  footer: "The whole element is the page footer.",
  main: "The whole element is the main content area of the page.",
  aside: "The whole element is a sidebar or complementary region.",
  article: "The whole element is one self-contained article, blog post, or comment.",
  button: "The whole element is one clickable button.",
  none: "None of the above. This includes generic layout names such as container, wrapper, row, grid, card, or inner, and names for a part, child, item, or modifier of one of the things above, such as nav-item, header-title, footer-column, button-group, or sidebar-widget.",
} as const;

const SEMANTIC_TAGS = Object.keys(OPTIONS).filter((option) => option !== "none");

// A "switch" or "btn" wrapper around or inside one of these already has an interactive element doing the work.
const INTERACTIVE_TAGS = ["button", "a", "label", "input", "select", "summary"];

/** Semantic elements that already wrap or sit inside `el`, which make it a legitimate helper. */
function relatives(el: Element): string {
  const tags = descendants(el, [...SEMANTIC_TAGS, ...INTERACTIVE_TAGS]).map((d) => d.tagName);
  for (let node = el.parentNode; node && "tagName" in node; node = node.parentNode) tags.push(node.tagName);
  return tags.join(" ");
}

// Utility-first CSS names how an element looks, never what it is, so there is nothing for this rule to read.
const UTILITY_TOKEN = /[:[\]/!&*>]|-\d|^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|group|peer|container)$/;
const isUtilityStyled = (classes: string) => {
  const tokens = classes.split(/\s+/);
  return tokens.filter((token) => UTILITY_TOKEN.test(token)).length / tokens.length >= 0.5;
};

export default defineRule({
  id: "class-implies-element",
  description: "A <div> or <span> whose class or id names a semantic HTML element should be that element.",

  select: (doc) => {
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const el of doc.elements) {
      if (el.tagName !== "div" && el.tagName !== "span") continue;
      // An explicit role means the author already chose the semantics; ARIA linters cover that.
      if (attr(el, "role") !== undefined) continue;
      // Hidden from assistive technology, so its semantics reach nobody.
      if (attr(el, "aria-hidden") === "true") continue;
      const names = { class: attr(el, "class")?.trim() || null, id: attr(el, "id")?.trim() || null };
      if (names.class === null && names.id === null) continue;
      if (names.id === null && isUtilityStyled(names.class!)) continue;
      // Repeated components share a signature; one judgement at the first occurrence is enough.
      const signature = JSON.stringify(names);
      if (seen.has(signature)) continue;
      seen.add(signature);
      candidates.push({ loc: locOf(el), data: names, meta: { tag: el.tagName, relatives: relatives(el) } });
    }
    return candidates;
  },

  questions: (ref) => ({
    built_as: choice(
      `${ref("class")} and ${ref("id")} are the class names and id an author gave to one generic HTML container. Judging only by these names, what did the author build this element to be?`,
      OPTIONS,
    ),
  }),

  assess: ({ built_as }, candidate) => {
    const { none, ...elements } = built_as.probabilities;
    const [top] = Object.entries(elements).sort(([, a], [, b]) => b - a);
    const name = [candidate.data.id && `#${candidate.data.id}`, candidate.data.class && `.${candidate.data.class}`]
      .filter(Boolean)
      .join(" ");
    // `.footer-content` inside a real <footer>, or `.theme-switch` around a real <button>, is a
    // styling hook for an element that already exists. Code can see that; the model cannot.
    const relatives = candidate.meta!.relatives!.split(" ");
    const alreadySemantic = top![0] === "button" ? INTERACTIVE_TAGS.some((tag) => relatives.includes(tag)) : relatives.includes(top![0]);
    return {
      p: alreadySemantic ? 0 : 1 - none,
      message: `<${candidate.meta!.tag}> named "${name}" looks like a <${top![0]}>; use the semantic element.`,
      hint: `No <${top![0]}> wraps it or sits inside it.`,
    };
  },
});
