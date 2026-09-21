import { parse, type DefaultTreeAdapterTypes as T } from "parse5";
import type { Loc } from "../engine/types.ts";

// Kept in step with render.ts, which sets it. Importing render.ts here would load Playwright for every lint run.
const AXE_ATTRIBUTE = "data-jev-axe";

export type Element = T.Element;
type Node = T.Node;

export interface HtmlDoc {
  file: string;
  elements: Element[];
}

const isElement = (node: Node): node is Element => "tagName" in node;

function collect(node: Node, out: Element[]): void {
  if (isElement(node)) out.push(node);
  // <template> keeps its children in `content`, not `childNodes`.
  const children = "content" in node ? node.content.childNodes : "childNodes" in node ? node.childNodes : [];
  for (const child of children) collect(child, out);
}

export function parseHtml(file: string, source: string): HtmlDoc {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const elements: Element[] = [];
  collect(document, elements);
  return { file, elements };
}

export function attr(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

export function locOf(el: Element): Loc {
  const loc = el.sourceCodeLocation;
  // Short elements are quoted whole; long ones by their start tag.
  const quote = loc && loc.endOffset - loc.startOffset <= 200 ? loc : (loc?.startTag ?? loc);
  const axe = attr(el, AXE_ATTRIBUTE);
  return {
    line: loc?.startLine ?? 1,
    col: loc?.startCol ?? 1,
    ...(quote && { span: { start: quote.startOffset, end: quote.endOffset } }),
    ...(axe && { axe: axe.split(" ").map(Number) }),
    ...(isAccessibilityOverlay(el) && { widget: "accessibility overlay" as const }),
  };
}

const HEADING = /^h[1-6]$/;

/** The last heading before `el` in document order: usually the subject a control applies to. */
export function nearestHeading(doc: HtmlDoc, el: Element): string | undefined {
  let heading: string | undefined;
  for (const candidate of doc.elements) {
    if (candidate === el) break;
    if (HEADING.test(candidate.tagName)) heading = text(candidate);
  }
  return heading || undefined;
}

// <noscript> is parsed as raw text, so its markup would be quoted as if it were content.
const SKIP_TEXT = new Set(["script", "style", "template", "noscript"]);

function rawText(node: Node): string {
  if (node.nodeName === "#text") return (node as T.TextNode).value;
  if (!isElement(node) || SKIP_TEXT.has(node.tagName)) return "";
  // An image's alt text is what it contributes to its parent's accessible name.
  if (node.tagName === "img") return ` ${attr(node, "alt") ?? ""} `;
  return node.childNodes.map(rawText).join(" ");
}

export function text(node: Node): string {
  return rawText(node).replace(/\s+/g, " ").trim();
}

export function closest(el: Element, tagNames: string[]): Element | undefined {
  for (let node = el.parentNode; node && isElement(node); node = node.parentNode) {
    if (tagNames.includes(node.tagName)) return node;
  }
  return undefined;
}

export function descendants(el: Element, tagNames: string[]): Element[] {
  const all: Element[] = [];
  collect(el, all);
  return all.filter((d) => d !== el && tagNames.includes(d.tagName));
}

export function truncateWords(value: string, maxWords: number): string {
  const words = value.split(" ");
  return words.length <= maxWords ? value : `${words.slice(0, maxWords).join(" ")} …`;
}

export function byId(doc: HtmlDoc, id: string): Element | undefined {
  return doc.elements.find((el) => attr(el, "id") === id);
}

/** The label a user perceives for a form field: `aria-label`, then `<label for>`, then a wrapping `<label>`. */
export function fieldLabel(doc: HtmlDoc, field: Element): string | undefined {
  const explicit = attr(field, "aria-label");
  if (explicit) return explicit.trim();
  const id = attr(field, "id");
  const label = (id && doc.elements.find((el) => el.tagName === "label" && attr(el, "for") === id)) || closest(field, ["label"]);
  return label ? text(label) || undefined : undefined;
}

// Consent managers are third-party widgets injected into the page. Their text is not the page's
// content and not the author's to fix, yet on the corpus it was paired with headings and descriptions.
const CONSENT_UI = /onetrust|cookie|consent|gdpr|usercentrics|truste|cookiebot|didomi|osano|termly/i;

// Accessibility overlays are injected too, but unlike consent text their controls are part of what a
// user meets, so their findings are kept and marked: the fix is the vendor's, or removing the overlay.
// Each prefix here was seen on corpus pages.
const ACCESSIBILITY_OVERLAY = /\b(uwaw-|userway|accessibly-app|acsb-)/i;

function isAccessibilityOverlay(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentNode && "tagName" in node.parentNode ? node.parentNode : null) {
    if (ACCESSIBILITY_OVERLAY.test(`${attr(node, "id") ?? ""} ${attr(node, "class") ?? ""}`)) return true;
  }
  return false;
}

export function isConsentUi(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentNode && "tagName" in node.parentNode ? node.parentNode : null) {
    if (CONSENT_UI.test(`${attr(node, "id") ?? ""} ${attr(node, "class") ?? ""}`)) return true;
  }
  return false;
}
