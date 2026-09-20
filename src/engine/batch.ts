import type { EntryType } from "@typesafe-ai/sdk";
import type { AnyRule, Candidate, Isolation, Ref, StateShape } from "./types.ts";

export interface Item {
  rule: AnyRule;
  candidate: Candidate;
}

/** One request: a state plus the items judged against it, each able to name its fields in that state. */
export interface Batch {
  state: EntryType;
  entries: { item: Item; ref: Ref }[];
}

/** Quotes a field of one candidate under the prefix that reaches it: none, `candidate.`, or `candidates[3].`. */
export const refIn =
  (prefix: string): Ref =>
  (field) =>
    `\`${prefix}${field}\``;

// Jev loses accuracy as state grows with material unrelated to the question, so chunks stay
// far below the 32k-token limit. Characters / 4 is a rough token estimate; it only sizes chunks.
const CHUNK_TOKEN_BUDGET = 6000;
const estimateTokens = (value: EntryType): number => Math.ceil(JSON.stringify(value).length / 4);

function chunk(items: Item[], maxCandidates: number): Batch[] {
  const batches: Batch[] = [];
  let current: Item[] = [];
  let tokens = 0;
  const flush = () => {
    if (current.length === 0) return;
    batches.push({
      state: { candidates: current.map((item) => item.candidate.data) },
      entries: current.map((item, i) => ({ item, ref: refIn(`candidates[${i}].`) })),
    });
    current = [];
    tokens = 0;
  };
  for (const item of items) {
    const size = estimateTokens(item.candidate.data);
    if (tokens + size > CHUNK_TOKEN_BUDGET || current.length >= maxCandidates) flush();
    current.push(item);
    tokens += size;
  }
  flush();
  return batches;
}

/** Splits one file's items into requests. Less isolation means fewer requests but noisier state. */
export function toBatches(items: Item[], isolation: Isolation, maxCandidates = Infinity, stateShape: StateShape = "wrapped"): Batch[] {
  if (isolation === "candidate") {
    // Rules that judge the same words share one request: the state is sent once and their
    // questions are answered side by side, which is how Jev is meant to be used.
    const sameWords = Map.groupBy(items, (item) => JSON.stringify(item.candidate.data));
    const ref = refIn(stateShape === "flat" ? "" : "candidate.");
    return [...sameWords.values()].map((group) => ({
      state: stateShape === "flat" ? group[0]!.candidate.data : { candidate: group[0]!.candidate.data },
      entries: group.map((item) => ({ item, ref })),
    }));
  }
  if (isolation === "file") return chunk(items, maxCandidates);
  const byRule = Map.groupBy(items, (item) => item.rule.id);
  return [...byRule.values()].flatMap((group) => chunk(group, maxCandidates));
}
