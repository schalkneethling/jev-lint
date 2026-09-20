import assert from "node:assert/strict";
import { test } from "node:test";
import { DYNAMIC, parseJsx } from "../src/code/jsx.ts";
import type { Ask } from "../src/engine/client.ts";
import { run } from "../src/engine/run.ts";
import { attr, text } from "../src/html/parse.ts";
import linkTextPurpose from "../src/rules/html/link-text-purpose.ts";

const source = `
export function Card({ items, title, open }) {
  return (
    <section className="card">
      <label htmlFor="q">Search</label>
      <input id="q" autoComplete="off" disabled aria-label={\`Search\`} />
      <h2>{title}</h2>
      <a href="/pricing">Pricing</a>
      <a href={items[0].url}>Read {"more"}</a>
      {items.map((item) => <li key={item.id}><a href="#">Remove</a></li>)}
      {open && <Dialog><p>Are you sure?</p></Dialog>}
      {/* a comment is not content */}
    </section>
  );
}`;

test("JSX becomes elements with HTML attribute names, stated values, and source positions", async () => {
  const doc = await parseJsx("Card.tsx", source);
  const input = doc.elements.find((el) => el.tagName === "input")!;
  assert.deepEqual(input.attrs, [
    { name: "id", value: "q" },
    { name: "autocomplete", value: "off" },
    { name: "disabled", value: "" },
    { name: "aria-label", value: "Search" },
  ]);
  assert.equal(attr(doc.elements.find((el) => el.tagName === "label")!, "for"), "q");
  assert.equal(attr(doc.elements[0]!, "class"), "card");
  assert.deepEqual([input.sourceCodeLocation!.startLine, input.sourceCodeLocation!.startCol], [6, 7]);
});

test("values computed at run time are marked, and markup inside expressions is still read", async () => {
  const doc = await parseJsx("Card.tsx", source);
  const links = doc.elements.filter((el) => el.tagName === "a");
  assert.deepEqual(links.map((el) => [attr(el, "href"), text(el)]), [["/pricing", "Pricing"], [DYNAMIC, "Read more"], ["#", "Remove"]]);
  assert.equal(text(doc.elements.find((el) => el.tagName === "h2")!), DYNAMIC);
  // A component is a transparent container: its children are read, and it matches no HTML rule.
  assert.deepEqual(doc.elements.filter((el) => el.tagName === "Dialog" || el.tagName === "p").map((el) => el.tagName), ["Dialog", "p"]);
  assert.ok(!text(doc.elements[0]!).includes("comment"));
});

test("a file without JSX yields no elements", async () => {
  assert.deepEqual((await parseJsx("plain.ts", "export const a = 1;")).elements, []);
});

test("HTML rules run on JSX, and a candidate whose words are dynamic is never asked about", async () => {
  const asked: unknown[] = [];
  const ask: Ask = async (state, questions) => {
    asked.push(state);
    return {
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul" as const, noul: 0.9 }])),
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  const jsx = `const A = ({ name }) => <p><a href="/a">Click here</a> <a href="/b">{name}</a> <a href="/c">Hello {name}</a></p>;`;
  const { findings } = await run([{ path: "A.tsx", source: jsx }], { rules: [linkTextPurpose], ask, isolation: "candidate" });
  assert.deepEqual(asked, [{ candidate: { link_text: "Click here" } }]);
  assert.deepEqual(findings.map((f) => [f.file, f.loc.line, f.ruleId]), [["A.tsx", 1, "link-text-purpose"]]);
});
