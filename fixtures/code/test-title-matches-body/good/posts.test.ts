import assert from "node:assert/strict";
import { test, it } from "node:test";

test("throws when the id is missing", () => {
  assert.throws(() => getPost(undefined), /id is required/);
});

test("sorts posts newest first", () => {
  const posts = listPosts(data);
  assert.deepEqual(posts.map((post) => post.date), ["2024-03-01", "2024-02-01", "2024-01-01"]);
});

it("rejects an expired token", async () => {
  await assert.rejects(signIn(expiredToken), /token expired/);
});

test("escapes HTML in the title", () => {
  const html = render({ title: "<b>Hi</b>" });
  assert.match(html, /&lt;b&gt;Hi&lt;\/b&gt;/);
});

test("returns an empty array when there are no posts", () => {
  assert.deepEqual(listPosts([]), []);
});
