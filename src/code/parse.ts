import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { Language, Parser, Query, type Node } from "web-tree-sitter";
import type { Loc } from "../engine/types.ts";

/** A language is a grammar and a query file. Nothing else in jev-lint knows about its syntax. */
const LANGUAGES: Record<string, { wasm: string; query: string }> = {
  javascript: { wasm: "tree-sitter-javascript/tree-sitter-javascript.wasm", query: "javascript.scm" },
  typescript: { wasm: "tree-sitter-typescript/tree-sitter-typescript.wasm", query: "javascript.scm" },
  tsx: { wasm: "tree-sitter-typescript/tree-sitter-tsx.wasm", query: "javascript.scm" },
};

const EXTENSIONS: Record<string, keyof typeof LANGUAGES> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
};

export const isCodeFile = (path: string) => extname(path) in EXTENSIONS;

export interface CodeFunction {
  name: string;
  body: string;
  /** The comment directly above the function (JSDoc, block, or a run of line comments), without its delimiters, or "" when there is none. */
  doc: string;
  /** The parameter list as written, parentheses included. */
  params: string;
  /**
   * Where the function is declared. A method of an object literal is very often a name someone else chose:
   * a Proxy trap, an options callback, a framework hook.
   */
  container: "object" | "class" | "scope";
  /**
   * Whether the body holds anything that could have an effect: a call, `new`, `await`, `yield`, an
   * assignment, an update, or `delete`. A body without one cannot have a side effect, so nothing is asked.
   */
  canAct: boolean;
  /** Whether the function itself, not a function nested in it, returns or yields a value on some path. */
  returnsValue: boolean;
  /** The body is nothing but a `throw`: a stub. */
  stub: boolean;
  /** Declared `async`: it returns a promise whether or not it has a `return`. */
  async: boolean;
  /** `get` or `set` for a property accessor. A setter is named for the property it sets and returns nothing by design. */
  accessor?: "get" | "set";
  loc: Loc;
}

export interface CodeTest {
  title: string;
  body: string;
  /** Titles of the `describe` blocks around the test, outermost first. A title is often only half a sentence without them. */
  suites: string[];
  /** Whether anything in the body looks like an assertion. A parser's call, so that Jev is not asked to find one. */
  hasAssertion: boolean;
  /**
   * Each assertion statement the tree can identify, as written: a statement whose call chain starts at an
   * assertion name. Empty means unknown, not none: `request.get(…).expect(302)` starts at another name.
   */
  assertions: string[];
  /** Every identified assertion sits inside an `if`, so the test passes with none of them run. */
  assertionsAllConditional: boolean;
  /** Every identified assertion compares literals only (`assert.ok(true)`), so the test cannot fail. */
  assertionsAllConstant: boolean;
  loc: Loc;
}

/** A condition whose only consequence is to throw an error with a literal message. */
export interface CodeGuard {
  /** The condition as written, without the surrounding parentheses. */
  condition: string;
  message: string;
  /**
   * Conditions of the `if` statements the guard is nested in, innermost last, each as it must be for the
   * guard to be reached (`!(…)` for an else branch). A message often describes these as much as its own test.
   */
  reachedWhen: string[];
  /**
   * `if` for `if (condition) throw …`. `assert` for `assert(check, "message")` and its kind, where the message
   * is raised when the check fails: `condition` is then the check negated, and `check` is the check as written.
   */
  form: "if" | "assert";
  /** For the `assert` form, the check as written, which must hold for the value to be accepted. */
  check?: string;
  /** Identifies the function the guard is in (or the file's top level), so that only guards of one function are read together. */
  scope: number;
  loc: Loc;
}

export interface CodeComment {
  /** Comment text without its delimiters. Consecutive line comments are joined. */
  text: string;
  /** `doc` is a JSDoc-style block, which documents an API rather than explaining a statement. */
  kind: "line" | "block" | "doc";
  /** The paragraph of code directly below the comment: up to the next blank line or comment. */
  code: string;
  /**
   * The code the comment heads: everything below it up to the next comment at the same level, the end of
   * the block, or `SECTION_LINES` lines. A comment often introduces more than its first paragraph.
   */
  section: string;
  /** The parser could not read the code under the comment: pseudo-code in a cheat sheet, or a syntax it does not know. */
  unparsed: boolean;
  /** The code under the comment opens with a function, method or class: the comment documents a declaration. */
  headsDeclaration: boolean;
  /** The comment's own text parses as code: a commented-out statement, or a bare word used as a label. Neither says anything about the code below. */
  isCode: boolean;
  loc: Loc;
}

