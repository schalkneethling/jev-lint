// Feasibility probe for ARIA rule ideas: not "is this ARIA valid" (a spec lookup, done by axe and
// html-validate) but "is this ARIA true". One isolated noul per case, expected answer known.
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { MODEL } from "../src/engine/client.ts";

const client = new TypeSafeClient({ defaultModel: MODEL });

interface Probe {
  idea: string;
  question: string;
  criteria?: { true: string; false: string };
  cases: { expect: "yes" | "no"; state: { [key: string]: string } }[];
}

const probes: Probe[] = [
  {
    // An aria-label on a control with visible text is only justified when it disambiguates, for
    // example several "Read more" links. Whether the label contains the visible text (WCAG 2.5.3)
    // and whether the visible text repeats on the page are both decided in code, not here.
    idea: "aria-label on a control with visible text adds disambiguating context",
    question:
      "`visible_text` is what sighted users read on a control and `aria_label` replaces it for screen reader users. Does `aria_label` add the specific subject that `visible_text` leaves out, so that this control can be told apart from others with the same visible text?",
    criteria: {
      true: 'It names the specific item, article, record, or section the control applies to, such as "Read more about the Postgres migration" or "Edit shipping address".',
      false: 'It adds nothing specific: it repeats the visible text, rephrases it, or only adds the kind of element or a gesture, such as "Read more link", "Delete button", or "Click to buy now".',
    },
    cases: [
      { expect: "yes", state: { visible_text: "Read more", aria_label: "Read more about the Postgres migration" } },
      { expect: "no", state: { visible_text: "Read more", aria_label: "Read more link" } },
      { expect: "yes", state: { visible_text: "Edit", aria_label: "Edit shipping address" } },
      { expect: "no", state: { visible_text: "Delete", aria_label: "Delete button" } },
      { expect: "no", state: { visible_text: "Buy now", aria_label: "Click to buy now" } },
      { expect: "yes", state: { visible_text: "View", aria_label: "View order 1042" } },
      { expect: "no", state: { visible_text: "Learn more", aria_label: "Learn more here" } },
      { expect: "yes", state: { visible_text: "Remove", aria_label: "Remove Blue cotton t-shirt from cart" } },
    ],
  },
  {
    idea: "aria-label is a usable name",
    question: "`aria_label` is the only name a screen reader announces for a control. Does it tell the user what the control does or where it leads?",
    criteria: {
      true: 'It names a specific action or destination, such as "Close dialog", "Search", or "Next slide".',
      false: 'It names only the kind of element or a generic gesture, such as "button", "icon", "link", "click", "image", or "menu item", or it is a CSS class or file name.',
    },
    cases: [
      { expect: "yes", state: { aria_label: "Close dialog" } },
      { expect: "no", state: { aria_label: "button" } },
      { expect: "no", state: { aria_label: "icon-btn-primary" } },
      { expect: "yes", state: { aria_label: "Open navigation menu" } },
      { expect: "no", state: { aria_label: "click" } },
    ],
  },
  {
    idea: "aria-hidden hides something screen reader users need",
    question:
      '`hidden_text` is inside an element with aria-hidden="true", so screen reader users never hear it. Does it carry information or instructions that a user needs?',
    criteria: {
      true: "It states a fact, status, error, price, instruction, or other content a user would miss.",
      false: "It is decoration or a visual duplicate: separators, bullets, arrows, star glyphs, icon ligature names, or punctuation.",
    },
    cases: [
      { expect: "yes", state: { hidden_text: "Your payment failed. Check your card details." } },
      { expect: "no", state: { hidden_text: "›" } },
      { expect: "no", state: { hidden_text: "★★★★☆" } },
      { expect: "yes", state: { hidden_text: "Only 2 left in stock" } },
      { expect: "no", state: { hidden_text: "chevron_right" } },
      { expect: "yes", state: { hidden_text: "Required field" } },
    ],
  },
  {
    idea: 'role="alert" / aria-live="assertive" is warranted',
    question:
      "`message` is announced to screen reader users immediately, interrupting whatever they are doing. Is it urgent enough to justify interrupting them?",
    criteria: {
      true: "It reports an error, a failure, a security or time-critical warning, or data loss.",
      false: "It is a success confirmation, a routine status update, marketing, a greeting, or a cookie notice, which should be announced politely or not at all.",
    },
    cases: [
      { expect: "yes", state: { message: "Your session expires in 1 minute. Save your work." } },
      { expect: "no", state: { message: "Welcome back! Check out our new autumn collection." } },
      { expect: "yes", state: { message: "Payment failed: your card was declined." } },
      { expect: "no", state: { message: "3 results found" } },
      { expect: "no", state: { message: "We use cookies to improve your experience." } },
    ],
  },
  {
    idea: "aria-describedby target actually describes the field",
    question: "`field_label` is a form field and `description` is the text linked to it with aria-describedby. Is the description about this field?",
    cases: [
      { expect: "yes", state: { field_label: "Password", description: "At least 12 characters, including one number." } },
      { expect: "no", state: { field_label: "Password", description: "We'll only use this to send your receipt." } },
      { expect: "yes", state: { field_label: "Email address", description: "We'll only use this to send your receipt." } },
      { expect: "no", state: { field_label: "Date of birth", description: "© 2026 Example Ltd. All rights reserved." } },
    ],
  },
];

let right = 0;
let total = 0;
for (const probe of probes) {
  const results = await Promise.all(
    probe.cases.map(async ({ expect, state }) => {
      const { answers } = await client.systemOne({ state, questions: { q: noul(probe.question, probe.criteria) } });
      return { expect, p: answers.q.noul, state };
    }),
  );
  const correct = results.filter((r) => (r.p >= 0.5) === (r.expect === "yes")).length;
  right += correct;
  total += results.length;
  console.log(`\n${probe.idea}: ${correct}/${results.length}`);
  for (const r of results) console.log(`  expect ${r.expect.padEnd(3)} p(yes)=${r.p.toFixed(2)}  ${Object.values(r.state).join("  |  ").slice(0, 100)}`);
}
console.log(`\n${right}/${total} on the right side of 0.5`);
