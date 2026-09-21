import { readFileSync } from "node:fs";

/** One axe check result on one element, as recorded by @schalkneethling/axe-aggregate-reporter. */
export interface AxeResult {
  rule: string;
  outcome: "passed" | "failed";
  help: string;
  /** A selector axe generated for the element. Frames and shadow roots, which need several, are skipped. */
  target: string;
}

interface RuleResult {
  id: string;
  help: string;
  nodes: { target: (string | string[])[] }[];
}

export interface AggregateEntry {
  axe: { url: string; failed: RuleResult[]; passed: RuleResult[] };
}

/** Element-level results in a fixed order (failed, then passed), which is the order elements are stamped in. */
export function toAxeResults(axe: AggregateEntry["axe"]): AxeResult[] {
  const results: AxeResult[] = [];
  for (const outcome of ["failed", "passed"] as const) {
    for (const rule of axe[outcome]) {
      for (const node of rule.nodes) {
        const [target] = node.target;
        if (node.target.length === 1 && typeof target === "string") results.push({ rule: rule.id, outcome, help: rule.help, target });
      }
    }
  }
  return results;
}

/** Reads an aggregate report into per-URL lists of element-level results. */
export function readAxeReport(path: string): Map<string, AxeResult[]> {
  const entries: AggregateEntry[] = JSON.parse(readFileSync(path, "utf8"));
  const byUrl = new Map<string, AxeResult[]>();
  for (const { axe } of entries) byUrl.set(axe.url, [...(byUrl.get(axe.url) ?? []), ...toAxeResults(axe)]);
  return byUrl;
}

/**
 * The axe rules that check the *form* of what each jev-lint rule checks the *meaning* of. When one of
 * these passed on an element that jev-lint reports, the element is valid and false: automation
 * approved it and it still fails the user.
 */
export const FORM_CHECKS: Record<string, string[]> = {
  "alt-text-quality": ["image-alt", "role-img-alt", "image-redundant-alt"],
  "link-text-purpose": ["link-name"],
  "control-type-intent": ["link-name"],
  "aria-label-justified": ["link-name", "button-name", "aria-valid-attr", "aria-allowed-attr", "label-content-name-mismatch"],
  "label-input-type": ["label", "autocomplete-valid"],
};