/** A catch block that does nothing. `comment` is what the author wrote inside it, if anything. */
export interface CodeEmptyCatch {
  comment: string;
  tried: string;
  /** The comment directly above the statement, where the reason is often written. "" when there is none. */
  commentAbove: string;
  /** The statement before, where a default is often set. Whole statements, not lines: three raw lines of JSX say nothing. */
  before: string;
  /** The statement after, where a fallback often follows. */
  after: string;
  /** `try` for a try/catch statement, `promise` for `.catch(() => {})`. */
  form: "try" | "promise";
  /**
   * Variables the `try` block assigns that are declared outside it. On failure each keeps the value it had,
   * which is the fallback: `let data = "{}"; try { data = read(); } catch {}`.
   */
  keeps: string[];
  loc: Loc;
}

/** A variable whose name reads as a yes/no question (`isReady`, `hasItems`) and whose value is plainly not a boolean. */
export interface CodeBooleanName {
  name: string;
  value: string;
  /** What the value is: `string`, `number`, `object`, `array`, or `ternary` when a branch of a conditional is one of those. */
  holds: string;
  loc: Loc;
}

export interface CodeDoc {
  file: string;
  emptyCatches: CodeEmptyCatch[];
  functions: CodeFunction[];
  tests: CodeTest[];
  comments: CodeComment[];
  /** Every comment in the file, as written, with the line it starts on. Directives to jev-lint are read from these. */
  rawComments: { text: string; line: number; lastLine: number }[];
  guards: CodeGuard[];
  booleanNames: CodeBooleanName[];
}

const require = createRequire(import.meta.url);
const loaded = new Map<string, Promise<{ parser: Parser; query: Query }>>();

async function load(language: string): Promise<{ parser: Parser; query: Query }> {
  await Parser.init();
  const { wasm, query } = LANGUAGES[language]!;
  const grammar = await Language.load(require.resolve(wasm));
  const parser = new Parser().setLanguage(grammar);
  const source = readFileSync(new URL(`./queries/${query}`, import.meta.url), "utf8");
  return { parser, query: new Query(grammar, source) };
}

function locOf(node: Node, quoteUntil = node.endIndex, lastLine = node.endPosition.row + 1): Loc {
  return {
    line: node.startPosition.row + 1,
    col: node.startPosition.column + 1,
    span: { start: node.startIndex, end: quoteUntil },
    lines: { first: node.startPosition.row + 1, last: lastLine },
  };
}

// A comment addressed to jev-lint is an instruction to the tool. It is never classified as a comment, and never
// sent as the comment above a function or a `try`. Inside a function or test body it stays, as part of the code.
// Only a comment that opens with the directive: one that merely mentions it, as documentation does, is prose.
const isOwnDirective = (comment: Node) => /^(?:\/\/+|\/\*+)\s*jev-lint-disable/.test(comment.text);

const stripDelimiters = (comment: string) =>
  comment
    .replace(/^\/\*+|\*+\/$/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(\/\/+|\*)\s?/, "").trim())
    .join(" ")
    .trim();

const SECTION_LINES = 25;

const DECLARATIONS = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_signature",
  "class_declaration",
  "abstract_class_declaration",
  "method_definition",
  "method_signature",
  "abstract_method_signature",
]);
// A class field holding a function: `handle = () => {}`. The node is named differently in the two grammars.
const FIELDS = new Set(["field_definition", "public_field_definition"]);
const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "generator_function", "class"]);

/** Whether a statement declares a function, a method or a class, exported or not, by declaration or by assignment to a name. */
function declares(node: Node): boolean {
  // `export default function () {}` holds the function itself, with no declaration around it.
  if (node.type === "export_statement") return node.namedChildren.some((child) => child !== null && (declares(child) || FUNCTION_VALUES.has(child.type)));
  if (DECLARATIONS.has(node.type)) return true;
  if (FIELDS.has(node.type)) return FUNCTION_VALUES.has(node.childForFieldName("value")?.type ?? "");
  // `exports.add = function () {}`, `Foo.prototype.run = () => {}`
  if (node.type === "expression_statement") {
    const assignment = node.namedChild(0);
    return assignment?.type === "assignment_expression" && FUNCTION_VALUES.has(assignment.childForFieldName("right")?.type ?? "");
  }
  if (node.type !== "lexical_declaration" && node.type !== "variable_declaration") return false;
  return node.namedChildren.some((declarator) => FUNCTION_VALUES.has(declarator?.childForFieldName("value")?.type ?? ""));
}

