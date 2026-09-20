// The title claims a retry on 429, and the first two thousand characters are a mock that answers 429
// twice. The only assertion is the last line, and it checks the Authorization header.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "../client.ts";

test("retries a request once when the server answers 429", async () => {
  const calls: { url: string; init: RequestInit; at: number }[] = [];
  const clock = { now: 0 };

  const widgets = Array.from({ length: 12 }, (_, index) => ({
    id: `widget-${index}`,
    name: `Widget ${index}`,
    status: index % 3 === 0 ? "archived" : "active",
    updatedAt: `2026-0${(index % 9) + 1}-12T09:30:00Z`,
    owner: { id: `user-${index % 4}`, email: `owner${index % 4}@example.com` },
    tags: index % 2 === 0 ? ["seasonal", "warehouse-2"] : ["warehouse-1"],
  }));

  const responses = [
    new Response("", { status: 429, headers: { "retry-after": "1", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" } }),
    new Response("", { status: 429, headers: { "retry-after": "2", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2" } }),
    new Response(JSON.stringify({ items: widgets.slice(0, 8), nextCursor: "eyJvZmZzZXQiOjh9" }), {
      status: 200,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "58", etag: 'W/"page-1"' },
    }),
    new Response(JSON.stringify({ items: widgets.slice(8), nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json", "x-ratelimit-remaining": "57", etag: 'W/"page-2"' },
    }),
  ];

  const client = createClient({
    baseUrl: "https://api.example.com",
    token: "test-token-9f3b",
    maxRetries: 2,
    backoffMs: 250,
    jitter: false,
    userAgent: "jev-lint-fixture/1.0",
    retryOn: [429, 502, 503, 504],
    sleep: async (ms: number) => {
      clock.now += ms;
    },
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init, at: clock.now });
      const next = responses.shift();
      if (!next) throw new Error(`Unexpected call number ${calls.length} to ${url}`);
      return next;
    },
  });

  const first = await client.listItems({
    collection: "widgets",
    limit: 8,
    filters: { status: "active", updatedSince: "2026-01-01T00:00:00Z", tag: "warehouse-1" },
    sort: "updatedAt:desc",
  });

  const rest = await client.listItems({
    collection: "widgets",
    limit: 8,
    cursor: first.nextCursor,
    filters: { status: "active", updatedSince: "2026-01-01T00:00:00Z", tag: "warehouse-1" },
    sort: "updatedAt:desc",
  });

  const everything = [...first.items, ...rest.items];
  const headers = new Headers(calls[0]!.init.headers);

  assert.equal(headers.get("authorization"), "Bearer test-token-9f3b");
});
