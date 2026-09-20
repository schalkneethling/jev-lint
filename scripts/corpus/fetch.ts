// Builds a corpus of rendered pages from the wild, chosen by a seeded random sample of the Tranco
// ranking so that neither the rule author nor the prompts influence what gets tested.
//
//   varlock run -- node scripts/corpus/fetch.ts --list <top-1m.csv> [--seed 1] [--homes 100] [--forms 50] [--out corpus]
//
// Per site: the home page, and one form page found by following a contact, sign-in, sign-up, or checkout
// link, because home pages rarely contain the forms several rules are about. axe runs in the same visit
// and its results are stamped onto the elements before the DOM is saved, so snapshots join to axe exactly.
//
// The repo keeps the manifest. Snapshots and the axe report quote other people's pages: they stay in
// gitignored paths and are rebuilt from the seed.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AxeBuilder } from "@axe-core/playwright";
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { chromium, type BrowserContext, type Page } from "playwright";
import { toAxeResults, type AggregateEntry } from "../../src/axe/report.ts";
import { MODEL } from "../../src/engine/client.ts";
import { stampAxeTargets, stampVisibility } from "../../src/html/render.ts";

const { values } = parseArgs({
  options: {
    list: { type: "string" },
    seed: { type: "string", default: "1" },
    homes: { type: "string", default: "100" },
    forms: { type: "string", default: "50" },
    out: { type: "string", default: "corpus" },
  },
});
if (!values.list) throw new Error("--list <path to Tranco top-1m.csv> is required");

// Rank bands, sampled equally: the head of the web is built very differently from its long tail.
const BANDS = [
  { name: "top-1k", from: 1, to: 1_000 },
  { name: "1k-100k", from: 1_001, to: 100_000 },
  { name: "100k-1m", from: 100_001, to: 1_000_000 },
] as const;

const CONCURRENCY = 5;
const NAVIGATION_TIMEOUT = 20_000;
const FORM_LINK = /contact|log-?in|sign-?in|sign-?up|register|join|checkout|subscribe|account/i;
// A random sample of the web includes sites nobody should have to label. A keyword list was tried first
// and let an adult site through whose title was slang in another language: what a site is about is a
// judgement about meaning, so Jev makes it, from the same few words a person would glance at.
const UNSUITABLE_ABOVE = 0.3;
const jev = new TypeSafeClient({ defaultModel: MODEL });

async function isUnsuitable(site: { domain: string; title: string; description: string; start_of_page_text: string }): Promise<boolean> {
  const { answers } = await jev.systemOne({
    state: site,
    questions: {
      unsuitable: noul(
        "`domain`, `title`, `description`, and `start_of_page_text` are taken from the home page of a website. Is this a pornographic or sexually explicit site, a gambling or betting site, or a piracy site?",
        {
          true: "The site offers or promotes pornography, escorts, explicit sexual content, casino games, sports betting, or pirated films, software, or streams, in any language or slang.",
          false: "Anything else, including shops that sell clothing or lingerie, dating advice, health information, news, and games that do not involve betting money.",
        },
      ),
    },
  });
  return answers.unsuitable.noul > UNSUITABLE_ABOVE;
}

