import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EntryType, Question, ResultFor } from "@typesafe-ai/sdk";

type Answer = ResultFor<Question>;

/** One JSON file per key in a directory. A missing or unreadable file is a miss, never an error. */
export class JsonStore<T> {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  static hash(parts: unknown): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }

  get(key: string): T | undefined {
    try {
      return JSON.parse(readFileSync(join(this.#dir, `${key}.json`), "utf8"));
    } catch {
      return undefined;
    }
  }

  set(key: string, value: T): void {
    writeFileSync(join(this.#dir, `${key}.json`), JSON.stringify(value));
  }
}

/**
 * Answers are independent per question, so they are cached per (model, state, question).
 * A rerun over unchanged input costs nothing and returns identical results.
 */
export class AnswerCache extends JsonStore<Answer> {
  static key(model: string, state: EntryType, question: Question): string {
    return JsonStore.hash([model, state, question]);
  }
}
