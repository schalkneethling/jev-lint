import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHtml } from "../src/html/parse.ts";
import altTextQuality from "../src/rules/html/alt-text-quality.ts";
import labelInputType from "../src/rules/html/label-input-type.ts";

const select = (rule: typeof altTextQuality, html: string) => rule.select(parseHtml("t.html", html));

test("alt-text-quality skips missing and empty alt, and picks up the figure caption", () => {
  const candidates = select(
    altTextQuality,
    `<img src="a.png"><img src="b.png" alt=""><figure><img src="/img/c.png?v=2" alt="A cat"><figcaption>Our cat</figcaption></figure>`,
  );
  assert.deepEqual(candidates.map((c) => c.data), [{ alt: "A cat", image_file_name: "c.png", caption_shown_with_image: "Our cat" }]);
});

test("label-input-type resolves for=, wrapping labels and aria-label, and hides the type from the model", () => {
  const candidates = select(
    labelInputType,
    `<label for="e">Email</label><input id="e" type="text">
     <label>Website <input name="site"></label>
     <input type="email" aria-label="Search">
     <input type="checkbox" aria-label="Agree">`,
  );
  assert.deepEqual(candidates.map((c) => [c.data.label, c.meta!.type]), [["Email", "text"], ["Website", "text"], ["Search", "email"]]);
  assert.ok(candidates.every((c) => !("type" in c.data)));
});

test("aria-label-justified sorts labels by how they relate to the visible text, and asks one question per case", async () => {
  const { default: ariaLabelJustified } = await import("../src/rules/html/aria-label-justified.ts");
  const candidates = select(
    ariaLabelJustified,
    `<a href="/1" aria-label="Read more about cats">Read more</a><a href="/2">Read more</a>
     <button aria-label="Close">Submit order</button>
     <button aria-label="Save">save</button>
     <a href="/nimbus" aria-label="Nimbus">Nimbus Serverless relational database</a>
     <button aria-label="Close dialog">×</button>`,
  );
  assert.deepEqual(candidates.map((c) => [c.data.visible_text, c.meta!.relation, c.decided?.p]), [
    ["Read more", "label_extends_text", undefined],
    ["Submit order", "unrelated_wording", undefined],
    ["save", "same", 0.45],
  ]);
  const asked = candidates.map((c) => Object.keys(ariaLabelJustified.questions((field: string) => field, c)).filter((name) => ariaLabelJustified.questions((field: string) => field, c)[name]));
  assert.deepEqual(asked, [["adds_only_filler"], ["same_purpose"], []]);
});

test("link-text-purpose reports a name shared by several destinations once, with the destinations as facts", async () => {
  const { default: linkTextPurpose } = await import("../src/rules/html/link-text-purpose.ts");
  const candidates = select(
    linkTextPurpose,
    `<div><a href="/a" aria-label="Card link"></a><h3>Adapters</h3></div>
     <div><a href="/b" aria-label="Card link"></a><h3>RPC</h3></div>
     <a href="/">Home</a><a href="/">Home</a>`,
  );
  assert.deepEqual(candidates.map((c) => [c.data.link_text, c.meta!.destinations_sharing_this_text]), [["Card link", "2"], ["Home", "1"], ["Home", "1"]]);
  assert.equal(candidates[0]!.meta!.destinations, "/a /b");
  assert.equal(candidates[0]!.meta!.text_of_containing_element, "Adapters");
});

test("aria-hidden-hides-content skips text that is exposed nearby, referenced, or inside a labelled control", async () => {
  const { default: rule } = await import("../src/rules/html/aria-hidden-hides-content.ts");
  const candidates = select(
    rule,
    `<p><span aria-hidden="true">£240</span><span class="visually-hidden">£240</span></p>
     <button aria-label="Close dialog"><span aria-hidden="true">Close ×</span></button>
     <button aria-labelledby="tip">x</button><div id="tip" aria-hidden="true">Dismiss alert</div>
     <div aria-hidden="true"><span aria-hidden="true">Only 2 left in stock</span></div>
     <svg aria-hidden="true"></svg>`,
  );
  assert.deepEqual(candidates.map((c) => c.data.hidden_text), ["Only 2 left in stock"]);
});

test("alert-is-urgent skips empty live regions and unrendered template slots", async () => {
  const { default: rule } = await import("../src/rules/html/alert-is-urgent.ts");
  const candidates = select(
    rule,
    `<div role="alert"></div><div role="alert">{{ message }}</div>
     <div role="status">Saved your draft</div><p aria-live="assertive">Connection lost</p>`,
  );
  assert.deepEqual(candidates.map((c) => [c.data.message, c.meta!.announced_by]), [["Connection lost", 'aria-live="assertive"']]);
});

