import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCode } from "../src/code/parse.ts";
import functionNameMatchesBody from "../src/rules/code/function-name-matches-body.ts";
import { commentCandidates, isTestFile } from "../src/rules/code/shared.ts";
import testTitleMatchesBodyNext from "../src/rules/code/test-title-matches-body-next.ts";
import testTitleMatchesBody from "../src/rules/code/test-title-matches-body.ts";

test("a function carries its JSDoc summary, its parameters, and where it is declared", async () => {
  const doc = await parseCode(
    "f.ts",
    `/**
 * Returns the user.
 * @param id the id
 */
export function getUser(id: string) { return 1; }

/** Not adjacent. */

function loose() {}

const handler = { get(target, prop) { return 1; } };
class Store {
  // Reads the value
  // stored under a key.
  read(key) { return 1; }
}
save(); // a trailing comment is about its own line
function after() {}`,
  );
  assert.deepEqual(
    doc.functions.map((fn) => [fn.name, fn.doc, fn.params, fn.container]),
    [
      ["getUser", "Returns the user. @param id the id", "(id: string)", "scope"],
      ["loose", "", "()", "scope"],
      ["get", "", "(target, prop)", "object"],
      // A run of line comments directly above a function documents it as a JSDoc block would.
      ["read", "Reads the value stored under a key.", "(key)", "class"],
      ["after", "", "()", "scope"],
    ],
  );
});

test("a comment is paired with its paragraph and with the section it heads, which stops at the next comment", async () => {
  const doc = await parseCode(
    "c.ts",
    `setup();
// Check that the database is up.
log("checking");

try { connect(); } catch (e) { fail(e); }
// Then migrate.
migrate();`,
  );
  assert.deepEqual(
    doc.comments.map((comment) => [comment.text, comment.code, comment.section.replace(/\s+/g, " ")]),
    [
      ["Check that the database is up.", 'log("checking");', 'log("checking"); try { connect(); } catch (e) { fail(e); }'],
      ["Then migrate.", "migrate();", "migrate();"],
    ],
  );
  // The comment rules classify the section, and record whether it is one line of code.
  assert.deepEqual(commentCandidates(doc).map((candidate) => candidate.meta!.statements), ["several", "one"]);
});

test("a comment that opens a function body heads the whole body, past any later comment", async () => {
  const doc = await parseCode(
    "c.ts",
    `function isDirty(elm, value) {
  // return true when the textbox loses focus and its value differs
  let notInFocus = true;
  // work around a browser bug
  try { notInFocus = document.activeElement !== elm; } catch (e) {}
  return notInFocus && elm.value !== value;
}`,
  );
  assert.match(doc.comments[0]!.section, /^let notInFocus = true;[\s\S]*return notInFocus && elm\.value !== value;$/);
  assert.equal(doc.comments[1]!.section.replace(/\s+/g, " "), "try { notInFocus = document.activeElement !== elm; } catch (e) {} return notInFocus && elm.value !== value;");
});

test("a comment over code the parser could not read is not a candidate", async () => {
  const pseudo = await parseCode("cheatsheet.js", `// Generate a helper.\nsails generate helper <name> --flag\n`);
  assert.equal(pseudo.comments[0]!.unparsed, true);
  assert.deepEqual(commentCandidates(pseudo), []);

});

test("a comment's lines run through the code it heads, so a change to that code reaches it", async () => {
  // The section does not stop at a blank line, only at the next comment or the end of the block.
  const doc = await parseCode("c.ts", `// Sort newest first.\nposts.sort(byDate);\nrender(posts);\n\nother();\n// Next.\nlast();`);
  assert.deepEqual(doc.comments[0]!.loc.lines, { first: 1, last: 5 });
});

