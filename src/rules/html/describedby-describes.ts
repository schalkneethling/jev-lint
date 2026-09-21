import { choice } from "@typesafe-ai/sdk";
import { defineRule, type Candidate } from "../../engine/types.ts";
import { attr, byId, fieldLabel, locOf, text, truncateWords } from "../../html/parse.ts";
import { limits } from "../limits.ts";

const FIELDS = ["input", "select", "textarea"];

const KINDS = {
  email: "An email address.",
  telephone: "A telephone number.",
  password: "A password, passphrase, or PIN.",
  date: "A date or a time.",
  person_name: "A person's name.",
  address: "A street address, city, postal code, or country.",
  payment_card: "A payment card number, expiry date, or security code.",
  number: "A quantity, amount, or measurement.",
  other: "Some other kind of value.",
} as const;

type Kind = keyof typeof KINDS;

const words = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// "Last *" described by "Last". A long label that happens to contain a short hint is not a repeat.
const repeats = (label: string, description: string) =>
  words(label).includes(words(description)) && words(label).split(" ").length <= words(description).split(" ").length + 2;

export default defineRule({
  id: "describedby-describes",
  description: "Text linked to a field with aria-describedby should be about that field.",

  select: (doc) =>
    doc.elements
      .filter((el) => FIELDS.includes(el.tagName) && attr(el, "aria-describedby"))
      .map((el) => {
        // Ids that resolve to nothing are an ARIA validity error, which axe reports. Only what resolves is judged.
        const targets = attr(el, "aria-describedby")!.split(/\s+/).map((id) => byId(doc, id)).filter((target) => target !== undefined);
        return { el, label: fieldLabel(doc, el), description: targets.map((target) => text(target)).join(" ").trim() };
      })
      .filter(({ label, description }) => label !== undefined && description !== "")
      .map(({ el, label, description }): Candidate => ({
        loc: locOf(el),
        data: { field_label: label!, description_announced_after_label: truncateWords(description, limits.fieldDescriptionWords) },
        meta: { describedby: attr(el, "aria-describedby")! },
        // Both are announced, one after the other. Whether one repeats the other is a string comparison.
        // Blind labels: all three defects the rule missed were this, and none was "about another field".
        ...(repeats(label!, description) && {
          decided: {
            p: 0.7,
            message: `Field "${label}" is described by text that only repeats its label, so a screen reader says it twice: "${truncateWords(description, 12)}"`,
            hint: `Remove aria-describedby="${attr(el, "aria-describedby")}" or point it at real help text.`,
          },
        }),
      })),

  // Asked together ("is this description about this field?"), a phone-number hint on a password field
  // scored 0.13: read literally it is a format hint, and a format hint "applies to a field". So each
  // text is classified alone, without sight of the other, and code compares the two.
  questions: (ref) => ({
    label_asks_for: choice(`${ref("field_label")} is the label of one field in a web form. What kind of value does the label ask for?`, KINDS),
    description_is_for: choice(
      `${ref("description_announced_after_label")} is help text in a web form. Judging the help text by itself, what kind of field was it written for?`,
      {
        ...KINDS,
        any_field: "It could sit under any field: that the field is required or optional, how the data is used, or a privacy note.",
        not_field_help: "It is not help for a form field at all: a heading, a copyright line, marketing copy, or a progress indicator.",
      },
    ),
  }),

  assess: ({ label_asks_for, description_is_for }, candidate) => {
    // The probability that both texts name the same kind, summed over kinds. "other" on both sides counts
    // as agreement because two unnamed kinds cannot be told apart here.
    const agree = (Object.keys(KINDS) as Kind[]).reduce((sum, kind) => sum + label_asks_for.probabilities[kind] * description_is_for.probabilities[kind], 0);
    return {
      p: 1 - description_is_for.probabilities.any_field - agree,
      message: `Field "${candidate.data.field_label}" is described by text written for something else: "${candidate.data.description_announced_after_label}"`,
      hint: `The description reads as ${description_is_for.choice.replaceAll("_", " ")}; aria-describedby="${candidate.meta!.describedby}" may point at the wrong element after a refactor.`,
    };
  },
});
