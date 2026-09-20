import type { Node } from "web-tree-sitter";
import type { Element, HtmlDoc } from "../html/parse.ts";
import { parseTree } from "./parse.ts";

/**
 * Stands in for anything JSX computes at run time: `{step.title}`, `aria-label={open ? "Close" : "Open"}`.
 * The engine drops every candidate whose words contain it, because judging half a label is guessing.
 */
export const DYNAMIC = "⟨dynamic⟩";

// React's spellings of HTML attributes. Everything else differs only by case.
const ATTRIBUTE_NAMES: Record<string, string> = { className: "class", htmlFor: "for" };

const JSX_ELEMENTS = ["jsx_element", "jsx_self_closing_element"];

/** A string the source states outright: 'x', "x", or a template with no substitutions. */
function staticString(node: Node | null): string | undefined {
  if (node?.type === "string") return node.text.slice(1, -1);
  if (node?.type === "template_string" && node.namedChildren.every((child) => child?.type !== "template_substitution")) return node.text.slice(1, -1);
  return undefined;
}

/** The outermost JSX elements under `node`, not looking inside the ones it finds. */
function outermostJsx(node: Node): Node[] {
  if (JSX_ELEMENTS.includes(node.type)) return [node];
  return node.namedChildren.flatMap((child) => (child ? outermostJsx(child) : []));
}

function attributes(tag: Node): Element["attrs"] {
  return tag.namedChildren
    .filter((child) => child?.type === "jsx_attribute")
    .map((attribute) => {
      const [name, value] = attribute!.namedChildren;
      const spelled = ATTRIBUTE_NAMES[name!.text] ?? name!.text.toLowerCase();
      if (!value) return { name: spelled, value: "" };
      const stated = value.type === "jsx_expression" ? staticString(value.namedChildren[0] ?? null) : staticString(value);
      return { name: spelled, value: stated ?? DYNAMIC };
    });
}

/**
 * Builds the element shape the HTML rules already read (parse5's), so every one of them runs on JSX
 * source and reports file:line. Components keep their own name as the tag, which no rule matches, so
 * they act as transparent containers for the HTML elements inside them.
 */
function toElement(node: Node, parent: Element | null): Element {
  const tag = node.type === "jsx_element" ? node.childForFieldName("open_tag")! : node;
  const name = tag.childForFieldName("name")?.text ?? "";
  const element = {
    nodeName: name,
    tagName: name,
    attrs: attributes(tag),
    namespaceURI: "http://www.w3.org/1999/xhtml",
    parentNode: parent,
    childNodes: [],
    sourceCodeLocation: {
      startLine: node.startPosition.row + 1,
      startCol: node.startPosition.column + 1,
      startOffset: node.startIndex,
      endLine: node.endPosition.row + 1,
      endCol: node.endPosition.column + 1,
      endOffset: node.endIndex,
      startTag: { startOffset: tag.startIndex, endOffset: tag.endIndex },
    },
  } as unknown as Element;

  const textNode = (value: string) => ({ nodeName: "#text", value, parentNode: element }) as unknown as Element["childNodes"][number];
  for (const child of node.type === "jsx_element" ? node.namedChildren : []) {
    if (!child || child.type === "jsx_opening_element" || child.type === "jsx_closing_element") continue;
    if (JSX_ELEMENTS.includes(child.type)) element.childNodes.push(toElement(child, element));
    else if (child.type === "jsx_text" || child.type === "html_character_reference") element.childNodes.push(textNode(child.text));
    else if (child.type === "jsx_expression") {
      const stated = staticString(child.namedChildren[0] ?? null);
      const nested = outermostJsx(child);
      // `{items.map((item) => <li>…</li>)}` and `{open && <Dialog />}` still contain markup worth reading.
      if (stated !== undefined) element.childNodes.push(textNode(stated));
      else if (nested.length > 0) element.childNodes.push(...nested.map((jsx) => toElement(jsx, element)));
      else if (child.namedChildren[0]?.type !== "comment") element.childNodes.push(textNode(DYNAMIC));
    }
  }
  return element;
}

function flatten(element: Element, out: Element[]): void {
  out.push(element);
  for (const child of element.childNodes) if ("tagName" in child) flatten(child, out);
}

/** Every JSX tree in the file, as one document in source order. Empty when the file has no JSX. */
export async function parseJsx(file: string, source: string): Promise<HtmlDoc> {
  const { root } = await parseTree(file, source);
  const elements: Element[] = [];
  for (const jsx of outermostJsx(root)) flatten(toElement(jsx, null), elements);
  return { file, elements };
}
