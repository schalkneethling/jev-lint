import { choice } from "@typesafe-ai/sdk";
import { defineRule } from "../../engine/types.ts";
import { attr, closest, locOf, text } from "../../html/parse.ts";

/** Input `type` values this rule covers, mapped to the option that means "this type is right". */
const TYPE_TO_OPTION: Record<string, Option> = {
  text: "free_text",
  email: "email",
  tel: "tel",
  url: "url",
  number: "number",
  password: "password",
  search: "search",
  date: "date",
};

const OPTIONS = {
  email: "One email address.",
  tel: "A telephone number.",
  url: "A web address (URL).",
  number:
    "A quantity or measurement that can meaningfully go up or down by one, such as an age, an amount, a count, or a weight.",
  date:
    'A specific calendar day, always including a day of the month, such as a departure, arrival, check-in, check-out, date of birth, the start or end of a booking (including a "from" or "to" date), or the expiry date on a passport, visa, or other ID document — even when the label does not use the word "date". A payment card\'s expiry is not this option: it gives only a month and year (MM/YY), with no day of the month, so it belongs under "anything else" below.',
  password: "A password, passphrase, or PIN that must be hidden while typing.",
  search: "A search query.",
  free_text:
    "Anything else, including names, addresses, and identifiers made of digits that are not quantities, such as postal codes, card numbers, account numbers, verification codes, and a payment card's expiry (MM/YY: a month and year, not a calendar day).",
} as const;

type Option = keyof typeof OPTIONS;

const OPTION_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_OPTION).map(([type, option]) => [option, type]));

// A field typed search may ask for free text: the two accept the same values. The other direction was
// argued both ways. On the corpus 109 "errors" were search boxes typed as text, which was noise at that
// severity, so the rule stopped reporting them; then blind labelling judged type="search" to be the right
// type for a search box. So it is reported again, held at review by SEARCH_BOX_TYPED_AS_TEXT below.
const matching = (type: string): Option[] => (type === "search" ? ["free_text", "search"] : [TYPE_TO_OPTION[type]!]);

// A real mismatch but a cosmetic one: type="text" works as a search box in every browser. A fixed value
// rather than a scaled one, so it cannot reach warn or error however sure Jev is.
const SEARCH_BOX_TYPED_AS_TEXT = 0.5;

export default defineRule({
  id: "label-input-type",
  description: "An input's type should match the kind of value its label asks for.",

  select: (doc) => {
    const labelsByFor = new Map(
      doc.elements.filter((el) => el.tagName === "label" && attr(el, "for")).map((el) => [attr(el, "for")!, el]),
    );
    return doc.elements
      .filter((el) => el.tagName === "input" && (attr(el, "type") ?? "text") in TYPE_TO_OPTION)
      .map((el) => {
        const label = labelsByFor.get(attr(el, "id") ?? "") ?? closest(el, ["label"]);
        return {
          loc: locOf(el),
          data: {
            label: attr(el, "aria-label") ?? (label ? text(label) : null),
            placeholder: attr(el, "placeholder") ?? null,
            name: attr(el, "name") ?? null,
          },
          // The model must not see the answer it is being checked against.
          meta: { type: attr(el, "type") ?? "text" },
        };
      })
      .filter(({ data }) => data.label !== null || data.placeholder !== null);
  },

  // The fields are named one by one rather than as "the candidate": the state has no wrapper to point at.
  questions: (ref) => ({
    value_kind: choice(
      `${ref("label")}, ${ref("placeholder")} and ${ref("name")} are the label, the placeholder and the name of one text field in a web form. What kind of value is the user being asked to type into this field?`,
      OPTIONS,
    ),
  }),

  assess: ({ value_kind }, candidate) => {
    const actualType = candidate.meta!.type!;
    const label = candidate.data.label ?? candidate.data.placeholder;
    const expected = OPTION_TO_TYPE[value_kind.choice]!;
    const p = 1 - matching(actualType).reduce((sum, option) => sum + value_kind.probabilities[option], 0);
    return {
      p: actualType === "text" && value_kind.choice === "search" ? SEARCH_BOX_TYPED_AS_TEXT : p,
      message: `Field "${label}" asks for a ${value_kind.choice.replace("_", " ")} value, but the input is type="${actualType}".`,
      hint: `type="${expected}" matches what the label asks for.`,
    };
  },
});
