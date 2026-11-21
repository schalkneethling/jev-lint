import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { noul } from "@typesafe-ai/sdk";
import type { CodeDoc } from "./code/parse.ts";
import { DEFAULT_THRESHOLDS, defineCodeRule, type AnyRule, type Candidate, type Thresholds } from "./engine/types.ts";
import { clip } from "./rules/code/shared.ts";

/**
 * What a declarative rule can be asked about, and the fields each offers. A field reaches Jev only if the
 * rule's `ask` names it, so a question about a function's name never pays for, or is diluted by, its body.
 */
const SOURCES = {
  functions: (doc: CodeDoc) => doc.functions.map((fn) => ({ loc: fn.loc, fields: { name: fn.name, body: clip(fn.body), documentation: fn.doc, parameters: fn.params } })),
  comments: (doc: CodeDoc) => doc.comments.map((comment) => ({ loc: comment.loc, fields: { comment: comment.text, code: clip(comment.code) } })),
  tests: (doc: CodeDoc) => doc.tests.map((test) => ({ loc: test.loc, fields: { title: test.title, suite: test.suites.join(" > "), body: clip(test.body) } })),
  guards: (doc: CodeDoc) => doc.guards.map((guard) => ({ loc: guard.loc, fields: { condition: guard.condition, error_message: guard.message } })),
  catches: (doc: CodeDoc) => doc.emptyCatches.map((handler) => ({ loc: handler.loc, fields: { code_that_can_fail: clip(handler.tried), comment_in_handler: handler.comment, comment_above: handler.commentAbove, statement_before: handler.before, statement_after: handler.after } })),
} satisfies Record<string, (doc: CodeDoc) => { loc: Candidate["loc"]; fields: Record<string, string> }[]>;

export type CustomRuleSource = keyof typeof SOURCES;

/** A field of each source to suggest when a question names none. */
const FIRST_FIELD: Record<CustomRuleSource, string> = { functions: "name", comments: "comment", tests: "title", guards: "condition", catches: "code_that_can_fail" };

/**
 * A rule written in a config file, without touching jev-lint's source. It is one yes/no classification over
 * one kind of thing the parser already extracts. Fields are named in braces:
 *
 *   {
 *     id: "test-title-names-behaviour",
 *     on: "tests",
 *     ask: "{title} is the title of a test. Does it name the behaviour being tested?",
 *     criteria: { true: "…", false: "…" },
 *     reportWhen: "no",
 *     message: 'Test title "{title}" does not name a behaviour.',
 *   }
 */
export interface CustomRule {
  id: string;
  description?: string;
  on: CustomRuleSource;
  /** The question. `{field}` names a field of the thing being classified; see `SOURCES` for each kind's fields. */
  ask: string;
  /** What counts as yes and as no. Worth writing whenever the boundary is not obvious. */
  criteria?: { true: string; false: string };
  /** Which answer is the defect. Defaults to "yes": ask for the defect, not the virtue. */
  reportWhen?: "yes" | "no";
  /** What the finding says. `{field}` is replaced with the field's text; only fields that `ask` names can be used. */
  message: string;
  thresholds?: Partial<Thresholds>;
  /** Only classify things for which every listed field matches its pattern: what a parser can decide, it should. */
  where?: { [field: string]: RegExp };
}

export interface Config {
  /** Globs, relative to the linted directory, that are never linted. */
  ignore?: string[];
  /** Per built-in rule: "off", "on" (for a rule that is opt-in), or thresholds that replace the rule's own (which also turns it on). */
  rules?: { [ruleId: string]: "off" | "on" | Partial<Thresholds> };
  /**
   * Conventions of this codebase, in plain sentences, given to Jev as facts by the rules that can use them.
   * For example: "verify* helpers report through context.report and return nothing."
   */
  conventions?: string[];
  /** Your own rules: declarative (`CustomRule`) or full rules built with `defineCodeRule` / `defineRule`. */
  custom?: (CustomRule | AnyRule)[];
}

/** Identity function that gives a config file type checking and completion. */
export const defineConfig = (config: Config): Config => config;

const FIELD = /\{(\w+)\}/g;