/** mulberry32: a small seeded generator, so the same seed always yields the same corpus. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface ManifestEntry {
  file: string;
  url: string;
  kind: "home" | "form";
  domain: string;
  rank: number;
  band: string;
  title: string;
  fetchedAt: string;
  sha256: string;
}

const manifest: ManifestEntry[] = [];
const axeReport: (AggregateEntry & { testId: string; title: string; status: string })[] = [];
const skipped: Record<string, number> = {};
const skip = (reason: string) => void (skipped[reason] = (skipped[reason] ?? 0) + 1);

const snapshots = `${values.out}/snapshots`;
mkdirSync(snapshots, { recursive: true });

async function load(page: Page, url: string): Promise<boolean> {
  const response = await page.goto(url, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT });
  // Late content matters to a rendered-DOM corpus, but a page that never goes idle should not stall the run.
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  return response !== null && response.status() < 400;
}

async function save(page: Page, entry: Omit<ManifestEntry, "file" | "url" | "title" | "fetchedAt" | "sha256">): Promise<void> {
  const analysis = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const file = `${snapshots}/${String(entry.rank).padStart(7, "0")}-${entry.domain}${entry.kind === "form" ? "-form" : ""}.html`;
  const axe = { url: file, failed: analysis.violations, passed: analysis.passes } as unknown as AggregateEntry["axe"];
  await stampAxeTargets(page, toAxeResults(axe));
  await stampVisibility(page);
  const html = await page.content();
  writeFileSync(file, html);
  const title = await page.title();
  manifest.push({ ...entry, file, url: page.url(), title, fetchedAt: new Date().toISOString(), sha256: createHash("sha256").update(html).digest("hex") });
  axeReport.push({ testId: file, title, status: analysis.violations.length > 0 ? "failed" : "passed", axe });
}

/** Whether the page in front of us is one a person can read and that is worth judging. */
async function suitable(page: Page, domain: string): Promise<string | true> {
  const facts = await page.evaluate(() => {
    const words = (document.body?.innerText ?? "").split(/\s+/).filter(Boolean);
    return {
      lang: document.documentElement.lang.toLowerCase(),
      words: words.length,
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
      start: words.slice(0, 60).join(" "),
    };
  });
  // Jev is trained mainly on English. A page that does not declare its language cannot be assumed to be English.
  if (!facts.lang.startsWith("en")) return "not declared English";
  if (facts.words < 80) return "too little text";
  if (await isUnsuitable({ domain, title: facts.title, description: facts.description, start_of_page_text: facts.start })) return "unsuitable content";
  return true;
}

async function formPage(page: Page): Promise<string | undefined> {
  const links = await page.evaluate((pattern) => {
    const test = new RegExp(pattern, "i");
    return [...document.querySelectorAll("a[href]")]
      .map((a) => ({ href: (a as HTMLAnchorElement).href, text: a.textContent ?? "" }))
      .filter(({ href, text }) => href.startsWith(location.origin) && (test.test(href) || test.test(text)))
      .map(({ href }) => href.split("#")[0]!);
  }, FORM_LINK.source);
  return [...new Set(links)].find((href) => href !== page.url());
}

async function visit(context: BrowserContext, domain: string, rank: number, band: string, wantForm: () => boolean, tookForm: () => void): Promise<boolean> {
  const page = await context.newPage();
  try {
    if (!(await load(page, `https://${domain}/`))) return skip("error status"), false;
    const verdict = await suitable(page, domain);
    if (verdict !== true) return skip(verdict), false;
    const formUrl = wantForm() ? await formPage(page) : undefined;
    await save(page, { kind: "home", domain, rank, band });

    if (formUrl && (await load(page, formUrl).catch(() => false))) {
      const fields = await page.locator("form input:not([type=hidden]):not([type=submit]), form textarea, form select").count();
      if (fields >= 2 && (await suitable(page, domain)) === true && wantForm()) {
        tookForm();
        await save(page, { kind: "form", domain, rank, band });
      }
    }
    return true;
  } catch {
    return skip("navigation failed"), false;
  } finally {
    await page.close();
  }
}

const next = random(Number(values.seed));
const ranked = readFileSync(values.list, "utf8").trim().split("\n").map((line) => line.split(",") as [string, string]);
const browser = await chromium.launch();
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });

const perBand = Math.ceil(Number(values.homes) / BANDS.length);
let forms = 0;
for (const band of BANDS) {
  const candidates = shuffled(ranked.slice(band.from - 1, band.to), next);
  let taken = 0;
  let inFlight = 0;
  let cursor = 0;
  const worker = async () => {
    // Visits in flight count against the quota, or parallel workers would each finish one site too many.
    while (taken + inFlight < perBand && cursor < candidates.length) {
      const [rank, domain] = candidates[cursor++]!;
      inFlight++;
      const kept = await visit(context, domain, Number(rank), band.name, () => forms < Number(values.forms), () => void forms++);
      inFlight--;
      if (kept) taken++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`${band.name}: ${taken} sites after trying ${cursor}`);
}
await browser.close();

manifest.sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(`${values.out}/manifest.json`, `${JSON.stringify({ seed: Number(values.seed), list: "Tranco top-1m", pages: manifest }, null, 2)}\n`);
writeFileSync(`${values.out}/axe-report.json`, JSON.stringify(axeReport));
console.log(`${manifest.filter((m) => m.kind === "home").length} home pages, ${manifest.filter((m) => m.kind === "form").length} form pages`);
console.log("skipped:", skipped);
