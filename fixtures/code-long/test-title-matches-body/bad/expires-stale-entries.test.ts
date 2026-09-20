// The title claims entries expire. The setup builds a cache with a time to live and walks a fake
// clock well past it, and the only assertion, at the very end, checks that an ETag round-trips.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LruCache } from "../cache.ts";

test("drops an entry once its time to live has passed", async () => {
  const clock = { now: 1_700_000_000_000 };
  const evicted: { key: string; reason: string }[] = [];

  const cache = new LruCache<string, { body: string; etag: string; contentType: string }>({
    maxEntries: 8,
    ttlMs: 60_000,
    staleWhileRevalidateMs: 5_000,
    now: () => clock.now,
    onEvict: (key: string, _value: unknown, reason: string) => {
      evicted.push({ key, reason });
    },
  });

  const pages = [
    { key: "/posts/1", body: "<article>first</article>", etag: 'W/"1"', contentType: "text/html" },
    { key: "/posts/2", body: "<article>second</article>", etag: 'W/"2"', contentType: "text/html" },
    { key: "/posts/3", body: "<article>third</article>", etag: 'W/"3"', contentType: "text/html" },
    { key: "/feed.xml", body: "<rss></rss>", etag: 'W/"feed-1"', contentType: "application/rss+xml" },
  ];

  for (const page of pages) {
    cache.set(page.key, { body: page.body, etag: page.etag, contentType: page.contentType });
    clock.now += 10_000;
  }

  // Touching an entry moves it to the front of the list but does not refresh its deadline: a hot
  // key that is never rewritten still has to be revalidated once a minute.
  cache.get("/posts/1");
  clock.now += 25_000;
  cache.get("/posts/2");
  clock.now += 25_000;
  cache.get("/feed.xml");

  clock.now += 20_000;
  cache.set("/posts/4", { body: "<article>fourth</article>", etag: 'W/"4"', contentType: "text/html" });
  clock.now += 5_000;

  const stored = cache.get("/posts/4");

  assert.equal(stored?.etag, 'W/"4"');
});
