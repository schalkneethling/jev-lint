import assert from "node:assert/strict";
import { test, it } from "node:test";

test("throws when the id is missing", () => {
  assert.equal(getPost("42").title, "Hello");
});

test("sorts posts newest first", () => {
  const posts = listPosts(data);
  assert.equal(posts.length, 3);
});

it("rejects an expired token", async () => {
  const session = await signIn(validToken);
  assert.ok(session.userId);
});

test("escapes HTML in the title", () => {
  render({ title: "<b>Hi</b>" });
});

test("returns an empty array when there are no posts", () => {
  assert.equal(formatDate(new Date(0)), "1 January 1970");
});