test("test hooks are not tests; suites are recorded outermost first; an assertion is the parser's call", async () => {
  const doc = await parseCode(
    "t.test.ts",
    `test.before("setup", () => { seed(); });
describe("config", () => {
  describe.only("silent", () => {
    it("should be false by default", () => { warn("x"); expect("x").toHaveBeenWarned(); });
    it.skip("smoke", async () => { await run(); });
  });
});`,
  );
  assert.deepEqual(
    doc.tests.map((t) => [t.title, t.suites, t.hasAssertion]),
    [
      ["should be false by default", ["config", "silent"], true],
      ["smoke", ["config", "silent"], false],
    ],
  );
  // A test with no assertion claims only that the code runs, so its title is not classified.
  const body = '() => { warn("x"); expect("x").toHaveBeenWarned(); }';
  assert.deepEqual(testTitleMatchesBody.select(doc).map((candidate) => candidate.data), [{ title: "should be false by default", body }]);
  // The experimental rewrite also sends the suites, without which this title is half a sentence.
  assert.deepEqual(testTitleMatchesBodyNext.select(doc).map((candidate) => candidate.data), [{ suite: "config > silent", title: "should be false by default", body }]);
});

test("a guard is an if whose only consequence is to throw a literal message, with what had to hold to reach it", async () => {
  const doc = await parseCode(
    "g.ts",
    `function f(x, definition) {
  if (x > 10) throw new RangeError("x must be at least 10");
  if (!x) { throw new Error(\`x is required\`); }
  if (y) { throw new Error("has an else"); } else { z(); }
  if (w) { log(); throw new Error("not the only statement"); }
  if (definition !== undefined) {
    if (expected === undefined) throw new Error("Expected no definition, but got one");
  } else {
    if (expected !== undefined) throw new Error("Expected a definition");
  }
}`,
  );
  assert.deepEqual(
    doc.guards.map((guard) => [guard.condition, guard.message, guard.reachedWhen]),
    [
      ["x > 10", "x must be at least 10", []],
      // An earlier guard that threw is something this one can rely on: here x is at most 10.
      ["!x", "x is required", ["!(x > 10)"]],
      // Early exits first, then the enclosing `if`. The `if (y) … else …` above does not always leave, so it adds nothing.
      ["expected === undefined", "Expected no definition, but got one", ["!(x > 10)", "!(!x)", "!(w)", "definition !== undefined"]],
      ["expected !== undefined", "Expected a definition", ["!(x > 10)", "!(!x)", "!(w)", "!(definition !== undefined)"]],
    ],
  );
});

test("an ignored error is found in a catch block and in a promise chain, with the comment above and the statements around it", async () => {
  const doc = await parseCode(
    "e.ts",
    `let data = "{}";
// The state file does not exist on first run.
try {
  data = read();
} catch {}
use(data);
player.pause().catch(() => {});
player.stop().catch((error) => { report(error); });
player.play().catch(() => { /* fine */ });`,
  );
  assert.deepEqual(
    doc.emptyCatches.map((handler) => [handler.form, handler.comment, handler.tried.replace(/\s+/g, " "), handler.commentAbove, handler.before, handler.after]),
    [
      ["try", "", "{ data = read(); }", "The state file does not exist on first run.", 'let data = "{}";', "use(data);"],
      ["promise", "", "player.pause()", "", "use(data);", "player.stop().catch((error) => { report(error); });"],
      ["promise", "fine", "player.play()", "", "player.stop().catch((error) => { report(error); });", ""],
    ],
  );
});

test("function-name-matches-body classifies names that promise only an answer, outside test files and object literals", async () => {
  const source = `function getCart() { return load(); }
function isEmpty() { return count() === 0; }
function initStore() { save(); }
function bind() { save(); }
function verifyToken() { report(); }
function getter() { return load(); }
function getOrCreateUser() { return load() ?? create(); }
function getLimit() { return 50; }
const traps = { get() { return load(); }, has() { return load(); } };
class Cart { getTotal() { return sum(this.items); } render() { draw(); } #getSecret() { return read(); } }
exports.findUser = function (id) { return load(id); };`;
  const names = async (file: string) => functionNameMatchesBody.select(await parseCode(file, source)).map((candidate) => candidate.data.name);
  // Not `getOrCreateUser`, whose name announces the write, nor `getLimit`, whose body cannot have an effect.
  assert.deepEqual(await names("src/cart.js"), ["getCart", "isEmpty", "getTotal", "#getSecret", "findUser"]);
  assert.deepEqual(await names("src/cart.test.js"), []);
  assert.deepEqual(await names("test/helpers.js"), []);
});

