// How much state should a question get? For heading-describes-section, vary how many words of the
// section are sent and watch the gap between headings that are wrong and headings that are fine.
// Usage: varlock run -- node scripts/state-experiment.ts
import { globSync, readFileSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { toBatches } from "../src/engine/batch.ts";
import { MODEL } from "../src/engine/client.ts";
import { parseHtml, truncateWords } from "../src/html/parse.ts";
import rule from "../src/rules/html/heading-describes-section.ts";

const client = new TypeSafeClient({ defaultModel: MODEL });

// Labelled cases: the fixtures, plus the five headings reported on schalkneethling.com/blog and the
// home page, where reading the page shows one real defect (a description copied from another post).
const cases: { label: "bad" | "good"; heading: string; section: string }[] = [];
for (const label of ["bad", "good"] as const) {
  for (const path of globSync(`fixtures/html/heading-describes-section/${label}/*.html`)) {
    for (const c of rule.select(parseHtml(path, readFileSync(path, "utf8")))) {
      cases.push({ label, heading: String(c.data.heading), section: String(c.data.content_under_heading) });
    }
  }
}
const real = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { label: "bad" | "good"; heading: string; section: string }[];
cases.push(...real);

const rows = [];
for (const words of [10, 20, 40, 80, 160]) {
  const scored = await Promise.all(
    cases.map(async (c) => {
      // Through the engine's own batching, so the state here is shaped exactly as a real run shapes it.
      const candidate = { loc: { line: 0, col: 0 }, data: { heading: c.heading, content_under_heading: truncateWords(c.section, words) } };
      const [batch] = toBatches([{ rule, candidate }], "candidate");
      const question = rule.questions(batch!.entries[0]!.ref, candidate).on_topic;
      const { answers, usage } = await client.systemOne({ state: batch!.state, questions: { q: question } });
      return { ...c, p: 1 - (answers.q as { noul: number }).noul, tokens: usage.input_tokens };
    }),
  );
  const bad = scored.filter((s) => s.label === "bad").map((s) => s.p);
  const good = scored.filter((s) => s.label === "good").map((s) => s.p);
  const worst = scored.filter((s) => s.label === "good").toSorted((a, b) => b.p - a.p)[0]!;
  rows.push({
    "words sent": words,
    "lowest bad": Math.min(...bad).toFixed(2),
    "highest good": Math.max(...good).toFixed(2),
    gap: (Math.min(...bad) - Math.max(...good)).toFixed(2),
    "highest good is": worst.heading.slice(0, 28),
    "mean tokens": Math.round(scored.reduce((sum, s) => sum + s.tokens, 0) / scored.length),
  });
}
console.table(rows);