const FUNCTION_NODES = new Set(["function_declaration", "generator_function_declaration", "function_expression", "generator_function", "arrow_function", "method_definition"]);

function codeBelow(first: Node, next: Node): { paragraph: string; section: string; unparsed: boolean } {
  // In a method chain the node after a comment is only the method's name. The comment is about
  // that whole call, so quote it from the name to the end of its arguments.
  const call = next.parent?.parent;
  if (next.type === "property_identifier" && next.parent?.type === "member_expression" && call?.type === "call_expression") {
    const text = `.${call.text.slice(next.startIndex - call.startIndex)}`;
    return { paragraph: text, section: text, unparsed: call.hasError };
  }
  const parent = next.parent;
  const through = (last: Node) => (last === next || !parent ? next.text : parent.text.slice(next.startIndex - parent.startIndex, last.endIndex - parent.startIndex));
  // A comment heads a paragraph of code, not one statement: everything up to the next blank line or
  // comment. With only the first statement, "Calculate amount from line items" was paired with
  // `let total = 0;` and classified as untrue of it. On the code corpus a lone declaration was 17% of
  // candidates and 38% of reports.
  // A trailing comment (`a = 0; // first`) annotates its own line and ends nothing.
  const trails = (comment: Node) => comment.previousSibling?.endPosition.row === comment.startPosition.row;
  const ends = (sibling: Node) => sibling.type === "comment" && !trails(sibling);
  let paragraphEnd = next;
  for (let sibling = next.nextNamedSibling; sibling && !ends(sibling) && sibling.startPosition.row <= paragraphEnd.endPosition.row + 1; sibling = sibling.nextNamedSibling) {
    if (sibling.type !== "comment") paragraphEnd = sibling;
  }
  // And often more than one paragraph: "Check if MongoDB is running" sat above a log line, a blank line,
  // and then the try block that does the checking. The first panel of labellers called 10 of 11 reports
  // wrong for this reason. The section runs to the next comment at this level, capped so that a comment
  // at the top of a long block is not classified against all of it.
  let sectionEnd = next;
  for (let sibling = next.nextNamedSibling; sibling && !ends(sibling) && sibling.endPosition.row - next.startPosition.row < SECTION_LINES; sibling = sibling.nextNamedSibling) {
    if (sibling.type !== "comment") sectionEnd = sibling;
  }
  // A comment that opens a function body says what the function does, and often what it returns, so the
  // section is the body. In one corpus file such a comment was followed by a declaration and then another
  // comment, and was classified against `let notInFocus = true` alone.
  const opensBody = parent?.type === "statement_block" && FUNCTION_NODES.has(parent.parent?.type ?? "") && first.previousNamedSibling === null;
  const section = opensBody ? parent.text.slice(next.startIndex - parent.startIndex, parent.lastNamedChild!.endIndex - parent.startIndex) : through(sectionEnd);
  let unparsed = false;
  for (let node: Node | null = next; node && node.startIndex <= sectionEnd.startIndex; node = node.nextNamedSibling) unparsed ||= node.hasError;
  return { paragraph: through(paragraphEnd), section, unparsed };
}

