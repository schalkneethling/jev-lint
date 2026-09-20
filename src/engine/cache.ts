import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EntryType, Question, ResultFor } from "@typesafe-ai/sdk";

type Answer = ResultFor<Question>;

/**
 * Answers are independent per question, so they are cached per (model, state, question).
 * A rerun over unchanged input costs nothing and returns identical results.
 */
export class AnswerCache {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  static key(model: string, state: EntryType, question: Question): string {
    return createHash("sha256").update(JSON.stringify([model, state, question])).digest("hex");
  }

  get(key: string): Answer | undefined {
    try {
      return JSON.parse(readFileSync(join(this.#dir, `${key}.json`), "utf8"));
    } catch {
      return undefined;
    }
  }

  set(key: string, answer: Answer): void {
    writeFileSync(join(this.#dir, `${key}.json`), JSON.stringify(answer));
  }
}
