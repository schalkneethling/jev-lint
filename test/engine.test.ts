import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toBatches } from "../src/engine/batch.ts";
import { AnswerCache } from "../src/engine/cache.ts";
import type { Ask } from "../src/engine/client.ts";
import { run } from "../src/engine/run.ts";
import { severityFor } from "../src/engine/types.ts";
import labelInputType from "../src/rules/html/label-input-type.ts";
import linkTextPurpose from "../src/rules/html/link-text-purpose.ts";

const html = `<p><a href="/a">click here</a>
<a href="/b">Pricing</a>
<a href="/a">click here</a></p>`;
const files = [{ path: "page.html", source: html }];

/** Answers every noul with 0.98 for "click here" and 0.03 otherwise, and records each request. */
function fakeAsk(): { ask: Ask; requests: unknown[] } {
  const requests: unknown[] = [];
  const ask: Ask = async (state, questions) => {
    requests.push(state);
    const noul = JSON.stringify(state).includes("click here") ? 0.98 : 0.03;
    return {
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul" as const, noul }])),
      usage: { input_tokens: 100, output_tokens: 1 },
    };
  };
  return { ask, requests };
}

test("severityFor applies default and overridden thresholds", () => {
  assert.equal(severityFor(0.85), "error");
  assert.equal(severityFor(0.65), "warn");
  assert.equal(severityFor(0.45), "review");
  assert.equal(severityFor(0.39), null);
  assert.equal(severityFor(0.85, { error: 0.9 }), "warn");
});

test("findings carry the source location of each reported element", async () => {
  const { ask } = fakeAsk();
  const { findings } = await run(files, { rules: [linkTextPurpose], ask, isolation: "candidate" });
  assert.deepEqual(
    findings.map((f) => [f.loc.line, f.loc.col, f.severity]),
    [[1, 4, "error"], [3, 1, "error"]],
  );
});

test("identical candidates are sent once per run", async () => {
  const { ask, requests } = fakeAsk();
  const { stats } = await run(files, { rules: [linkTextPurpose], ask, isolation: "candidate" });
  assert.equal(requests.length, 2);
  // No heading sits above these links, so only the filler question is asked; the repeated
  // "click here" link reuses its answer.
  assert.deepEqual(stats, { requests: 2, questions: 3, cacheHits: 1, inputTokens: 200, unanswered: 0 });
});

test("a second run is answered entirely from the cache", async () => {
  const cache = new AnswerCache(mkdtempSync(join(tmpdir(), "jev-lint-")));
  const first = fakeAsk();
  const a = await run(files, { rules: [linkTextPurpose], ask: first.ask, isolation: "candidate", cache });
  const second = fakeAsk();
  const b = await run(files, { rules: [linkTextPurpose], ask: second.ask, isolation: "candidate", cache });
  assert.equal(second.requests.length, 0);
  assert.deepEqual(b.findings, a.findings);
});

test("toBatches refs name each candidate's fields within its state", () => {
  const items = ["a", "b", "c"].map((link_text) => ({
    rule: linkTextPurpose,
    candidate: { loc: { line: 1, col: 1 }, data: { link_text } },
  }));
  const flat = toBatches(items, "candidate", Infinity, "flat");
  assert.deepEqual(flat[0]!.state, { link_text: "a" });
  assert.deepEqual(flat.map((b) => b.entries.map((e) => e.ref("link_text"))), [["`link_text`"], ["`link_text`"], ["`link_text`"]]);
  const wrapped = toBatches(items, "candidate", Infinity, "wrapped");
  assert.deepEqual(wrapped[0]!.state, { candidate: { link_text: "a" } });
  assert.equal(wrapped[0]!.entries[0]!.ref("link_text"), "`candidate.link_text`");
  // `rule` and `file` isolation put several candidates in one state, so their refs carry the index.
  const [first, second] = toBatches(items, "rule", 2);
  assert.deepEqual(first!.state, { candidates: [{ link_text: "a" }, { link_text: "b" }] });
  assert.deepEqual(first!.entries.map((e) => e.ref("link_text")), ["`candidates[0].link_text`", "`candidates[1].link_text`"]);
  assert.deepEqual(second!.entries.map((e) => e.ref("link_text")), ["`candidates[0].link_text`"]);
});

test("a candidate decided in code is reported without asking the model", async () => {
  const { default: altTextQuality } = await import("../src/rules/html/alt-text-quality.ts");
  const { ask, requests } = fakeAsk();
  const source = `<img src="a.jpg" alt="Photo of our office">`;
  const { findings, stats } = await run([{ path: "p.html", source }], { rules: [altTextQuality], ask, isolation: "candidate" });
  assert.equal(requests.length, 0);
  assert.equal(stats.questions, 0);
  // Announcing the medium is a redundancy, so it is decided at review level.
  assert.deepEqual(findings.map((f) => [f.severity, f.p]), [["review", 0.45]]);
});

