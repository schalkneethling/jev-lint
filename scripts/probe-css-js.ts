// Quick feasibility probe for CSS and JS rule ideas. Each case is one isolated noul whose
// expected answer is known; the output shows how far apart Jev puts the good and bad cases.
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { MODEL } from "../src/engine/client.ts";

const client = new TypeSafeClient({ defaultModel: MODEL });

interface Probe {
  idea: string;
  question: string;
  cases: { expect: "yes" | "no"; state: { [key: string]: string } }[];
}

const probes: Probe[] = [
  {
    idea: "css: class name vs declarations",
    question:
      "`selector` is a CSS class name and `declarations` is what the rule does. Do the declarations do what the class name promises?",
    cases: [
      { expect: "yes", state: { selector: ".text-center", declarations: "text-align: center;" } },
      { expect: "no", state: { selector: ".text-red", declarations: "color: blue;" } },
      { expect: "no", state: { selector: ".text-center", declarations: "text-align: left; font-weight: bold;" } },
      { expect: "yes", state: { selector: ".hidden", declarations: "display: none;" } },
      { expect: "no", state: { selector: ".is-visible", declarations: "display: none;" } },
      { expect: "yes", state: { selector: ".card--rounded", declarations: "border-radius: 0.5rem;" } },
    ],
  },
  {
    idea: "css: visually-hidden must stay available to screen readers",
    question:
      "`selector` names a utility meant to hide content visually while keeping it available to screen readers. `display: none` and `visibility: hidden` also hide content from screen readers. Do `declarations` keep the content available to screen readers?",
    cases: [
      { expect: "no", state: { selector: ".visually-hidden", declarations: "display: none;" } },
      { expect: "no", state: { selector: ".sr-only", declarations: "visibility: hidden;" } },
      { expect: "yes", state: { selector: ".visually-hidden", declarations: "position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;" } },
    ],
  },
  {
    idea: "css: custom property name vs value kind",
    question: "`name` is a CSS custom property and `value` is its value. Is the value the kind of thing the name says it holds?",
    cases: [
      { expect: "yes", state: { name: "--color-primary", value: "rebeccapurple" } },
      { expect: "no", state: { name: "--color-primary", value: "1.5rem" } },
      { expect: "yes", state: { name: "--space-large", value: "2rem" } },
      { expect: "no", state: { name: "--font-family-body", value: "400ms ease-in" } },
    ],
  },
  {
    idea: "css/js: comment contradicts code",
    question: "`comment` sits directly above `code`. Does the comment accurately describe what the code does?",
    cases: [
      { expect: "yes", state: { comment: "/* Stack the columns on small screens */", code: "@media (width < 40rem) { .grid { grid-template-columns: 1fr; } }" } },
      { expect: "no", state: { comment: "/* Hide the sidebar on small screens */", code: "@media (width < 40rem) { .grid { grid-template-columns: 1fr; } }" } },
      { expect: "yes", state: { comment: "// Sort newest first", code: "posts.sort((a, b) => b.date - a.date);" } },
      { expect: "no", state: { comment: "// Remove duplicate tags", code: "tags = tags.map((tag) => tag.toLowerCase());" } },
      { expect: "no", state: { comment: "// Retry up to 3 times", code: "for (let attempt = 0; attempt < 5; attempt++) { await send(); }" } },
    ],
  },
  {
    idea: "js: function name vs body",
    question: "`name` is a function's name and `body` is its code. Does the function do only what its name says?",
    cases: [
      { expect: "yes", state: { name: "getUserById", body: "return users.find((user) => user.id === id);" } },
      { expect: "no", state: { name: "getUserById", body: "const user = users.find((u) => u.id === id); db.delete(user); return user;" } },
      { expect: "no", state: { name: "isValidEmail", body: "sendWelcomeEmail(value); return value.includes('@');" } },
      { expect: "yes", state: { name: "formatPrice", body: "return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount);" } },
      { expect: "no", state: { name: "validateForm", body: "localStorage.clear(); window.location.href = '/';" } },
    ],
  },
  {
    idea: "js: user-facing error message is actionable",
    question: "`message` is an error shown to an end user. Does it say what went wrong in plain language and what the user can do next?",
    cases: [
      { expect: "yes", state: { message: "We couldn't save your changes because you're offline. Reconnect and try again." } },
      { expect: "no", state: { message: "Error: ECONNRESET" } },
      { expect: "no", state: { message: "Something went wrong." } },
      { expect: "no", state: { message: "Invalid input. You entered the wrong value again." } },
      { expect: "yes", state: { message: "That email address is already registered. Sign in instead, or reset your password." } },
    ],
  },
  {
    idea: "js: test title vs assertions",
    question: "`title` is a test's title and `body` is the test code. Does the test check what its title claims?",
    cases: [
      { expect: "yes", state: { title: "returns an empty array when there are no posts", body: "assert.deepEqual(listPosts([]), []);" } },
      { expect: "no", state: { title: "throws when the id is missing", body: "assert.equal(getPost('42').title, 'Hello');" } },
      { expect: "no", state: { title: "sorts posts newest first", body: "const posts = listPosts(data); assert.equal(posts.length, 3);" } },
    ],
  },
];

for (const probe of probes) {
  const results = await Promise.all(
    probe.cases.map(async ({ expect, state }) => {
      const { answers } = await client.systemOne({ state, questions: { q: noul(probe.question) } });
      return { expect, p: answers.q.noul, state };
    }),
  );
  const correct = results.filter((r) => (r.p >= 0.5) === (r.expect === "yes")).length;
  console.log(`\n${probe.idea}: ${correct}/${results.length} on the right side of 0.5`);
  for (const r of results) console.log(`  expect ${r.expect.padEnd(3)} p(yes)=${r.p.toFixed(2)}  ${Object.values(r.state).join("  |  ").slice(0, 110)}`);
}