test("a function named for an answer that returns no value is marked by the parser, and reported at review at least", async () => {
  const doc = await parseCode(
    "src/mix.js",
    `function isMixReady() { if (!loaded) { Mix.load(); } }
function getItems(list) { list.forEach((item) => { return item.id; }); }
function checkInput(value) { if (!value) throw new Error("required"); log(value); }
function hasItems(cart) { return cart.items.length > 0 || refresh(cart); }
function getUser(id, callback) { User.findOne({ id }, callback); }
function getProfile(req, res) { res.json(load(req.params.id)); }
function getUri() { throw new Error("Method not implemented."); }
function* getNodes(schema) { yield* schema.nodes.map(wrap); }
const getModeInfo = async (req, res) => { res.json(load()); };
const getOne = id => { load(id); };`,
  );
  assert.deepEqual(
    functionNameMatchesBody.select(doc).map((candidate) => [candidate.data.name, candidate.meta?.returns]),
    [
      ["isMixReady", "nothing"],
      // The only `return` belongs to the callback, not to getItems.
      ["getItems", "nothing"],
      // `checkInput` is not here: `check…` throws or reports by convention, and one that returns nothing
      // exists for that effect, so there is no promise of only an answer to break.
      ["hasItems", undefined],
      // The answer goes to a callback or into a response; a stub has no answer yet; a generator yields its values.
      ["getUser", undefined],
      ["getProfile", undefined],
      ["getUri", undefined],
      ["getNodes", undefined],
      // An arrow function's parameters are read too, parenthesised or bare.
      ["getModeInfo", undefined],
      ["getOne", "nothing"],
    ],
  );
  // Jev may see no surprise (0.1) or a clear one (0.95): the parser's fact is a floor, not a ceiling.
  const [first] = functionNameMatchesBody.select(doc);
  const assess = (noul: number) => functionNameMatchesBody.assess({ surprising_side_effect: { type: "noul", noul } }, first!);
  assert.equal(assess(0.1).p, 0.7);
  assert.equal(assess(0.95).p, 0.95);
  assert.match(assess(0.1).message, /returns no value on any path/);
});

test("assertions are read from the tree: all constant and all conditional are decided in code", async () => {
  const { default: canFail } = await import("../src/rules/code/test-assertions-can-fail.ts");
  const doc = await parseCode(
    "a.test.js",
    `it("handles comment nodes", () => { sanitize(g); assert.ok(true); });
it("selects option on click", async () => { const o = find(); if (o.exists()) { await o.trigger("click"); expect(emitted()).toBeTruthy(); } });
it("counts its assertions", () => { expect.assertions(1); if (x) { expect(a).toBe(b); } });
it("checks the value", () => { expect(parse("a")).toEqual(["a"]); if (y) expect(z).toBe(1); });
it("chains from another name", () => request.get("/").expect(302));
it("uses a custom matcher", () => { warn("foo"); expect("foo").toHaveBeenWarned(); });
it("keeps the class", () => { cy.get("#img").should("have.class", "left"); });
it("has a property", () => { thing.should.have.property("type", "Feature"); });`,
  );
  assert.deepEqual(doc.tests.map((t) => [t.assertions.length, t.assertionsAllConstant, t.assertionsAllConditional]), [
    [1, true, false],
    [1, false, true],
    // `expect.assertions(1)` counts assertions and is not one. The rule sees it and leaves the test alone.
    [1, false, true],
    [2, false, false],
    [0, false, false],
    // A string names something live (a warning that was logged, an element), so these are not constant.
    [1, false, false],
    [1, false, false],
    // `thing` is not an assertion name, so the tree cannot say what this asserts: unknown, not none.
    [0, false, false],
  ]);
  assert.deepEqual(
    canFail.select(doc).map((candidate) => [candidate.data.title, candidate.decided!.p]),
    [
      ["handles comment nodes", 0.7],
      ["selects option on click", 0.5],
    ],
  );
});

