import { chromium, type Browser, type Page } from "playwright";
import type { AxeResult } from "../axe/report.ts";

/** Marks elements that axe reported on, so its results can be joined to ours exactly. Read back in parse.ts. */
const AXE_ATTRIBUTE = "data-jev-axe";

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
    return await page.content();
  } finally {
    await page.close();
  }
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