test("describedby-describes joins every resolvable target and ignores ids that resolve to nothing", async () => {
  const { default: rule } = await import("../src/rules/html/describedby-describes.ts");
  const candidates = select(
    rule,
    `<label for="e">Email</label><input id="e" aria-describedby="help missing error">
     <p id="help">Used for your receipt.</p><p id="error">Enter a valid email.</p>
     <input aria-label="Search" aria-describedby="missing">`,
  );
  assert.deepEqual(candidates.map((c) => c.data), [{ field_label: "Email", description_announced_after_label: "Used for your receipt. Enter a valid email." }]);
});

test("autocomplete-matches-label reads the purpose token, keeps it from the model, and leaves 'off' alone", async () => {
  const { default: rule } = await import("../src/rules/html/autocomplete-matches-label.ts");
  const candidates = select(
    rule,
    `<label for="a">Postcode</label><input id="a" autocomplete="shipping postal-code">
     <label for="b">Email</label><input id="b" type="email">
     <label for="c">Recipient email</label><input id="c" autocomplete="off">
     <label for="d">Agree</label><input id="d" type="checkbox">`,
  );
  assert.deepEqual(candidates.map((c) => [c.data.label, c.meta!.autocomplete]), [["Postcode", "postal-code"], ["Email", ""]]);
  assert.ok(candidates.every((c) => !("autocomplete" in c.data)));
});

test("description-matches-page judges article pages only, one candidate each, and none for an empty description", async () => {
  const { default: rule } = await import("../src/rules/html/description-matches-page.ts");
  const body = `<main><article><h1>Pricing</h1><p>${Array.from({ length: 20 }, () => "word").join(" ")}</p></article></main>`;
  const page = (description: string) => `<title>Pricing | Acme</title><meta name="description" content="${description}">${body}`;
  assert.deepEqual(select(rule, page("")).length, 0);
  // A home page: no <article>, no og:type of article.
  assert.deepEqual(select(rule, page("See what each plan includes.").replace(/<\/?article>/g, "")).length, 0);
  const [candidate] = select(rule, page("See what each plan includes."));
  assert.deepEqual([candidate!.data.meta_description, candidate!.data.page_title, candidate!.data.main_heading], ["See what each plan includes.", "Pricing | Acme", "Pricing"]);
});

test("an element inside an accessibility overlay is still a candidate, marked as a third-party widget", async () => {
  const { default: rule } = await import("../src/rules/html/alert-is-urgent.ts");
  const candidates = rule.select(
    parseHtml("t.html", `<div class="uwaw-features"><span aria-live="assertive">Bigger Text</span></div><p role="alert">Payment failed</p>`),
  );
  assert.deepEqual(candidates.map((c) => c.loc.widget), ["accessibility overlay", undefined]);
});

test("link-text-purpose leaves a phone number on a tel: link and an address on a mailto: link alone", async () => {
  const { default: rule } = await import("../src/rules/html/link-text-purpose.ts");
  const candidates = rule.select(
    parseHtml("t.html", `<a href="tel:+18005550100">(800) 555-0100</a><a href="mailto:hi@example.org">hi@example.org</a><a href="tel:+18005550100">click here</a>`),
  );
  assert.deepEqual(candidates.map((c) => c.data.link_text), ["click here"]);
});

test("aria-label-justified ignores a link whose only visible text is an image's alt", async () => {
  const { default: rule } = await import("../src/rules/html/aria-label-justified.ts");
  const candidates = rule.select(
    parseHtml("t.html", `<a href="/a" aria-label="Eight ideas"><img src="a.jpg" alt="A building"></a><a href="/b" aria-label="Close">Open</a>`),
  );
  assert.deepEqual(candidates.map((c) => c.data.visible_text), ["Open"]);
});

test("describedby-describes decides in code that a description repeating the label is a defect", async () => {
  const { default: rule } = await import("../src/rules/html/describedby-describes.ts");
  const [repeat, help] = rule.select(
    parseHtml(
      "t.html",
      `<label for="l">Last *</label><input id="l" aria-describedby="d1"><span id="d1">Last</span>
       <label for="e">Email</label><input id="e" aria-describedby="d2"><span id="d2">We only use it for receipts.</span>`,
    ),
  );
  assert.equal(repeat!.decided?.p, 0.7);
  assert.equal(help!.decided, undefined);
});

test("autocomplete-matches-label skips search boxes and fields nobody can type into", async () => {
  const { default: rule } = await import("../src/rules/html/autocomplete-matches-label.ts");
  const candidates = rule.select(
    parseHtml(
      "t.html",
      `<label>Find <input name="keys" id="headerSearch"></label><label>Total <input name="total" disabled></label><label>City <input name="city"></label>`,
    ),
  );
  assert.deepEqual(candidates.map((c) => c.data.label), ["City"]);
});