test("a question the rule leaves out is never sent and reaches assess as undefined", async () => {
  const { default: altTextQuality } = await import("../src/rules/html/alt-text-quality.ts");
  const sent: { state: unknown; count: number }[] = [];
  const ask: Ask = async (state, questions) => {
    sent.push({ state, count: Object.keys(questions).length });
    return {
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul" as const, noul: 0.1 }])),
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  const source = `<img src="a.jpg" alt="IMG_4021">
<figure><img src="b.jpg" alt="Our cat"><figcaption>Our cat on the stairs</figcaption></figure>`;
  const { classifications, stats } = await run([{ path: "p.html", source }], { rules: [altTextQuality], ask, isolation: "candidate" });
  assert.deepEqual(classifications.map((j) => Object.keys(j.answers)), [["is_placeholder"], ["is_placeholder", "repeats_caption"]]);
  assert.equal(stats.questions, 3);
  // The image without a caption carries no caption field at all, not a null one.
  assert.deepEqual(sent.map((s) => s.count), [1, 2]);
  assert.deepEqual(sent[0]!.state, { candidate: { alt: "IMG_4021", image_file_name: "a.jpg" } });
});

test("a rule's questions share one request and reach assess by name", async () => {
  const { default: altTextQuality } = await import("../src/rules/html/alt-text-quality.ts");
  const questionsSeen: string[][] = [];
  const ask: Ask = async (_state, questions) => {
    questionsSeen.push(Object.keys(questions));
    // Not a placeholder (0.1), but it repeats the caption (0.9).
    const values = [0.1, 0.9];
    return {
      answers: Object.fromEntries(Object.keys(questions).map((id, i) => [id, { type: "noul" as const, noul: values[i]! }])),
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  const source = `<figure><img src="b.jpg" alt="The bridge at sunset"><figcaption>The bridge at sunset.</figcaption></figure>`;
  const { classifications } = await run([{ path: "p.html", source }], { rules: [altTextQuality], ask, isolation: "candidate" });
  assert.equal(questionsSeen.length, 1);
  assert.deepEqual(Object.keys(classifications[0]!.answers), ["is_placeholder", "repeats_caption"]);
  assert.equal(classifications[0]!.p, 0.9);
  assert.match(classifications[0]!.message, /repeats the visible caption/);
});

test("label-input-type caps a text-typed search box at review, but leaves other mismatches at their own severity", async () => {
  const source = `<input type="text" aria-label="Search products">
<label for="e">Email</label><input id="e" type="text">`;
  const labels = ["email", "tel", "url", "number", "date", "password", "search", "free_text"];
  const ask: Ask = async (state, questions) => {
    const choice = JSON.stringify(state).includes("Search products") ? "search" : "email";
    const probabilities = Object.fromEntries(labels.map((label) => [label, label === choice ? 0.95 : 0.007]));
    return {
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "choice" as const, choice, confidence: 0.95, probabilities }])),
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  const { classifications } = await run([{ path: "p.html", source }], { rules: [labelInputType], ask, isolation: "candidate" });
  // The search box is capped to review no matter how confident Jev is; the email-in-text mismatch is untouched.
  assert.deepEqual(classifications.map((j) => [j.p, j.severity]), [[0.5, "review"], [0.993, "error"]]);
});

test("cache-only mode never asks, classifies what the cache answers, and counts the rest as unclassified", async () => {
  const cache = new AnswerCache(mkdtempSync(join(tmpdir(), "jev-lint-")));
  const warm = fakeAsk();
  await run([{ path: "a.html", source: `<a href="/a">click here</a>` }], { rules: [linkTextPurpose], ask: warm.ask, isolation: "candidate", cache });

  const never: Ask = async () => Promise.reject(new Error("the model must not be called"));
  const source = `<a href="/a">click here</a> <a href="/b">Pricing</a>`;
  const { classifications, stats } = await run([{ path: "b.html", source }], { rules: [linkTextPurpose], ask: never, isolation: "candidate", cache, cacheOnly: true });
  assert.deepEqual(classifications.map((j) => j.candidate.data.link_text), ["click here"]);
  assert.deepEqual([stats.requests, stats.unanswered], [0, 1]);
});

test("a pattern repeated across a file is reported once with every place, while classifications stay per element", async () => {
  const { default: ariaLabelJustified } = await import("../src/rules/html/aria-label-justified.ts");
  const { ask } = fakeAsk();
  const source = `<a href="/a" aria-label="Blog">Blog</a>\n<a href="/b" aria-label="Docs">Docs</a>\n<a href="/c" aria-label="About">About</a>`;
  const { findings, classifications } = await run([{ path: "p.html", source }], { rules: [ariaLabelJustified], ask, isolation: "candidate" });
  assert.equal(classifications.length, 3);
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /^3 elements in this file: the aria-label repeats/);
  assert.deepEqual(findings[0]!.occurrences!.map(({ loc }) => loc.line), [1, 2, 3]);
  assert.equal(findings[0]!.loc.line, 1);
});

test("a pattern that occurs once keeps its own message", async () => {
  const { default: ariaLabelJustified } = await import("../src/rules/html/aria-label-justified.ts");
  const { ask } = fakeAsk();
  const { findings } = await run([{ path: "p.html", source: `<a href="/a" aria-label="Blog">Blog</a>` }], { rules: [ariaLabelJustified], ask, isolation: "candidate" });
  assert.match(findings[0]!.message, /^aria-label "Blog" repeats/);
  assert.equal(findings[0]!.occurrences, undefined);
});
