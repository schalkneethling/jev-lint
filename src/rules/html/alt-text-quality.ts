import { noul } from "@typesafe-ai/sdk";
import { defineRule, type Candidate } from "../../engine/types.ts";
import { attr, closest, descendants, locOf, text } from "../../html/parse.ts";

// Screen readers already announce "image", so this opening is noise. A pattern, so code decides it.
const ANNOUNCES_MEDIUM = /^(an? )?(image|picture|photo|photograph|graphic|screenshot|illustration) (of|showing)\b/i;

export default defineRule({
  id: "alt-text-quality",
  description: "Alt text should describe the image, not name the file, announce itself, or repeat the caption.",
  // In blind labelling every sampled alt text scoring 0.33 to 0.39 was a real placeholder ("Map",
  // "instagram icon", "Mobile 2 - Dark"). This Noul is cautious, so review starts lower than elsewhere.
  thresholds: { review: 0.3 },

  select: (doc) =>
    doc.elements
      // Missing alt is a deterministic check; empty alt is a valid way to mark a decorative image.
      .filter((el) => el.tagName === "img" && (attr(el, "alt") ?? "").trim() !== "")
      .map((el): Candidate => {
        const alt = attr(el, "alt")!.trim();
        const figure = closest(el, ["figure"]);
        const caption = figure && descendants(figure, ["figcaption"])[0];
        return {
          loc: locOf(el),
          data: {
            alt,
            image_file_name: (attr(el, "src") ?? "").split(/[?#]/)[0]!.split("/").at(-1) ?? "",
            // Most images have no caption. The field is left out rather than sent as null, so the
            // state says nothing about a caption that does not exist.
            ...(caption && { caption_shown_with_image: text(caption) }),
          },
          ...(ANNOUNCES_MEDIUM.test(alt) && {
            // A redundancy, not a defect: the rest of such an alt text is usually a good description.
            decided: { p: 0.45, message: `Alt text "${alt}" announces that it is an image; screen readers already say "image".` },
          }),
        };
      }),

  // Two independent problems, so two questions. An alt text can have both, which one Choice cannot express.
  questions: (ref, candidate) => ({
    is_placeholder: noul(
      `${ref("alt")} is the alt text of an image whose file is named ${ref("image_file_name")}. Is the alt text a file name or a placeholder instead of a description of what the image shows?`,
      {
        true: 'It is a file name, contains a file extension, is the file name with separators removed, or is a lone generic word such as "image", "photo", "picture", "graphic", "logo", "icon", "banner", "screenshot", or "untitled".',
        false: "It describes, in ordinary words, what the image shows or conveys. A brand or product name as the alt text of a logo counts as a description.",
      },
    ),
    // Nothing to repeat without a caption, and code knows whether there is one: the question is left out.
    ...(candidate.data.caption_shown_with_image !== undefined && {
      // No criteria: the boundary is plain, and removing them changed nothing (scripts/criteria-experiment.ts).
      repeats_caption: noul(`${ref("alt")} is the alt text of an image and ${ref("caption_shown_with_image")} is the caption displayed under it. A screen reader reads both. Does the alt text say the same thing as the caption, in the same or nearly the same words?`),
    }),
  }),

  assess: ({ is_placeholder, repeats_caption }, candidate) => {
    const repeats = repeats_caption?.noul ?? 0;
    return is_placeholder.noul >= repeats
      ? { p: is_placeholder.noul, message: `Alt text "${candidate.data.alt}" is a file name or placeholder, not a description.` }
      : { p: repeats, message: `Alt text "${candidate.data.alt}" repeats the visible caption, so it is read out twice.` };
  },
});