test("a boolean-style name is reported only when its value is plainly not a boolean", async () => {
  const { default: booleanName } = await import("../src/rules/code/boolean-name-holds-boolean.ts");
  const doc = await parseCode(
    "b.js",
    `const isOfficialBot = id === sock ? user.jid + "@host" : "";
const hasItems = cart.items.length > 0;
const isReady = check();
const shouldRetry = { times: 3 };
const isLabel = flag ? true : false;
const island = "not a boolean name";`,
  );
  assert.deepEqual(
    booleanName.select(doc).map((candidate) => [candidate.data.name, candidate.decided!.message]),
    [
      ["isOfficialBot", '"isOfficialBot" is named like a yes/no question and holds a conditional with a branch that is not a boolean.'],
      ["shouldRetry", '"shouldRetry" is named like a yes/no question and holds an object.'],
    ],
  );
});

test("an empty catch whose try assigns an outer variable keeps a fallback, and is not a candidate", async () => {
  const { default: swallowed } = await import("../src/rules/code/swallowed-error-justified.ts");
  const doc = await parseCode("s.js", `let data = "{}";\ntry { data = read(); } catch {}\ntry { const local = read(); use(local); } catch {}\n`);
  assert.deepEqual(doc.emptyCatches.map((handler) => handler.keeps), [["data"], []]);
  assert.equal(swallowed.select(doc).length, 1);
});

test("a comment whose text parses as code is not a candidate", async () => {
  const doc = await parseCode("c.js", `// console.log("next", cursor);\nrun();\n// Actions\nact();\n// Sort newest first, because the feed shows ten.\nposts.sort(byDate);\n`);
  assert.deepEqual(doc.comments.map((comment) => comment.isCode), [true, true, false]);
  assert.deepEqual(commentCandidates(doc).map((candidate) => candidate.data.comment), ["Sort newest first, because the feed shows ten."]);
});

test("isTestFile reads directories and suffixes, not substrings", () => {
  for (const path of ["test/a.ts", "src/__tests__/a.ts", "src/a.spec.tsx", "src/a.test.js", "cypress/e2e/login.js", "src/mocks/server.ts"]) assert.equal(isTestFile(path), true, path);
  for (const path of ["src/latest.ts", "src/contest/entry.ts", "src/inspect.ts", "src/attestation.ts"]) assert.equal(isTestFile(path), false, path);
});

test("Jest's async pattern is not a constant assertion: the count is skipped and the arrow's expression body is read", async () => {
  const doc = await parseCode("a.test.js", `test("rejects with an error", () => { expect.assertions(1); return fetchData().catch((e) => expect(e).toMatch("error")); });`);
  assert.deepEqual(doc.tests.map((t) => [t.assertions, t.assertionsAllConstant]), [[['expect(e).toMatch("error")'], false]]);
});

test("an if/else that asserts in both branches is not conditional", async () => {
  const doc = await parseCode("a.test.js", `test("separator", () => { if (win) expect(sep).toBe("\\\\"); else expect(sep).toBe("/"); });`);
  assert.deepEqual(doc.tests.map((t) => [t.assertions.length, t.assertionsAllConditional]), [[2, false]]);
});

test("a comment above an if or a loop heads statements, and one above a function or class heads a declaration", async () => {
  const doc = await parseCode(
    "c.ts",
    `function f(items) {
  let n = 0;
  // Skip the first item when the list is empty
  if (items.length > 3) { n = items[0]; }
  // Count down from ten
  for (let i = 0; i < 10; i++) { n++; }
  return n;
}
// Formats a price.
export const format = (price) => price.toFixed(2);
// A shopping cart.
class Cart {
  // Adds an item.
  add(item) { this.items.push(item); }
}`,
  );
  assert.deepEqual(
    doc.comments.map((comment) => [comment.text, comment.headsDeclaration]),
    [
      ["Skip the first item when the list is empty", false],
      ["Count down from ten", false],
      ["Formats a price.", true],
      ["A shopping cart.", true],
      ["Adds an item.", true],
    ],
  );
});

