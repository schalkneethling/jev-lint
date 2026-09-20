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
  loc: Loc;
}

export interface CodeTest {
  title: string;
  body: string;
  loc: Loc;
}

export interface CodeComment {
  /** Comment text without its delimiters. Consecutive line comments are joined. */
  text: string;
  /** `doc` is a JSDoc-style block, which documents an API rather than explaining a statement. */
  kind: "line" | "block" | "doc";
  /** The statement directly below the comment. */
  code: string;
  loc: Loc;
}

/** A catch block that does nothing. `comment` is what the author wrote inside it, if anything. */
export interface CodeEmptyCatch {
  comment: string;
  tried: string;
  loc: Loc;
}

export interface CodeDoc {
  file: string;
  emptyCatches: CodeEmptyCatch[];
  functions: CodeFunction[];
  tests: CodeTest[];
  comments: CodeComment[];
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

function locOf(node: Node, quoteUntil = node.endIndex): Loc {
  return {
    line: node.startPosition.row + 1,
    col: node.startPosition.column + 1,
    span: { start: node.startIndex, end: quoteUntil },
  };
}

const stripDelimiters = (comment: string) =>
  comment
    .replace(/^\/\*+|\*+\/$/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(\/\/+|\*)\s?/, "").trim())
    .join(" ")
    .trim();

/**
 * In a method chain the node after a comment is only the method's name. The comment is about
 * that whole call, so quote it from the name to the end of its arguments.
 */
function statementBelow(next: Node): string {
  const call = next.parent?.parent;
  if (next.type === "property_identifier" && next.parent?.type === "member_expression" && call?.type === "call_expression") {
    return `.${call.text.slice(next.startIndex - call.startIndex)}`;
  }
  return next.text;
}

/** Joins a run of adjacent line comments and pairs it with the statement that follows. */
function pairComments(comments: Node[]): CodeComment[] {
  const paired: CodeComment[] = [];
  const consumed = new Set<number>();
  for (const first of comments) {
    if (consumed.has(first.id)) continue;
    const run = [first];
    let next = first.nextNamedSibling;
    while (next?.type === "comment" && next.startPosition.row === run.at(-1)!.endPosition.row + 1) {
      run.push(next);
      consumed.add(next.id);
      next = next.nextNamedSibling;
    }
    // A trailing comment on the same line as code, or one with nothing under it, describes no statement.
    const previous = first.previousSibling;
    if (!next || next.type === "comment" || previous?.endPosition.row === first.startPosition.row) continue;
    if (next.startPosition.row > run.at(-1)!.endPosition.row + 1) continue;
    // A comment that opens the file, above the imports, describes the file rather than a statement.
    if (first.parent?.type === "program" && !previous && next.type === "import_statement") continue;
    const kind = first.text.startsWith("/**") ? "doc" : first.text.startsWith("/*") ? "block" : "line";
    paired.push({ text: run.map((c) => stripDelimiters(c.text)).join(" "), kind, code: statementBelow(next), loc: locOf(first, run.at(-1)!.endIndex) });
  }
  return paired;
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

  const doc: CodeDoc = { file, emptyCatches: [], functions: [], tests: [], comments: [] };
  const comments: Node[] = [];
  for (const match of query.matches(root)) {
    const capture = (name: string) => match.captures.find((c) => c.name === name)?.node;
    const fn = capture("function");
    const test = capture("test");
    const handler = capture("catch");
    if (handler) {
      const body = capture("catch.body")!;
      // Only comments inside the block: ESLint's no-empty accepts any comment there, whatever it says.
      if (body.namedChildren.every((child) => child?.type === "comment")) {
        const comment = body.namedChildren.map((child) => stripDelimiters(child!.text)).join(" ");
        doc.emptyCatches.push({ comment, tried: capture("catch.try")!.text, loc: locOf(handler) });
      }
    } else if (fn) {
      const name = capture("function.name")!;
      doc.functions.push({ name: name.text, body: capture("function.body")!.text, loc: locOf(fn, name.endIndex) });
    } else if (test) {
      const title = capture("test.title")!;
      doc.tests.push({ title: title.text.slice(1, -1), body: capture("test.body")!.text, loc: locOf(test, title.endIndex) });
    } else {
      comments.push(capture("comment")!);
    }
  }
  doc.comments = pairComments(comments);
  return doc;
}
