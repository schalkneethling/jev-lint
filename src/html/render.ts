import { chromium, type Browser, type Page } from "playwright";
import type { AxeResult } from "../axe/report.ts";

/** Marks elements that axe reported on, so its results can be joined to ours exactly. Read back in parse.ts. */
const AXE_ATTRIBUTE = "data-jev-axe";
/** Marks aria-hidden elements that are not visible either. Read back by the aria-hidden rule. */
const NOT_VISIBLE_ATTRIBUTE = "data-jev-not-visible";

let browser: Promise<Browser> | undefined;

/**
 * The page as users get it: after scripts ran, which is also what axe saw. Each axe result is
 * stamped onto its element by resolving axe's own selector in the browser, so the join between
 * the two tools is a DOM lookup and never a comparison of HTML strings.
 */
export async function renderPage(url: string, axeResults: AxeResult[] = []): Promise<string> {
  browser ??= chromium.launch();
  const page = await (await browser).newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await stampAxeTargets(page, axeResults);
    await stampVisibility(page);
    return await page.content();
  } finally {
    await page.close();
  }
}

/**
 * Records which aria-hidden elements a sighted user cannot see either. A closed dialog or a collapsed
 * accordion panel is hidden both ways, which is correct; aria-hidden is only a defect on content that
 * is on screen. Only the browser knows the difference, so it is stamped here for `parse.ts` to read.
 */
export async function stampVisibility(page: Page): Promise<void> {
  await page.evaluate((attribute) => {
    for (const element of document.querySelectorAll('[aria-hidden="true"]')) {
      const box = element.getBoundingClientRect();
      // Off-canvas drawers are laid out, just parked outside the page.
      const offCanvas = box.right <= 0 || box.bottom <= 0 || box.left >= document.documentElement.scrollWidth;
      const seen = element.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && box.width > 0 && box.height > 0 && !offCanvas;
      if (!seen) element.setAttribute(attribute, "");
    }
  }, NOT_VISIBLE_ATTRIBUTE);
}

/** Writes each result's index onto the element its selector resolves to. `parse.ts` reads the indexes back. */
export async function stampAxeTargets(page: Page, axeResults: AxeResult[]): Promise<void> {
  await page.evaluate(
    ({ targets, attribute }) => {
      targets.forEach((target, index) => {
        let element: Element | null = null;
        try {
          element = document.querySelector(target);
        } catch {
          // A selector this browser cannot parse joins nothing.
        }
        if (element) element.setAttribute(attribute, `${element.getAttribute(attribute) ?? ""} ${index}`.trim());
      });
    },
    { targets: axeResults.map((result) => result.target), attribute: AXE_ATTRIBUTE },
  );
}

export async function closeBrowser(): Promise<void> {
  await (await browser)?.close();
  browser = undefined;
}