/** Joins a run of adjacent line comments and pairs it with the paragraph of code that follows. */
function pairComments(comments: Node[]): CodeComment[] {
  const paired: CodeComment[] = [];
  const consumed = new Set<number>();
  for (const first of comments) {
    if (consumed.has(first.id)) continue;
    // A trailing comment on the same line as code describes that line. It neither heads a statement nor
    // starts a run: the comment on the next line is a comment of its own.
    if (first.previousSibling?.endPosition.row === first.startPosition.row) continue;
    const run = [first];
    let next = first.nextNamedSibling;
    while (next?.type === "comment" && next.startPosition.row === run.at(-1)!.endPosition.row + 1) {
      run.push(next);
      consumed.add(next.id);
      next = next.nextNamedSibling;
    }
    // A comment with nothing under it describes no statement.
    const previous = first.previousSibling;
    if (!next || next.type === "comment") continue;
    if (next.startPosition.row > run.at(-1)!.endPosition.row + 1) continue;
    // A comment that opens the file, above the imports, describes the file rather than a statement.
    if (first.parent?.type === "program" && !previous && next.type === "import_statement") continue;
    const kind = first.text.startsWith("/**") ? "doc" : first.text.startsWith("/*") ? "block" : "line";
    const { paragraph, section, unparsed } = codeBelow(first, next);
    // The code under the comment belongs to the candidate: a comment goes stale when that code changes.
    const lastLine = next.startPosition.row + section.split("\n").length;
    paired.push({ text: run.map((c) => stripDelimiters(c.text)).join(" "), kind, code: paragraph, section, unparsed, headsDeclaration: declares(next), isCode: false, loc: locOf(first, run.at(-1)!.endIndex, lastLine) });
  }
  return paired;
}

const SUITE_RUNNERS = new Set(["describe", "context", "suite"]);

/** Titles of the `describe` calls a node sits inside, outermost first. */
function suitesAround(node: Node): string[] {
  const titles: string[] = [];
  for (let up = node.parent; up; up = up.parent) {
    if (up.type !== "call_expression") continue;
    const callee = up.childForFieldName("function");
    const runner = callee?.type === "member_expression" ? callee.childForFieldName("object") : callee;
    const title = up.childForFieldName("arguments")?.namedChild(0);
    if (runner && SUITE_RUNNERS.has(runner.text) && (title?.type === "string" || title?.type === "template_string")) titles.unshift(title.text.slice(1, -1));
  }
  return titles;
}

// `test.before("setup", …)` and `it.each(table)("…", …)` look like tests to a query and are not ones with a title to check.
const NOT_A_TEST = new Set(["before", "after", "beforeEach", "afterEach", "beforeAll", "afterAll", "each", "describe", "todo"]);

// Names assertions go by across the common runners and assertion libraries. Wide on purpose: a test that
// matches is classified against its title, and one that does not is left alone as a smoke test. A false
// match therefore admits a smoke test to the title rule, which is why the pattern is not wider still.
const ASSERTION = /\b(expect\w*|assert\w*|should|must|verify\w*|check\w*|ensure\w*|t\.\w+|sinon\.assert|cy\.\w+|toMatch\w*|strictEqual|deepEqual|snapshot|done|plan|rejects|throws)\b/i;

/** A node's source with its comments blanked out, so that an assertion that is commented out does not count as one. */
function textWithoutComments(node: Node): string {
  let text = node.text;
  for (const comment of node.descendantsOfType("comment")) {
    const start = comment.startIndex - node.startIndex;
    text = text.slice(0, start) + " ".repeat(comment.endIndex - comment.startIndex) + text.slice(start + comment.endIndex - comment.startIndex);
  }
  return text;
}

function containerOf(fn: Node): CodeFunction["container"] {
  const holder = fn.type === "variable_declarator" ? undefined : fn.parent;
  if (holder?.type === "object") return "object";
  if (holder?.type === "class_body") return "class";
  return "scope";
}

const unwrapped = (condition: string) => condition.replace(/^\(|\)$/g, "");

// What an assertion's check looks like when it is written out: a comparison, a negation, or a call. A bare
// name (`assert(ok, "…")`) shows nothing a message could be compared with.
const CHECKS = new Set(["binary_expression", "unary_expression", "call_expression", "parenthesized_expression"]);

// Assertion names whose argument before the message is not a check that must hold: `assertFalse(check, …)`
// must fail, and in `assertEquals(actual, expected, …)` it is the expected value.
const NOT_A_PLAIN_CHECK = /(Equals?|Strict\w*|Deep\w*|Not\w*|False|Falsy|Null|Undefined|Empty|Throws?|Rejects?|Match\w*|Same|Type\w*|Instance\w*|Less\w*|Greater\w*|Above|Below|Contains?|Includes?)$/;

const TRUTH_OPERATORS = new Set(["==", "===", "!=", "!==", "<", "<=", ">", ">=", "&&", "||", "??", "instanceof", "in"]);

/**
 * A check written out as a comparison, a call, or a negation. `-1` and `typeof x` are unary and are not
 * checks, and `timeout * 2` is binary and is arithmetic.
 */