test("a trailing comment on a line does not end the paragraph or the section above it", async () => {
  const doc = await parseCode("c.js", `setup();\n// Reset the counters\na = 0; // first\nb = 0;\nc = 0;\n// Next\nrun();\n`);
  const reset = doc.comments.find((comment) => comment.text === "Reset the counters")!;
  assert.equal(reset.code.replace(/\s+/g, " "), "a = 0; // first b = 0; c = 0;");
  assert.deepEqual(reset.loc.lines, { first: 2, last: 5 });
});

test("a setter is not a function named for an answer, and a nested generator's return is not its parent's", async () => {
  const doc = await parseCode(
    "src/dialog.js",
    `class Dialog {
  set isOpen(value) { this._open = value; this.render(); }
  get isOpen() { return this.compute(); }
}
function getIds(list) { const gen = function* () { yield 1; return 2; }; list.push(gen); }`,
  );
  assert.deepEqual(doc.functions.map((fn) => [fn.name, fn.accessor, fn.returnsValue]), [["isOpen", "set", false], ["isOpen", "get", true], ["getIds", undefined, false]]);
  assert.deepEqual(functionNameMatchesBody.select(doc).map((candidate) => [candidate.loc.line, candidate.meta?.returns]), [[3, undefined], [5, "nothing"]]);
});

test("a doc that merely starts like a marker word is still documentation", async () => {
  const { default: docRule } = await import("../src/rules/code/doc-matches-function.ts");
  const doc = await parseCode("src/todos.js", `// Todos are loaded lazily on first access.\nfunction loadTodos() { return fetchAll(); }\n// Licenses the seat to the given user.\nfunction license(user) { return grant(user); }`);
  assert.deepEqual(docRule.select(doc).map((candidate) => candidate.data.name), ["loadTodos", "license"]);
});

test("a note or a directive above a function is not its documentation", async () => {
  const { default: docRule } = await import("../src/rules/code/doc-matches-function.ts");
  const doc = await parseCode(
    "src/user.js",
    `// TODO: cache this once the API supports ETags
function fetchUser(id) { return http.get(id); }
// jev-lint-disable-next-line doc-matches-function -- generated
// Loads the profile for a user id.
function loadProfile(id) { return http.get(id); }`,
  );
  assert.deepEqual(docRule.select(doc).map((candidate) => candidate.data.documentation), ["Loads the profile for a user id."]);
});

test("a documented return value that no path returns is the parser's finding", async () => {
  const { default: docRule } = await import("../src/rules/code/doc-matches-function.ts");
  const doc = await parseCode(
    "src/editor.js",
    `/**
 * Loads the extensions for the editor.
 * @returns {Promise<LangAndData>} Resolves to the loaded language data
 */
async function loadExtensions() { await Promise.all(list.map(load)); }
/**
 * Saves the document to storage.
 * @returns {void}
 */
function saveDocument() { storage.put(doc); }
/**
 * Reads the document from storage.
 * @returns {Document} the stored document
 */
function readDocument() { return storage.get(); }`,
  );
  assert.deepEqual(
    docRule.select(doc).map((candidate) => [candidate.data.name, candidate.decided?.message]),
    [
      ["loadExtensions", 'The documentation of "loadExtensions" says it returns {Promise<LangAndData>}, and no path through it returns a value.'],
      ["saveDocument", undefined],
      ["readDocument", undefined],
    ],
  );
});

