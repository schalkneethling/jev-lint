import { noul } from "@typesafe-ai/sdk";
import { defineRule } from "../../engine/types.ts";
import { attr, closest, isConsentUi, locOf, text, truncateWords, type Element } from "../../html/parse.ts";
import { limits } from "../limits.ts";

export default defineRule({
  id: "description-matches-page",
  description: "The meta description should describe the page it is on, not a page it was copied from.",

  // One candidate per document. Found on a real blog: a post whose description was copied from an
  // earlier post in the series. It is valid, non-empty, and unique enough to pass every other check.
  select: (doc) => {
    const meta = doc.elements.find((el) => el.tagName === "meta" && attr(el, "name")?.toLowerCase() === "description");
    const description = meta && attr(meta, "content")?.trim();
    const title = doc.elements.find((el) => el.tagName === "title");
    const heading = doc.elements.find((el) => el.tagName === "h1");
    const main = doc.elements.find((el) => el.tagName === "main") ?? doc.elements.find((el) => el.tagName === "article");
    // Paragraphs rather than all text: navigation and bylines say little about what the page is about.
    // Nor do cookie notices, dialogs, and footers, which on pages without a <main> came first in source order.
    const paragraphs = doc.elements
      .filter((el) => el.tagName === "p" && (!main || isInside(el, main)))
      .filter((el) => !isConsentUi(el) && !closest(el, ["nav", "footer", "header", "aside", "dialog", "form"]))
      .map((el) => text(el));
    const content = truncateWords(paragraphs.join(" ").trim(), limits.pageContentWords);
    // An empty or missing description is a deterministic check. Without content there is nothing to compare with.
    if (!meta || !description || content.split(" ").length < 15) return [];
    // On a home page the description is a statement about the brand and the content is whatever comes
    // first, and blind labels showed no separation between good and bad there (0.29 to 0.79, interleaved).
    // The defect this rule was written for, a description copied from another article, lives on article pages.
    const ogType = doc.elements.find((el) => el.tagName === "meta" && attr(el, "property") === "og:type");
    // Home pages are full of <article> teaser cards, so an <article> alone proves nothing: the page is an
    // article when its h1 sits inside one, or when it says so itself.
    const isArticle = (heading !== undefined && closest(heading, ["article"]) !== undefined) || (ogType ? attr(ogType, "content") : "") === "article";
    if (!isArticle) return [];
    return [
      {
        loc: locOf(meta),
        data: {
          meta_description: description,
          page_title: title ? text(title) : null,
          main_heading: heading ? text(heading) : null,
          start_of_page_content: content,
        },
      },
    ];
  },

  questions: (ref) => ({
    // No criteria: the boundary is plain, and removing them changed nothing (scripts/criteria-experiment.ts).
    describes_another_page: noul(
      `${ref("meta_description")} is the description search engines and link previews show for a web page. ${ref("page_title")}, ${ref("main_heading")}, and ${ref("start_of_page_content")} are taken from that page. Is the description about a different subject than the page?`,
    ),
  }),

  assess: ({ describes_another_page }, candidate) => ({
    p: describes_another_page.noul,
    message: `The meta description is about a different subject than the page: "${candidate.data.meta_description}"`,
    hint: `The page's heading is "${candidate.data.main_heading ?? candidate.data.page_title}".`,
  }),
});

function isInside(el: Element, ancestor: Element): boolean {
  for (let node = el.parentNode; node; node = "parentNode" in node ? node.parentNode : null) if (node === ancestor) return true;
  return false;
}