function isCheck(node: Node): boolean {
  if (!CHECKS.has(node.type)) return false;
  if (node.type === "unary_expression") return node.child(0)?.type === "!";
  if (node.type === "binary_expression") return TRUTH_OPERATORS.has(node.childForFieldName("operator")?.type ?? "");
  if (node.type === "parenthesized_expression") return node.namedChild(0) ? isCheck(node.namedChild(0)!) : false;
  return true;
}

/** The start of the nearest enclosing function, or -1 at the top level. */
function scopeOf(node: Node): number {
  for (let up = node.parent; up; up = up.parent) if (FUNCTION_NODES.has(up.type)) return up.startIndex;
  return -1;
}

const LEAVES = new Set(["return_statement", "throw_statement", "continue_statement", "break_statement"]);

/** A branch that always leaves: `return`, `throw`, `continue` or `break`, alone or as the last statement of a block. */
const leaves = (node: Node | null): boolean => !!node && (LEAVES.has(node.type) || (node.type === "statement_block" && leaves(node.lastNamedChild)));

// How many earlier early exits to carry. Each is one more clause for Jev to hold; the nearest matter most.
const EARLIER_EXITS = 3;

/**
 * What must hold for control to reach `node`, within the same function. Two sources: the `if` statements
 * around it, and the early exits before it. `if (list === undefined) return;` above a guard means the guard
 * runs only when the list is defined, and a message that says "but got a list" is describing exactly that.
 */
function conditionsAround(node: Node): string[] {
  const conditions: string[] = [];
  for (let child = node, up = node.parent; up && !/function|method|arrow/.test(up.type); child = up, up = up.parent) {
    if (up.type === "statement_block" || up.type === "program") {
      const exits: string[] = [];
      for (let earlier = child.previousNamedSibling; earlier && exits.length < EARLIER_EXITS; earlier = earlier.previousNamedSibling) {
        if (earlier.type === "if_statement" && !earlier.childForFieldName("alternative") && leaves(earlier.childForFieldName("consequence"))) {
          exits.unshift(`!(${unwrapped(earlier.childForFieldName("condition")!.text)})`);
        }
      }
      conditions.unshift(...exits);
    }
    if (up.type !== "if_statement") continue;
    const condition = unwrapped(up.childForFieldName("condition")!.text);
    if (up.childForFieldName("consequence")?.id === child.id) conditions.unshift(condition);
    else if (up.childForFieldName("alternative")?.id === child.id) conditions.unshift(`!(${condition})`);
  }
  return conditions;
}

// `t` alone is AVA's and tape's test object; as a prefix it would match any variable that starts with a t.
const ASSERTION_ROOT = /^(expect\w*|assert\w*|should|must|verify\w*|check\w*|ensure\w*|t|sinon|cy)$/i;
// Not strings: `expect("some warning").toHaveBeenWarned()` and `cy.get("#id").should("exist")` pass a string
// that names something live. A boolean, a number, or nothing at all names nothing.
const CONSTANTS = new Set(["true", "false", "number", "null", "undefined"]);
const PLAIN_ASSERTION = /^(expect|assert)$/;

