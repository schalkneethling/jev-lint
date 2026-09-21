import { noul } from "@typesafe-ai/sdk";
import { defineRule, type Candidate, type Ref } from "../../engine/types.ts";
import { attr, locOf, nearestHeading, text, truncateWords } from "../../html/parse.ts";

/**
 * Is the text at `field` interchangeable filler? Shared with `aria-label-justified`, which asks the
 * same thing about a control's visible text.
 *
 * This asks for the defect, not for the virtue. An earlier version asked whether the text "names the
 * specific page, resource, or action". Read literally, a post title such as "What if...", a tag such
 * as "testing", and "you can download a free copy here" all fail that, and every report on real
 * pages was a false positive. "Specific enough" has no boundary; "says nothing" does.
 */
export const isFillerText = (field: string) =>
  noul(
    `${field} is the complete text of a link or button on a web page. Is this text made up only of filler words that could sit on any link on any website, so that it says nothing about what this particular link leads to?`,
    {
      true: 'Every word is generic: for example "click here", "here", "this", "this page", "link", "read more", "learn more", "more", "more info", "details", "continue", or "go". Text that is only a date, a time, or a number also counts.',
      false:
        'At least part of the text says something about what is behind the link. This includes a title of any kind, however short, playful, or vague ("What if...", "Because I want it to exist"); a name, a username or handle, a topic, or a tag ("testing", "open-source"); a navigation label that names a section of a site, even a single word ("new", "jobs", "pricing"); a site or domain name; a count of something ("108 comments"); and a phrase that names what the user gets or does, even when it also contains filler words ("you can download a free copy here", "get in touch", "experiment with the code").',
    },
  );

/**
 * WCAG 2.4.4 judges link purpose in context, and lists the preceding heading as an advisory way to
 * supply it (technique H80). A one-word tag under "Tags" is clear; "click here" under "Pricing" is
 * not, because the heading names a topic and the link names nothing in it. Asking whether the text
 * is an item of the kind the heading announces separates the two without weighing them in one question.
 */
const isItemUnderHeading = (ref: Ref) =>
  noul(
    `${ref("link_text")} is the text of a link and ${ref("heading_above_link")} is the heading it sits under. Does the heading announce a set of things, and is the link text one of those things?`,
    {
      true: 'The heading names a collection and the link text is a member of it: a tag under "Tags", a year under "Archive", a person under "Contributors", a category under "Categories", a page under "Related articles".',
      false:
        'The link text is not an item of a collection the heading names. Pointer phrases such as "click here", "here", "read more", or "learn more" are never items, whatever the heading says.',
    },
  );

// A raw URL read aloud character by character is noise, and recognising one is a pattern match.
const RAW_URL = /^(https?:\/\/|www\.)\S+$/i;

export default defineRule({
  id: "link-text-purpose",
  description: "Link text should say something about what the link leads to, not only filler such as \"click here\".",

  select: (doc) => {
    const links = doc.elements
      .filter((el) => el.tagName === "a" && attr(el, "href") !== undefined)
      .map((el) => ({ el, name: attr(el, "aria-label") ?? text(el), href: attr(el, "href")! }))
      // A link with no accessible name at all is a job for a deterministic linter.
      .filter(({ name }) => name !== "")
      // On a tel: or mailto: link the number or address is the destination, and showing it is the point.
      .filter(({ name, href }) => !(/^(tel|sms):/i.test(href) && /\d{3}/.test(name)) && !(/^mailto:/i.test(href) && name.includes("@")));

    // One name on links to different places is ambiguous however good the name is, and counting
    // destinations per name is code's job. Six cards all labelled "Card link" is the typical case.
    const destinations = new Map<string, Set<string>>();
    for (const { name, href } of links) {
      const key = name.toLowerCase();
      destinations.set(key, (destinations.get(key) ?? new Set()).add(href.replace(/\/$/, "")));
    }

    // An ambiguous name is one problem, not one per link: report it where it first appears.
    const reported = new Set<string>();
    const once = links.filter(({ name }) => {
      const key = name.toLowerCase();
      if (destinations.get(key)!.size < 2) return true;
      if (reported.has(key)) return false;
      reported.add(key);
      return true;
    });

    return once.map(({ el, name, href }): Candidate => {
      const heading = nearestHeading(doc, el) ?? "";
      const container = el.parentNode && "tagName" in el.parentNode ? truncateWords(text(el.parentNode), 14) : "";
      const meta = {
        href,
        destinations_sharing_this_text: String(destinations.get(name.toLowerCase())!.size),
        destinations: [...destinations.get(name.toLowerCase())!].slice(0, 8).join(" "),
        // An overlay link covers a card whose own text names the subject; that text is the likely fix.
        text_of_containing_element: container === name ? "" : container,
      };
      // The href is withheld from the model: screen reader users browsing a list of links hear only the
      // text. The heading is part of what they perceive, so it is shown when there is one.
      const candidate: Candidate = { loc: locOf(el), data: { link_text: name, ...(heading && { heading_above_link: heading }) }, meta };
      if (RAW_URL.test(name)) {
        candidate.decided = { p: 0.85, message: `Link text "${name}" is a raw URL, which a screen reader reads out character by character.`, hint: hint(candidate) };
      }
      return candidate;
    });
  },

  questions: (ref, candidate) => ({
    is_filler: isFillerText(ref("link_text")),
    // The heading only ever rescues a link that has one and whose name is its own. A name shared by
    // several destinations is reported on that fact, so the answer would be thrown away: it is not asked.
    ...(candidate.data.heading_above_link !== undefined &&
      Number(candidate.meta!.destinations_sharing_this_text) === 1 && { is_item_under_heading: isItemUnderHeading(ref) }),
  }),

  assess: ({ is_filler, is_item_under_heading }, candidate) => {
    const shared = Number(candidate.meta!.destinations_sharing_this_text);
    if (shared > 1) {
      // The heading cannot tell same-named links apart, so it rescues nothing here, and a name already
      // known to be ambiguous needs half the evidence to be reported.
      return {
        p: 1 - (1 - is_filler.noul) * 0.5,
        message: `${shared} links named "${candidate.data.link_text}" go to different places, so the name cannot tell them apart. This is the first.`,
        hint: hint(candidate),
      };
    }
    return {
      // Filler is only a problem when the context does not resolve it. With no heading there is no context.
      p: is_filler.noul * (1 - (is_item_under_heading?.noul ?? 0)),
      message: `Link text "${candidate.data.link_text}" is filler: it says nothing about what the link leads to.`,
      hint: hint(candidate),
    };
  },
});

function hint({ data, meta }: Candidate): string {
  return [
    Number(meta!.destinations_sharing_this_text) > 1 ? `They go to ${meta!.destinations!.split(" ").join(", ")}.` : `It goes to ${meta!.href}.`,
    meta!.text_of_containing_element && `The element around it reads "${meta!.text_of_containing_element}".`,
    data.heading_above_link && `The heading above it is "${data.heading_above_link}".`,
  ]
    .filter(Boolean)
    .join(" ");
}
