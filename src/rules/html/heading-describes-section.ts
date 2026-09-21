import { noul } from "@typesafe-ai/sdk";
import { defineRule } from "../../engine/types.ts";
import { descendants, isConsentUi, locOf, text, truncateWords, type Element } from "../../html/parse.ts";
import { limits } from "../limits.ts";

const HEADING = /^h[1-6]$/;
const MIN_WORDS = 12;
const FIELDS = ["input", "select", "textarea"];

/**
 * A heading over a list describes the collection, not its first member. The opening words under
 * "Browse all posts" are one post's excerpt, which reads as off topic (p = 0.88 at 40 words). What the
 * reader perceives is a list, so that is what the state says: how many items, and what the first few are called.
 */
function describeList(node: Element): string | undefined {
  const lists = node.tagName === "ul" || node.tagName === "ol" ? [node] : descendants(node, ["ul", "ol"]);
  const list = lists.find((candidate) => candidate.childNodes.filter((child) => "tagName" in child && child.tagName === "li").length >= 3);
  if (!list || text(list).length < text(node).length * 0.6) return undefined;
  const items = list.childNodes.filter((child): child is Element => "tagName" in child && child.tagName === "li");
  const titles = items.slice(0, limits.headingListItems).map((item) => {
    const title = descendants(item, ["h2", "h3", "h4", "h5", "h6", "a"])[0];
    return `"${truncateWords(text(title ?? item), 12)}"`;
  });
  return `A list of ${items.length} items. The first ${titles.length} are: ${titles.join("; ")}.`;
}

interface Section {
  text: string;
  /** A heading over a form names the task; the labels and options under it are not prose about a topic. */
  isForm: boolean;
  /** Words outside lists. A teaser needs some, or there is nothing under its headline to compare with. */
  proseWords: number;
}

/** Text of the siblings after `heading`, up to the next heading of the same or a higher level. */
function sectionText(heading: Element): Section {
  // A heading wrapped in <header> or <hgroup> introduces what follows the wrapper.
  let start: Element = heading;
  while (start.parentNode && "tagName" in start.parentNode && ["header", "hgroup"].includes(start.parentNode.tagName)) {
    start = start.parentNode;
  }
  const siblings = start.parentNode?.childNodes ?? [];
  const parts: string[] = [];
  let proseWords = 0;
  let fields = 0;
  for (const node of siblings.slice(siblings.indexOf(start) + 1)) {
    if ("tagName" in node && HEADING.test(node.tagName) && node.tagName <= heading.tagName) break;
    if ("tagName" in node && isConsentUi(node)) continue;
    if ("tagName" in node) fields += (FIELDS.includes(node.tagName) ? 1 : 0) + descendants(node, FIELDS).length;
    const list = "tagName" in node ? describeList(node) : undefined;
    if (!list) proseWords += text(node).split(" ").filter(Boolean).length;
    parts.push(list ?? text(node));
  }
  return { text: parts.join(" ").replace(/\s+/g, " ").trim(), proseWords, isForm: fields >= 2 };
}

export default defineRule({
  id: "heading-describes-section",
  description: "A heading should describe the content it introduces.",
  // Headings can be legitimately playful or indirect, so only confident mismatches are errors.
  // Measured on real pages: indirect titles over on-topic content reach 0.66; a description copied from
  // another post scored 0.96, and the mismatched fixtures 0.81 and up.
  // Blind labels did not separate above 0.7 (true at 0.94, 0.87, 0.80; false at 0.91, 0.85, 0.78): whether a
  // heading fits is partly taste. So this rule raises a question and never an error.
  thresholds: { error: 1.1, warn: 0.9, review: 0.72 },

  select: (doc) =>
    doc.elements
      // The h1 titles the whole page, which the following siblings alone do not represent.
      .filter((el) => HEADING.test(el.tagName) && el.tagName !== "h1")
      .filter((el) => !isConsentUi(el))
      .map((el) => ({ el, heading: text(el), section: sectionText(el) }))
      // "· · ·" is a divider set in a heading element, with no topic to check.
      .filter(({ heading, section }) => /\p{L}/u.test(heading) && section.text.split(" ").length >= MIN_WORDS)
      // Blind labels: headings over a form or a dialog ("Book a Meeting") were judged against option lists
      // ("Country* United States Canada Afghanistan …"). They name what the form does, and whether that is
      // true of the fields is not this rule's question. One search box does not make a section a form.
      .filter(({ section }) => !section.isForm)
      // A headline that links to its article is a teaser. Under it sit bylines, tags, and related links,
      // which are about the article but do not read like it: on the corpus, news headlines over a list
      // of three authors scored 0.95. A teaser is judged only when it has an excerpt to be judged against.
      .filter(({ el, section }) => descendants(el, ["a"]).length === 0 || section.proseWords >= MIN_WORDS)
      .map(({ el, heading, section }) => ({
        loc: locOf(el),
        data: { heading, content_under_heading: truncateWords(section.text, limits.headingSectionWords) },
      })),

  questions: (ref) => ({
    on_topic: noul(
      `${ref("heading")} is a heading on a web page and ${ref("content_under_heading")} is the beginning of the content directly under it. Is the content about the topic that the heading names?`,
      {
        true: 'A reader who skipped to this heading because of its wording would find the topic they expected. A heading that invites an action ("Create an account", "Follow us", "Get in touch") fits content that leads to that action: the reasons to do it, or the places to do it.',
        false:
          "The content is about a different topic than the heading names, so a reader who skipped to this heading would be misled. The heading may be left over from a template or from earlier content.",
      },
    ),
  }),

  assess: ({ on_topic }, candidate) => ({
    p: 1 - on_topic.noul,
    message: `Heading "${candidate.data.heading}" does not describe the content under it.`,
  }),
});