export function fromCustomRule(rule: CustomRule): AnyRule {
  const source = SOURCES[rule.on];
  if (!source) throw new Error(`Custom rule "${rule.id}": unknown \`on\` "${rule.on}". Use one of: ${Object.keys(SOURCES).join(", ")}.`);
  const asked = [...new Set([...rule.ask.matchAll(FIELD)].map((match) => match[1]!))];
  if (asked.length === 0) throw new Error(`Custom rule "${rule.id}": \`ask\` names no field. Name one in braces, such as {${FIRST_FIELD[rule.on]}}.`);
  // The message is filled from the words that were classified, so it can name only fields the question names.
  const unasked = [...rule.message.matchAll(FIELD)].map((match) => match[1]!).filter((name) => !asked.includes(name));
  if (unasked.length > 0) throw new Error(`Custom rule "${rule.id}": \`message\` uses {${unasked.join("}, {")}}, which \`ask\` does not name. A message can only quote fields the question is about.`);
  // A pattern with the `g` or `y` flag remembers where it last matched, and would skip every other candidate.
  const where = Object.entries(rule.where ?? {}).map(([name, pattern]) => {
    // A config in plain JavaScript gets no type checking, and a string here would fail far from its cause.
    if (!(pattern instanceof RegExp)) throw new Error(`Custom rule "${rule.id}": \`where.${name}\` must be a regular expression, such as /^get/.`);
    return [name, new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""))] as const;
  });
  return defineCodeRule({
    id: rule.id,
    description: rule.description ?? rule.ask,
    ...(rule.thresholds && { thresholds: rule.thresholds }),
    select: (doc) =>
      source(doc).flatMap(({ loc, fields }) => {
        const all = fields as Record<string, string>;
        for (const name of [...asked, ...where.map(([field]) => field)]) {
          if (!(name in all)) throw new Error(`Custom rule "${rule.id}": "${rule.on}" has no field "${name}". It has: ${Object.keys(all).join(", ")}.`);
        }
        if (where.some(([name, pattern]) => !pattern.test(all[name]!))) return [];
        // A field the question is about but that is empty here (a function with no doc block) leaves nothing to
        // classify. An ignored error is the exception: an empty comment or no line below it is itself the fact.
        if (rule.on !== "catches" && asked.some((name) => all[name] === "")) return [];
        return [{ loc, data: Object.fromEntries(asked.map((name) => [name, all[name]!])) }];
      }),
    questions: (ref) => ({ answer: noul(rule.ask.replace(FIELD, (_, name: string) => ref(name)), rule.criteria) }),
    assess: ({ answer }, candidate) => ({
      p: rule.reportWhen === "no" ? 1 - answer.noul : answer.noul,
      message: rule.message.replace(FIELD, (_, name: string) => String(candidate.data[name])),
    }),
  });
}

const CONFIG_FILES = ["jev-lint.config.ts", "jev-lint.config.mts", "jev-lint.config.mjs", "jev-lint.config.js"];

/** Loads the config named by `path`, or the first config file found in `dir`. No file means no config. */
export async function loadConfig(dir: string, path?: string): Promise<Config> {
  const file = path ? resolve(path) : CONFIG_FILES.map((name) => resolve(dir, name)).find((candidate) => existsSync(candidate));
  if (!file) return {};
  if (!existsSync(file)) throw new Error(`Config file not found: ${file}`);
  const module = (await import(pathToFileURL(file).href)) as { default?: Config };
  if (!module.default || typeof module.default !== "object") throw new Error(`${file} must have a default export: the config object.`);
  return module.default;
}

/**
 * The same rules with every review threshold lowered to `floor`, for a run whose reports a second reader
 * will confirm (docs/verify-findings.md). A rule's own thresholds are set for a person reading the report
 * unaided; a reader that opens each file can take a longer list and find more in it. Errors and warnings
 * stay where they are, and a rule whose review threshold is already lower is left alone.
 */
export function widen(rules: AnyRule[], floor: number): AnyRule[] {
  return rules.map((rule) => ({ ...rule, thresholds: { ...rule.thresholds, review: Math.min(rule.thresholds?.review ?? DEFAULT_THRESHOLDS.review, floor) } }));
}

/** Applies a config to the built-in rules: switches rules off, replaces thresholds, and appends custom rules. */
export function configureRules(builtIn: AnyRule[], config: Config): AnyRule[] {
  for (const id of Object.keys(config.rules ?? {})) {
    if (!builtIn.some((rule) => rule.id === id)) throw new Error(`Config names a rule that does not exist: "${id}".`);
  }
  const kept = builtIn.flatMap((rule) => {
    const setting = config.rules?.[rule.id];
    if (setting === "off" || (rule.optIn && setting === undefined)) return [];
    return [setting && setting !== "on" ? { ...rule, thresholds: { ...rule.thresholds, ...setting } } : rule];
  });
  for (const rule of config.custom ?? []) {
    // The shape a suppression directive can name: `// jev-lint-disable-next-line my-rule`. Checked for every
    // custom rule, declarative or not, and for a missing id, which a plain JavaScript config can have.
    if (typeof rule.id !== "string" || !/^[\w-]+$/.test(rule.id)) throw new Error(`Custom rule id ${JSON.stringify(rule.id)} must be a string of letters, digits, hyphens and underscores.`);
  }
  const custom = (config.custom ?? []).map((rule) => ("select" in rule ? rule : fromCustomRule(rule)));
  for (const rule of custom) if (kept.some((other) => other.id === rule.id)) throw new Error(`Custom rule id "${rule.id}" is already taken by a built-in rule.`);
  return [...kept, ...custom];
}
