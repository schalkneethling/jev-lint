// Builds a corpus of rendered pages from the wild, chosen by a seeded random sample of the Tranco
// ranking so that neither the rule author nor the prompts influence what gets tested.
//
//   varlock run -- node scripts/corpus/fetch.ts --list <top-1m.csv> [--seed 1] [--homes 100] [--forms 50] [--articles 50] [--out corpus]
//
// Per site: the home page; one form page found by following a contact, sign-in, sign-up, or checkout
// link, because home pages rarely contain the forms several rules are about; and one article page, because
// the first corpus had none and `description-matches-page` now classifies nothing else. axe runs in the same
// visit and its results are stamped onto the elements before the DOM is saved, so snapshots join to axe exactly.
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
import { stampAxeTargets } from "../../src/html/render.ts";

const { values } = parseArgs({
  options: {
    list: { type: "string" },
    seed: { type: "string", default: "1" },
    homes: { type: "string", default: "100" },
    forms: { type: "string", default: "50" },
    articles: { type: "string", default: "50" },
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

// Eight sites at a time, not five: a run now visits twice as many sites for their article pages, and the
// parallelism is across sites, so no site sees more than one request at a time either way.
const CONCURRENCY = 8;
const NAVIGATION_TIMEOUT = 20_000;
// A whole visit is five navigations at most, so anything past this is a page that has stopped answering
// inside a step that has no timeout of its own. The worker abandons it and takes the next site.
const VISIT_TIMEOUT = 150_000;
const FORM_LINK = /contact|log-?in|sign-?in|sign-?up|register|join|checkout|subscribe|account/i;
// How many pages a site may cost in the search for one article, and how many home-page links go into the
// queue. Most sites that have an article are answered by the first candidate; a hard budget keeps the rest
// from turning a visit into a crawl.
const ARTICLE_CANDIDATES = 3;
const ARTICLE_LOADS = 3;
// What "a substantial amount of prose" means: enough paragraphs, and enough words in them, that a
// description or a heading has something to be classified against. A listing page fails both.
const ARTICLE_PARAGRAPHS = 3;
const ARTICLE_WORDS = 200;
// A random sample of the web includes sites nobody should have to label. A keyword list was tried first
// and let an adult site through whose title was slang in another language: what a site is about is a
// classification about meaning, so Jev makes it, from the same few words a person would glance at.
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

type Kind = "home" | "form" | "article";

interface ManifestEntry {
  file: string;
  url: string;
  kind: Kind;
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
  const file = `${snapshots}/${String(entry.rank).padStart(7, "0")}-${entry.domain}${entry.kind === "home" ? "" : `-${entry.kind}`}.html`;
  const axe = { url: file, failed: analysis.violations, passed: analysis.passes } as unknown as AggregateEntry["axe"];
  await stampAxeTargets(page, toAxeResults(axe));
  const html = await page.content();
  writeFileSync(file, html);
  const title = await page.title();
  manifest.push({ ...entry, file, url: page.url(), title, fetchedAt: new Date().toISOString(), sha256: createHash("sha256").update(html).digest("hex") });
  axeReport.push({ testId: file, title, status: analysis.violations.length > 0 ? "failed" : "passed", axe });
}

/** Whether the page in front of us is one a person can read and that is worth classifying. */
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

/**
 * Links off the home page that structurally promise an article. The DOM already says which links are
 * titles of pieces — a teaser card, a heading that is a link — so nothing here reads the wording, which is
 * what let a keyword list misclassify a site's language in the suitability check. Best-first: one candidate
 * that checks out is all a site contributes.
 */
async function articleLinks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    // /2026/09/ or /2026-09-19/. A date in the path is a publication date, whatever the CMS.
    const DATE_PATH = /\/(?:19|20)\d{2}[/-]\d{1,2}[/-]/;
    const ASSET = /\.(?:pdf|jpe?g|png|gif|svg|webp|zip|mp[34]|docx?|xlsx?|csv|xml|rss)$/i;
    const here = location.href.split(/[#?]/)[0];
    const scores = new Map<string, number>();
    const consider = (anchor: Element | null | undefined, tier: number) => {
      const href = (anchor as HTMLAnchorElement | null)?.href?.split("#")[0];
      if (!href?.startsWith(`${location.origin}/`)) return;
      const path = new URL(href).pathname;
      if (href.split("?")[0] === here || path === "/" || ASSET.test(path)) return;
      // A deeper path is further from a section index and closer to a single piece.
      const score = tier * 10 + (DATE_PATH.test(path) ? 3 : 0) + Math.min(path.split("/").filter(Boolean).length, 3);
      if ((scores.get(href) ?? 0) < score) scores.set(href, score);
    };
    // A teaser card is an <article> that is not the page itself: its link points at the piece it summarises.
    for (const card of document.querySelectorAll("article")) consider(card.querySelector("h1 a[href], h2 a[href], h3 a[href], h4 a[href]") ?? card.querySelector("a[href]"), 3);
    // A heading that is a link is a title, and a title links to the thing it titles.
    for (const link of document.querySelectorAll("h1 a[href], h2 a[href], h3 a[href], h4 a[href]")) consider(link, 2);
    for (const heading of document.querySelectorAll("a[href] h1, a[href] h2, a[href] h3, a[href] h4")) consider(heading.closest("a[href]"), 2);
    // Last, links in the main content whose path has several segments or a date in it: a section and a
    // slug under it, which is how a single piece is addressed and how a top-level page is not.
    for (const link of document.querySelectorAll("main a[href], [role=main] a[href]")) {
      const href = (link as HTMLAnchorElement).href;
      if (!href.startsWith(`${location.origin}/`)) continue;
      const path = new URL(href).pathname;
      if (path.split("/").filter(Boolean).length >= 2 || DATE_PATH.test(path)) consider(link, 1);
    }
    return [...scores].sort(([, a], [, b]) => b - a).map(([href]) => href);
  });
}

/**
 * The links in the site's own feed. A feed is a machine-readable list of the site's articles, so it says
 * which pages are articles more plainly than any markup on the page does; a smoke test over a dozen sites
 * found articles on sites whose home page links to them through none of the structures above.
 */
async function feedLinks(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const feed = document.querySelector('link[rel~="alternate"][type*="xml"]') as HTMLLinkElement | null;
    if (!feed?.href.startsWith(`${location.origin}/`)) return [];
    try {
      // A feed that accepts the connection and then never answers would otherwise park this page for good:
      // page.evaluate has no timeout of its own, and one stuck worker per hanging feed stalls the run.
      const response = await fetch(feed.href, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return [];
      const items = new DOMParser().parseFromString(await response.text(), "application/xml").querySelectorAll("item > link, entry > link");
      const hrefs = [...items].map((link) => link.getAttribute("href") ?? link.textContent ?? "").map((href) => href.split("#")[0]!);
      return [...new Set(hrefs.filter((href) => href.startsWith(`${location.origin}/`)))];
    } catch {
      // A feed that 404s, is not XML, or is blocked by CORS simply contributes no candidates.
      return [];
    }
  });
}

/**
 * Whether the page loaded really is an article: the same test `description-matches-page` applies, plus
 * enough prose for that rule to have something to classify. A section index
 * satisfies neither, and a teaser link often leads to one.
 */
async function isArticlePage(page: Page): Promise<boolean> {
  const facts = await page.evaluate(() => {
    const heading = document.querySelector("h1");
    const inArticle = heading?.closest("article") ?? null;
    const ogType = document.querySelector('meta[property="og:type"]')?.getAttribute("content") ?? "";
    const container = inArticle ?? document.querySelector("article") ?? document.querySelector("main") ?? document.body;
    const paragraphs = [...(container?.querySelectorAll("p") ?? [])]
      .filter((p) => !p.closest("nav, footer, header, aside, form, dialog"))
      .map((p) => (p.textContent ?? "").split(/\s+/).filter(Boolean).length);
    return {
      isArticle: inArticle !== null || ogType.toLowerCase() === "article",
      // Short paragraphs are captions, bylines, and card blurbs; they are not what the page is about.
      paragraphs: paragraphs.filter((words) => words >= 15).length,
      words: paragraphs.reduce((sum, words) => sum + words, 0),
    };
  });
  return facts.isArticle && facts.paragraphs >= ARTICLE_PARAGRAPHS && facts.words >= ARTICLE_WORDS;
}

/** Gives up on a visit that has stopped making progress. The page it left open closes with the browser. */
async function abandonAfter(visit: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // An abandoned visit keeps running; .catch keeps its late failure from reaching an empty event loop.
    return await Promise.race([visit.catch(() => false), new Promise<boolean>((resolve) => (timer = setTimeout(() => (skip("visit timed out"), resolve(false)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

interface Quota {
  want: (kind: Exclude<Kind, "home">) => boolean;
  take: (kind: Kind) => void;
}

async function visit(context: BrowserContext, domain: string, rank: number, band: string, quota: Quota, wantHome: boolean): Promise<boolean> {
  const page = await context.newPage();
  try {
    if (!(await load(page, `https://${domain}/`))) return skip("error status"), false;
    const suitability = await suitable(page, domain);
    if (suitability !== true) return skip(suitability), false;
    // Both extra pages are chosen here, while the home page is still the one loaded.
    const formUrl = quota.want("form") ? await formPage(page) : undefined;
    // The feed goes first: its entries are articles by definition, where a link only looks like one.
    const articleUrls = quota.want("article") ? [...new Set([...(await feedLinks(page)).slice(0, 2), ...(await articleLinks(page))])].slice(0, ARTICLE_CANDIDATES) : [];
    // Once the home quota is full the visit continues for the extra pages alone, which is how a corpus
    // with 90 home pages can hold more article pages than one site in four turns out to have.
    if (wantHome) {
      quota.take("home");
      await save(page, { kind: "home", domain, rank, band });
    }

    if (formUrl && (await load(page, formUrl).catch(() => false))) {
      const fields = await page.locator("form input:not([type=hidden]):not([type=submit]), form textarea, form select").count();
      if (fields >= 2 && (await suitable(page, domain)) === true && quota.want("form")) {
        quota.take("form");
        await save(page, { kind: "form", domain, rank, band });
      }
    }
    // The candidates are ranked, so the first one that is really an article ends the search.
    let article = false;
    const tried = new Set<string>();
    for (let loads = 0; articleUrls.length > 0 && loads < ARTICLE_LOADS && quota.want("article") && !article; loads++) {
      const url = articleUrls.shift()!;
      tried.add(url);
      if (!(await load(page, url).catch(() => false))) continue;
      if (!(await isArticlePage(page))) {
        // A candidate that is not an article is usually the section index above one, and its teasers are
        // better links than anything left on the home page. One hop, inside the same budget, never a crawl.
        articleUrls.unshift(...(await articleLinks(page)).filter((href) => !tried.has(href)).slice(0, ARTICLE_LOADS));
        continue;
      }
      if ((await suitable(page, domain)) !== true) continue;
      quota.take("article");
      await save(page, { kind: "article", domain, rank, band });
      article = true;
    }
    if (tried.size > 0 && !article) skip("no article page kept");
    return true;
  } catch {
    return skip("navigation failed"), false;
  } finally {
    await page.close();
  }
}

const next = random(Number(values.seed));
const ranked = readFileSync(values.list, "utf8").trim().split("\n").map((line) => line.trim().split(",") as [string, string]);
const browser = await chromium.launch();
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });

// Each band gets its own share of every quota, so the head of the web cannot use up the articles before
// the tail is reached.
const perBand = Object.fromEntries(
  (["home", "form", "article"] as Kind[]).map((kind) => [kind, Math.ceil(Number({ home: values.homes, form: values.forms, article: values.articles }[kind]) / BANDS.length)]),
) as Record<Kind, number>;
for (const band of BANDS) {
  const candidates = shuffled(ranked.slice(band.from - 1, band.to), next);
  const taken: Record<Kind, number> = { home: 0, form: 0, article: 0 };
  let sites = 0;
  let inFlight = 0;
  let cursor = 0;
  const quota: Quota = { want: (kind) => taken[kind] < perBand[kind], take: (kind) => void taken[kind]++ };
  // Visits in flight count against the home quota, or parallel workers would each finish one site too many.
  const wantHome = () => taken.home + inFlight < perBand.home;
  // Articles are rare enough that the home quota fills first, so the band goes on visiting sites for their
  // articles alone — but never more than twice the sites it would have visited, or a band of shops with no
  // articles at all would run until the list ran out.
  const more = () => wantHome() || (quota.want("article") && sites + inFlight < perBand.home * 2);
  const worker = async () => {
    while (more() && cursor < candidates.length) {
      const [rank, domain] = candidates[cursor++]!;
      const home = wantHome();
      inFlight++;
      const kept = await abandonAfter(visit(context, domain, Number(rank), band.name, quota, home), VISIT_TIMEOUT);
      inFlight--;
      if (kept) sites++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`${band.name}: ${sites} sites after trying ${cursor} (${taken.home} home, ${taken.form} form, ${taken.article} article)`);
}
await browser.close();

manifest.sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(`${values.out}/manifest.json`, `${JSON.stringify({ seed: Number(values.seed), list: "Tranco top-1m", pages: manifest }, null, 2)}\n`);
writeFileSync(`${values.out}/axe-report.json`, JSON.stringify(axeReport));
const kept = (kind: Kind) => manifest.filter((entry) => entry.kind === kind).length;
console.log(`${kept("home")} home pages, ${kept("form")} form pages, ${kept("article")} article pages`);
console.log("skipped:", skipped);
