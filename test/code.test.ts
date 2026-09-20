import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCode } from "../src/code/parse.ts";
import type { Ask } from "../src/engine/client.ts";
import { run } from "../src/engine/run.ts";
import commentDescribesCode from "../src/rules/code/comment-describes-code.ts";
import commentGivesReason from "../src/rules/code/comment-gives-reason.ts";
import { commentCandidates } from "../src/rules/code/shared.ts";

const source = `
export function getUser(id: string) {
  return users.get(id);
}

const isAdmin = (user: User) => user.role === "admin";

class Cart {
  constructor() {}
  total() {
    return 0;
  }
}

// Newest first, because the feed
// only renders the first ten.
posts.sort(byDate);

// eslint-disable-next-line no-console
console.log(posts);

/** Returns the post. */
function getPost() {}

save(); // trailing

// orphaned: a blank line follows

done();

test("sorts posts", () => {
  assert.ok(true);
});
`;

test("the query file extracts named functions, methods and arrow functions, but not constructors", async () => {
  const doc = await parseCode("sample.ts", source);
  assert.deepEqual(doc.functions.map((fn) => fn.name), ["getUser", "isAdmin", "total", "getPost"]);
  assert.equal(doc.functions[1]!.body, 'user.role === "admin"');
  assert.deepEqual(doc.functions[0]!.loc.line, 2);
});

test("the same query file serves plain JavaScript", async () => {
  const doc = await parseCode("sample.js", "function loadSettings() { return 1; }");
  assert.deepEqual(doc.functions.map((fn) => fn.name), ["loadSettings"]);
});

test("tests are found by runner name, with title and callback", async () => {
  const doc = await parseCode("sample.ts", source);
  assert.deepEqual(doc.tests.map((t) => [t.title, t.loc.line]), [["sorts posts", 31]]);
  assert.match(doc.tests[0]!.body, /assert\.ok/);
});

test("adjacent line comments are joined and paired with the statement below; trailing and orphaned ones are dropped", async () => {
  const doc = await parseCode("sample.ts", source);
  assert.deepEqual(
    doc.comments.map((c) => [c.kind, c.text, c.code]),
    [
      ["line", "Newest first, because the feed only renders the first ten.", "posts.sort(byDate);"],
      ["line", "eslint-disable-next-line no-console", "console.log(posts);"],
      ["doc", "Returns the post.", "function getPost() {}"],
    ],
  );
});

test("a comment inside a method chain is paired with the whole call, and a file header with nothing", async () => {
  const chained = `// Describes this file.
import { a } from "a";

const visible = files
  // Zero-byte files are unfinished uploads.
  .filter((file) => file.size > 0)
  .map((file) => file.name);
`;
  const doc = await parseCode("chain.ts", chained);
  assert.deepEqual(doc.comments.map((c) => c.code), [".filter((file) => file.size > 0)"]);
});

test("comment rules skip tool directives and API docs", async () => {
  const doc = await parseCode("sample.ts", source);
  assert.deepEqual(commentCandidates(doc).map((c) => c.data.code), ["posts.sort(byDate);"]);
});

test("rules that judge the same words share one request", async () => {
  const seen: string[][] = [];
  const ask: Ask = async (_state, questions) => {
    seen.push(Object.keys(questions));
    return {
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul" as const, noul: 0.5 }])),
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  const { judgements } = await run([{ path: "sample.ts", source }], {
    rules: [commentDescribesCode, commentGivesReason],
    ask,
    isolation: "candidate",
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.length, 3);
  assert.deepEqual(judgements.map((j) => Object.keys(j.answers)), [["describes_behaviour", "accurate"], ["only_restates"]]);
});

test("an empty catch is found with the comment inside it; a catch that does something is not", async () => {
  const doc = await parseCode(
    "c.ts",
    `try { a(); } catch { /* ignore */ }
     try { b(); } catch {}
     try { c(); } catch (error) { report(error); }`,
  );
  assert.deepEqual(doc.emptyCatches.map((c) => [c.comment, c.tried.replace(/\s+/g, " ")]), [["ignore", "{ a(); }"], ["", "{ b(); }"]]);
});

test("function-name-matches-body leaves out functions named for when they run", async () => {
  const { default: rule } = await import("../src/rules/code/function-name-matches-body.ts");
  const doc = await parseCode("f.ts", `function onEnd() {} function handleClick() {} class A { attributeChangedCallback() {} getUser() {} }`);
  assert.deepEqual(rule.select(doc).map((c) => c.data.name), ["getUser"]);
});
