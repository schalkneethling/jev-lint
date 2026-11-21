// What `draw.ts` and `score.ts` both need to know about a saved classification.
export interface Saved {
  id: number;
  rule: string;
  page: string;
  kind: string;
  band: string;
  p: number;
  severity: string | null;
  message: string;
  hint?: string;
  snippet: string;
  checked: Record<string, unknown>;
  facts: Record<string, string>;
}


// The words identify an item across runs: ids are positions in one run's output and move when a rule changes.
export const wordsOf = (j: Pick<Saved, "rule" | "page" | "checked">) =>
  `${j.rule}|${j.page.split(": ")[0]}|${Object.values(j.checked).filter((value) => typeof value === "string").sort().join("|")}`;