test("only a plain assertion with a written-out check is a guard", async () => {
  const doc = await parseCode(
    "src/checks.js",
    `assert(port >= 1024, "port must be at least 1024");
assertFalse(port < 1024, "port must be at least 1024");
assertLessThan(elapsed, timeout * 2, "must finish within twice the timeout");
assertFalsy(closed && busy, "must not be both");
assertEquals(list.indexOf(item), -1, "item should not be in the list");
assertEquals(total, a + b, "totals must match the sum");
invariant(!closed, "The store must be open");
assert(typeof name, "name must be given");`,
  );
  assert.deepEqual(doc.guards.map((guard) => guard.check), ["port >= 1024", "!closed"]);
});

test("guards that share a message are one candidate only within one function, spanning all of them", async () => {
  const { default: guardRule } = await import("../src/rules/code/error-message-matches-guard.ts");
  const doc = await parseCode(
    "src/names.js",
    `function setName(name) {
  if (typeof name !== "string") throw new TypeError("must be a non-empty string");
  if (name.length === 0) throw new TypeError("must be a non-empty string");
}
function setCity(city) {
  if (city.length < 5) throw new Error("must be at least 3 characters");
}
function setTown(town) {
  if (town.length < 3) throw new Error("must be at least 3 characters");
}`,
  );
  assert.deepEqual(
    guardRule.select(doc).map((candidate) => [candidate.meta!.guards, candidate.loc.lines, candidate.meta!.accepts]),
    [
      ["2", { first: 2, last: 3 }, undefined],
      // The same words in two functions are two candidates. 5 against "3" is too far apart to be the same
      // limit in the same unit, so only the second has a bound for Jev's answer to be compared with.
      ["1", { first: 6, last: 6 }, undefined],
      ["1", { first: 9, last: 9 }, "at least 3"],
    ],
  );
});

test("an async function's bare Promise is no promised value, and Closure's marks are read through", async () => {
  const { default: docRule } = await import("../src/rules/code/doc-matches-function.ts");
  const doc = await parseCode(
    "src/store.js",
    `/** Writes the record to disk. @returns {Promise} Resolves once the record is written. */
async function save(record) { await fs.writeFile(path, record); }
/** Flushes pending writes to disk. @returns {!Promise.<void>} */
async function flush() { await drain(); }
/** Loads the settings from disk. @returns {Promise<Settings>} the stored settings */
const load = async () => { await read(); };`,
  );
  assert.deepEqual(doc.functions.map((fn) => [fn.name, fn.async]), [["save", true], ["flush", true], ["load", true]]);
  assert.deepEqual(docRule.select(doc).map((candidate) => [candidate.data.name, candidate.decided !== undefined]), [["save", false], ["flush", false], ["load", true]]);
  // "A promise" in words, with no type naming what it resolves to, is all an async function needs to keep.
  const generic = await parseCode("src/api.js", `/** Lists the items. @returns {Promise<Array<Item>>} the items */\nasync function list() { await load(); }\n/** Clears the whole cache. @returns {Promise<null>} */\nasync function clear() { await wipe(); }`);
  assert.deepEqual(docRule.select(generic).map((candidate) => [candidate.data.name, candidate.decided !== undefined]), [["list", true], ["clear", false]]);
  const worded = await parseCode("src/api.js", `/** Sends the report to the server. @returns A promise that resolves when the upload ends. */\nasync function send(report) { await upload(report); }`);
  assert.deepEqual(docRule.select(worded).map((candidate) => candidate.decided), [undefined]);
});

test("a counted constant assertion can fail, and a conditional assert.fail is the assertion", async () => {
  const { default: canFail } = await import("../src/rules/code/test-assertions-can-fail.ts");
  const doc = await parseCode(
    "a.test.js",
    `it("emits ready", () => { expect.assertions(1); emitter.on("ready", () => { expect(true).toBe(true); }); emitter.start(); });
it("returns 200", async () => { const res = await fetch(url); if (res.status !== 200) assert.fail("expected 200"); });`,
  );
  assert.deepEqual(canFail.select(doc), []);
});

