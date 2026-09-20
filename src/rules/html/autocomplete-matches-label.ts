import { choice } from "@typesafe-ai/sdk";
import { defineRule } from "../../engine/types.ts";
import { attr, fieldLabel, locOf } from "../../html/parse.ts";

// The personal-data purposes WCAG 1.3.5 is about, as autocomplete tokens. New and current passwords
// cannot be told apart from a label, so both count as "password".
const OPTIONS = {
  name: "The user's full name.",
  "given-name": "The user's first or given name only.",
  "family-name": "The user's last or family name only.",
  email: "The user's email address.",
  tel: "The user's telephone number.",
  "street-address": "The user's street address.",
  "postal-code": "The user's postal or ZIP code.",
  country: "The user's country.",
  organization: "The user's company or organisation.",
  username: "The user's username or account name.",
  password: "A password for the user's account.",
  "cc-name": "The name on the user's payment card.",
  "cc-number": "The user's payment card number.",
  "cc-exp": "The expiry date of the user's payment card.",
  "cc-csc": "The security code of the user's payment card, often called CVV or CVC.",
  bday: "The user's date of birth.",
  "one-time-code": "A verification code sent to the user.",
  none: "Anything that is not a piece of the user's own personal data: a search, a message, a quantity, a coupon code, someone else's details, or a value the user makes up.",
} as const;

const TEXT_TYPES = ["text", "email", "tel", "url", "password", "number", "date"];
const normalize = (token: string) => (token.endsWith("-password") ? "password" : token);

export default defineRule({
  id: "autocomplete-matches-label",
  description: "A field that asks for the user's own data should carry the matching autocomplete token (WCAG 1.3.5).",

  select: (doc) =>
    doc.elements
      .filter((el) => el.tagName === "input" && TEXT_TYPES.includes(attr(el, "type") ?? "text"))
      .map((el) => ({ el, label: fieldLabel(doc, el) }))
      .filter(({ label }) => label !== undefined)
      .map(({ el, label }) => {
        // axe checks that a token exists in the spec. Whether it is the right one depends on the label.
        // Section and hint tokens ("shipping", "home") come first; the purpose is the last token.
        const token = (attr(el, "autocomplete") ?? "").trim().toLowerCase().split(/\s+/).at(-1) ?? "";
        return {
          loc: locOf(el),
          // The same words as label-input-type, so both rules share one request.
          data: { label: label!, placeholder: attr(el, "placeholder") ?? null, name: attr(el, "name") ?? null },
          meta: { autocomplete: token },
        };
      })
      // "off" is a deliberate choice, and a token this rule has no option for cannot be compared.
      .filter(({ meta }) => meta.autocomplete === "" || normalize(meta.autocomplete) in OPTIONS),

  questions: (ref) => ({
    purpose: choice(
      `${ref("label")}, ${ref("placeholder")}, and ${ref("name")} are the label, placeholder, and name of one field in a web form. Which piece of the user's own personal data is this field asking for?`,
      OPTIONS,
    ),
  }),

  assess: ({ purpose }, candidate) => {
    const actual = normalize(candidate.meta!.autocomplete!);
    const label = candidate.data.label;
    if (actual === "") {
      return {
        p: 1 - purpose.probabilities.none,
        message: `Field "${label}" asks for the user's own data but has no autocomplete token, so browsers and assistive tools cannot fill or identify it.`,
        hint: `autocomplete="${purpose.choice}" matches what the label asks for.`,
      };
    }
    return {
      p: 1 - purpose.probabilities[actual as keyof typeof OPTIONS],
      message: `Field "${label}" has autocomplete="${candidate.meta!.autocomplete}", which is not what the label asks for.`,
      hint: purpose.choice === "none" ? "The label does not ask for the user's own data." : `autocomplete="${purpose.choice}" matches what the label asks for.`,
    };
  },
});