// `expect.assertions(2)` and `t.plan(2)` say how many assertions must run. They assert nothing themselves.
const COUNTS_ASSERTIONS = /^(expect\.(assertions|hasAssertions)|assert\.plan|t\.plan)\(/;

/** The assertion statements in a test body: statements whose call chain starts at an assertion name. */
function assertionsIn(body: Node): Node[] {
  const found: Node[] = [];
  /** Records `chain` when it is a call that starts at an assertion name; says whether it did. */
  const record = (chain: Node | null): boolean => {
    if (chain?.type === "await_expression") chain = chain.namedChild(0);
    let root = chain;
    while (root?.type === "call_expression" || root?.type === "member_expression") root = root.childForFieldName(root.type === "call_expression" ? "function" : "object");
    if (!chain || chain.type !== "call_expression" || root?.type !== "identifier" || !ASSERTION_ROOT.test(root.text) || COUNTS_ASSERTIONS.test(chain.text)) return false;
    found.push(chain);
    return true;
  };
  const visit = (node: Node) => {
    if ((node.type === "expression_statement" || node.type === "return_statement") && record(node.namedChild(0))) return;
    // `.catch((e) => expect(e).toMatch("x"))`: an arrow function's expression body is its one statement.
    if (node.type === "arrow_function" && node.childForFieldName("body")?.type !== "statement_block" && record(node.childForFieldName("body"))) return;
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(body);
  return found;
}

// Only an `if` with no `else`: when both branches assert, one assertion runs whatever the condition is.
const insideIf = (node: Node, body: Node) => {
  for (let up = node.parent; up && up.id !== body.id; up = up.parent) if (up.type === "if_statement" && !up.childForFieldName("alternative")) return true;
  return false;
};

/** `assert.ok(true)`, `expect(true).toBe(true)`, `assert.equal(1, 1)`: an `expect` or `assert` chain given constants only, and at least one. */
function onlyConstants(assertion: Node): boolean {
  let root: Node | null = assertion;
  while (root?.type === "call_expression" || root?.type === "member_expression") root = root.childForFieldName(root.type === "call_expression" ? "function" : "object");
  if (!root || !PLAIN_ASSERTION.test(root.text)) return false;
  const given = assertion.descendantsOfType("arguments").flatMap((args) => (args ? args.namedChildren : []));
  return given.length > 0 && given.every((arg) => arg !== null && CONSTANTS.has(arg.type));
}

const NESTED_FUNCTION = FUNCTION_NODES;
const CAN_ACT = new Set(["call_expression", "new_expression", "await_expression", "yield_expression", "update_expression", "assignment_expression", "augmented_assignment_expression"]);

const canAct = (node: Node): boolean =>
  CAN_ACT.has(node.type) || (node.type === "unary_expression" && node.child(0)?.type === "delete") || node.namedChildren.some((child) => child !== null && canAct(child));

/** A `return` with a value, or a `yield`, that belongs to this body and not to a function declared inside it. */
const returnsValue = (node: Node): boolean =>
  node.namedChildren.some(
    (child) => child !== null && !NESTED_FUNCTION.has(child.type) && ((child.type === "return_statement" && child.namedChildCount > 0) || child.type === "yield_expression" || returnsValue(child)),
  );

/** Whether a function is declared `async`, however it is declared: as a function, a method, or a value assigned to a name. */
function isAsync(fn: Node): boolean {
  const holder = fn.type === "variable_declarator" ? fn.childForFieldName("value") : fn.type === "assignment_expression" ? fn.childForFieldName("right") : fn;
  return holder?.children.some((child) => child !== null && !child.isNamed && child.type === "async") ?? false;
}

/** Whether a method is a property accessor: `get name() {}` or `set name(value) {}`. */
function accessorOf(fn: Node): "get" | "set" | undefined {
  if (fn.type !== "method_definition") return undefined;
  const keyword = fn.children.find((child) => child !== null && !child.isNamed && (child.type === "get" || child.type === "set"));
  return keyword?.type as "get" | "set" | undefined;
}

/** The body is nothing but a `throw`: a stub for a method not implemented yet, or one a subclass must override. */
const onlyThrows = (body: Node) => body.type === "statement_block" && body.namedChildren.filter((child) => child?.type !== "comment").every((child) => child?.type === "throw_statement");

/** Variables a `try` block assigns that are declared outside it. */
function keptOnFailure(tried: Node): string[] {
  const assigned = new Set<string>();
  const declared = new Set<string>();
  const visit = (node: Node) => {
    const target = node.type === "assignment_expression" ? node.childForFieldName("left") : node.type === "variable_declarator" ? node.childForFieldName("name") : null;
    if (target?.type === "identifier") (node.type === "assignment_expression" ? assigned : declared).add(target.text);
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(tried);
  return [...assigned].filter((name) => !declared.has(name));
}

const NOT_BOOLEAN: Record<string, string> = { string: "string", template_string: "string", number: "number", object: "object", array: "array" };

/** What a value plainly is when it is plainly not a boolean, looking through parentheses and into a conditional's branches. */
function nonBooleanKind(value: Node): string | undefined {
  if (value.type === "parenthesized_expression") return value.namedChild(0) ? nonBooleanKind(value.namedChild(0)!) : undefined;
  if (value.type in NOT_BOOLEAN) return NOT_BOOLEAN[value.type];
  if (value.type !== "ternary_expression") return undefined;
  const branches = [value.childForFieldName("consequence"), value.childForFieldName("alternative")];
  return branches.some((branch) => branch && nonBooleanKind(branch)) ? "ternary" : undefined;
}

// A neighbouring statement is context, not the candidate: enough of it to show a default or a fallback.
const NEIGHBOUR_CHARS = 300;
const shortened = (text: string) => (text.length > NEIGHBOUR_CHARS ? `${text.slice(0, NEIGHBOUR_CHARS)} …` : text);

const WRAPPERS = new Set(["export_statement", "lexical_declaration", "variable_declaration", "expression_statement"]);

/**
 * The comment that ends directly above a function: a JSDoc block, a plain block comment, or a run of line
 * comments. Whatever its delimiters, a comment in that place documents the function. Returned as the
 * comment nodes, first to last; empty when there is none.
 */
function docAbove(fn: Node): Node[] {
  let top = fn;
  while (top.parent && WRAPPERS.has(top.parent.type)) top = top.parent;
  const run: Node[] = [];
  for (let above = top.previousNamedSibling, below = top; above?.type === "comment" && above.endPosition.row >= below.startPosition.row - 1; below = above, above = above.previousNamedSibling) {
    // A trailing comment on the line of the statement before is about that statement, and ends the run.
    if (above.previousSibling?.endPosition.row === above.startPosition.row) break;
    if (!isOwnDirective(above)) run.unshift(above);
    // Only line comments continue upwards: two block comments in a row are two comments.
    if (!above.text.startsWith("//")) break;
  }
  return run;
}

/** The syntax tree of a JS or TS file, for extractors that walk it themselves, such as the JSX reader. */
export async function parseTree(file: string, source: string): Promise<{ root: Node; query: Query }> {
  const language = EXTENSIONS[extname(file)]!;
  if (!loaded.has(language)) loaded.set(language, load(language));
  const { parser, query } = await loaded.get(language)!;
  return { root: parser.parse(source)!.rootNode, query };
}

export async function parseCode(file: string, source: string): Promise<CodeDoc> {
  const { root, query } = await parseTree(file, source);

  const doc: CodeDoc = { file, emptyCatches: [], functions: [], tests: [], comments: [], rawComments: [], guards: [], booleanNames: [] };
  const isEmpty = (body: Node) => body.namedChildren.every((child) => child?.type === "comment");
  const commentIn = (body: Node) => body.namedChildren.map((child) => stripDelimiters(child!.text)).join(" ");
  // What a labeller needed to call an empty catch safe was nearly always just outside it: a comment above the
  // `try`, a default assigned before it, a fallback returned after it.
  const around = (statement: Node) => {
    let above = statement.previousNamedSibling;
    const commentLines: string[] = [];
    for (; above?.type === "comment"; above = above.previousNamedSibling) if (!isOwnDirective(above)) commentLines.unshift(stripDelimiters(above.text));
    const below = statement.nextNamedSibling;
    return { commentAbove: commentLines.join(" "), before: shortened(above?.text ?? ""), after: shortened(below?.type === "comment" ? "" : (below?.text ?? "")) };
  };
  const comments: Node[] = [];
  for (const match of query.matches(root)) {
    const capture = (name: string) => match.captures.find((c) => c.name === name)?.node;
    const fn = capture("function");
    const test = capture("test");
    const handler = capture("catch");
    const guard = capture("guard");
    const promiseCatch = capture("pcatch");
    const named = capture("named");
    const asserted = capture("asserted");
    if (asserted) {
      // The check is the argument just before the message: `assert(x > 0, "…")`, `parseAssert("name", x >= 20, "…")`.
      const message = capture("asserted.message")!;
      const check = message.previousNamedSibling;
      const callee = asserted.childForFieldName("function");
      const name = (callee?.type === "member_expression" ? callee.childForFieldName("property") : callee)?.text ?? "";
      if (check && isCheck(check) && !NOT_A_PLAIN_CHECK.test(name)) {
        doc.guards.push({ condition: `!(${check.text})`, check: check.text, message: message.text.slice(1, -1), reachedWhen: conditionsAround(asserted), form: "assert", scope: scopeOf(asserted), loc: locOf(asserted, message.endIndex) });
      }
    } else if (named) {
      const value = capture("named.value")!;
      const holds = nonBooleanKind(value);
      if (holds) doc.booleanNames.push({ name: capture("named.name")!.text, value: value.text, holds, loc: locOf(named) });
    } else if (guard) {
      const message = capture("guard.message")!;
      doc.guards.push({ condition: unwrapped(capture("guard.condition")!.text), message: message.text.slice(1, -1), reachedWhen: conditionsAround(guard), form: "if", scope: scopeOf(guard), loc: locOf(guard, message.endIndex) });
    } else if (promiseCatch) {
      const body = capture("pcatch.body")!;
      // The statement the chain belongs to, so that "before" and "after" are whole lines around it.
      let statement = promiseCatch;
      while (statement.parent && statement.parent.type !== "statement_block" && statement.parent.type !== "program") statement = statement.parent;
      if (isEmpty(body)) doc.emptyCatches.push({ comment: commentIn(body), tried: capture("pcatch.try")!.text, ...around(statement), form: "promise", keeps: [], loc: locOf(promiseCatch) });
    } else if (handler) {
      const body = capture("catch.body")!;
      const tried = capture("catch.try")!;
      // Only comments inside the block: ESLint's no-empty accepts any comment there, whatever it says.
      if (isEmpty(body)) {
        const loc = locOf(handler);
        doc.emptyCatches.push({ comment: commentIn(body), tried: tried.text, ...around(handler.parent!), form: "try", keeps: keptOnFailure(tried), loc: { ...loc, lines: { first: tried.startPosition.row + 1, last: loc.lines!.last } } });
      }
    } else if (fn) {
      const name = capture("function.name")!;
      const body = capture("function.body")!;
      const documentation = docAbove(fn);
      const loc = locOf(fn, name.endIndex);
      doc.functions.push({
        name: name.text,
        body: body.text,
        doc: documentation.map((comment) => stripDelimiters(comment.text)).join(" "),
        params: capture("function.params")?.text ?? "",
        container: containerOf(fn),
        canAct: canAct(body),
        // An arrow function with an expression body returns that expression.
        returnsValue: body.type !== "statement_block" || returnsValue(body),
        stub: onlyThrows(body),
        async: isAsync(fn),
        ...(accessorOf(fn) && { accessor: accessorOf(fn)! }),
        // The documentation is part of the candidate: an edit to it can make it wrong as surely as an edit to the body.
        loc: documentation.length > 0 ? { ...loc, lines: { first: documentation[0]!.startPosition.row + 1, last: loc.lines!.last } } : loc,
      });
    } else if (test) {
      const title = capture("test.title")!;
      const callee = test.childForFieldName("function");
      const modifier = callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : undefined;
      if (modifier && NOT_A_TEST.has(modifier)) continue;
      const bodyNode = capture("test.body")!;
      const body = bodyNode.text;
      const assertions = assertionsIn(bodyNode);
      const checks = assertions.filter((assertion) => !/\.fail\(/.test(assertion.text));
      doc.tests.push({
        title: title.text.slice(1, -1),
        body,
        suites: suitesAround(test),
        hasAssertion: ASSERTION.test(textWithoutComments(bodyNode)),
        assertions: assertions.map((assertion) => assertion.text),
        // `if (status !== 200) assert.fail(…)` is how such a test fails: the `if` is the assertion.
        assertionsAllConditional: checks.length > 0 && checks.every((assertion) => insideIf(assertion, bodyNode)),
        assertionsAllConstant: assertions.length > 0 && assertions.every(onlyConstants),
        loc: locOf(test, title.endIndex),
      });
    } else {
      comments.push(capture("comment")!);
    }
  }
  const { parser } = await loaded.get(EXTENSIONS[extname(file)]!)!;
  // Printable ASCII only: a sentence in a script without spaces would parse as one long identifier.
  const parsesAsCode = (text: string) => /^[\x20-\x7E]+$/.test(text) && !parser.parse(text)!.rootNode.hasError;
  doc.rawComments = comments.map((comment) => ({ text: comment.text, line: comment.startPosition.row + 1, lastLine: comment.endPosition.row + 1 }));
  // A directive to jev-lint is not part of the comment under it: joined into one run, it would hide that
  // comment from every comment rule, whichever rule the directive named.
  doc.comments = pairComments(comments.filter((comment) => !isOwnDirective(comment))).map((comment) => ({ ...comment, isCode: parsesAsCode(comment.text) }));
  return doc;
}
