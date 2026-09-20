import { TypeSafeClient, type EntryType, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";

// Pinned rather than `jev-latest`: rule thresholds are tuned against a specific version.
export const MODEL = "jev-1.13.0";

export type Ask = (state: EntryType, questions: Questions) => Promise<Pick<SystemOneResult<Questions>, "answers" | "usage">>;

export function createAsk(): Ask {
  const client = new TypeSafeClient({ defaultModel: MODEL, timeout: 30_000 });
  return (state, questions) => client.systemOne({ state, questions });
}