test("a comment above an assigned or default-exported function heads a declaration; a trailing comment above does not swallow a doc", async () => {
  const doc = await parseCode(
    "src/math.js",
    `// Returns the sum of both numbers
exports.add = function (a, b) { return a - b; };
let count = 0; // number of ids handed out
// Returns the previous id and never advances the counter
function nextId() { return ++count; }
// Builds the default client
export default function () { return create(); }`,
  );
  assert.deepEqual(doc.comments.map((comment) => comment.headsDeclaration), [true, true, true]);
  assert.equal(doc.functions.find((fn) => fn.name === "nextId")!.doc, "Returns the previous id and never advances the counter");
});

test("an Angular controller that answers through $scope is not a function that returns nothing", async () => {
  const doc = await parseCode("src/items.js", `function getItems($scope, $http) { $http.get("/items").then((r) => { $scope.items = r.data; }); }`);
  assert.deepEqual(functionNameMatchesBody.select(doc).map((candidate) => candidate.meta?.returns), [undefined]);
});

test("an assertion that is commented out is not an assertion", async () => {
  const doc = await parseCode("t.test.ts", `it("adds", () => {\n  add(1, 2);\n  // expect(add(1, 2)).toBe(3);\n  /* assert.equal(add(1, 2), 3); */\n});\nit("subtracts", () => {\n  // the result is checked\n  expect(sub(2, 1)).toBe(1);\n});\n`);
  assert.deepEqual(doc.tests.map((test) => [test.title, test.hasAssertion]), [["adds", false], ["subtracts", true]]);
});

test("an ignored error in a test file, or around an export that only some environments allow, is not a candidate", async () => {
  const { default: swallowed } = await import("../src/rules/code/swallowed-error-justified.ts");
  const source = `try { module.exports = Player; } catch (e) {}\ntry { exports.Player = Player } catch (e) {}\ntry { save(); } catch (e) {}\n`;
  const tried = async (file: string) => swallowed.select(await parseCode(file, source)).map((candidate) => String(candidate.data.code_that_can_fail));
  assert.equal((await tried("src/player.js")).length, 1);
  assert.match((await tried("src/player.js"))[0]!, /save\(\)/);
  assert.deepEqual(await tried("type-tests/player.js"), []);
});

test("a name announces a write only with a whole verb, and a variadic function's tags are not undeclared parameters", async () => {
  const names = async (source: string) => functionNameMatchesBody.select(await parseCode("src/a.js", source)).map((candidate) => candidate.data.name);
  // "AndSet" inside "AndSettings" is not the verb "set"; `getOrCreateUser` does say it writes.
  assert.deepEqual(await names(`function getUserAndSettings(id) { cache.hits++; return load(id); }\nfunction getOrCreateUser(id) { return users[id] ??= make(id); }`), ["getUserAndSettings"]);

  const { default: docNext } = await import("../src/rules/code/doc-matches-function-next.ts");
  const undeclared = async (source: string) => docNext.select(await parseCode("src/b.js", source)).map((candidate) => candidate.meta!.undeclared);
  assert.deepEqual(await undeclared(`/** Adds numbers.\n * @param {...number} values the numbers */\nfunction sum() { let t = 0; for (const v of arguments) t += v; return t; }`), [""]);
  assert.deepEqual(await undeclared(`/** Adds numbers.\n * @param {number} total the start */\nfunction add(a, b) { return a + b + offset(); }`), ["total"]);
});

test("an export guard is one statement, and a function beside a handler on one line does not enclose it", async () => {
  const { default: swallowed } = await import("../src/rules/code/swallowed-error-justified.ts");
  const data = async (source: string) => swallowed.select(await parseCode("src/c.js", source)).map((candidate) => candidate.data);
  // Without semicolons the second statement is still a second statement.
  assert.equal((await data(`try {\n  module.exports = Player\n  db.commit(tx)\n} catch (e) {}\n`)).length, 1);
  const [beside] = await data(`function noop() {} try { fs.unlinkSync(lockFile) } catch (e) {}\n`);
  assert.equal("enclosing_function" in beside!, false);
});
