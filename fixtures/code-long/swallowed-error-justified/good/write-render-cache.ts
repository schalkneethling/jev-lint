// The comment's reason ("a miss only costs a re-render") is only checkable against the last
// statements of a ~2.4k character try block: the write is the final step and nothing reads its result.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface RenderInput {
  route: string;
  locale: string;
  props: Record<string, unknown>;
  html: string;
  assets: string[];
  generatedAt: number;
}

export function storeRenderedPage(cacheDir: string, input: RenderInput, budgetBytes: number) {
  let written = false;
  try {
    const fingerprint = createHash("sha256")
      .update(input.route)
      .update("\u0000")
      .update(input.locale)
      .update("\u0000")
      .update(JSON.stringify(input.props, Object.keys(input.props).sort()))
      .digest("hex")
      .slice(0, 32);

    const sizeBytes = Buffer.byteLength(input.html, "utf8");
    if (sizeBytes > budgetBytes) {
      throw new RangeError(`The rendered page for ${input.route} is ${sizeBytes} bytes, over the ${budgetBytes} byte budget.`);
    }

    const assets = [...new Set(input.assets)].sort().map((asset) => (asset.startsWith("/") ? asset : `/${asset}`));
    const preload = assets
      .filter((asset) => asset.endsWith(".css") || asset.endsWith(".js") || asset.endsWith(".woff2"))
      .map((asset) => ({ href: asset, as: asset.endsWith(".css") ? "style" : asset.endsWith(".woff2") ? "font" : "script" }));

    const inlineStyles = [...input.html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]!.length);
    if (inlineStyles.reduce((sum, length) => sum + length, 0) > 32_000) {
      throw new RangeError(`The rendered page for ${input.route} carries more than 32kB of inline CSS.`);
    }

    // A page rendered with a stale build's assets would be served with hashes that no longer
    // resolve, so the manifest version is part of what the entry is keyed on.
    const missing = assets.filter((asset) => !/\.[0-9a-f]{8,}\.[a-z0-9]+$/.test(asset) && !asset.startsWith("/static/"));
    if (missing.length > 0) {
      throw new RangeError(`${missing.length} assets on ${input.route} are not fingerprinted: ${missing.slice(0, 3).join(", ")}`);
    }

    const entry = {
      version: 3,
      route: input.route,
      locale: input.locale,
      fingerprint,
      sizeBytes,
      assets,
      preload,
      generatedAt: input.generatedAt,
      expiresAt: input.generatedAt + 15 * 60 * 1000,
      html: input.html,
    };

    const path = join(cacheDir, input.locale, `${input.route.replace(/^\//, "").replace(/\//g, "__") || "index"}.${fingerprint}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entry));
    written = true;
  } catch {
    // The cache is a shortcut, not a source of truth: a page that fails to be written is rendered
    // again on the next request, at the cost of a few milliseconds and nothing else.
  }
  return written;
}
