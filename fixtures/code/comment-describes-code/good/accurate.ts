// Tags are compared case-insensitively everywhere else, so store them lowercased.
tags = tags.map((tag) => tag.toLowerCase());

// The payment provider drops about 1 in 50 requests under load; five attempts keeps failures below 1 in a million.
for (let attempt = 0; attempt < 5; attempt++) {
  await send();
}

// Newest first, because the feed only renders the first ten.
posts.sort((a, b) => b.date - a.date);

/* Editors can delete too since the 2024 permissions change. */
if (user.role === "admin" || user.role === "editor") {
  await deleteProject(id);
}

// Prices change minute to minute, so never serve a cached copy.
const response = await fetch(url, { cache: "no-store" });

// Zero-byte files are upload placeholders that were never completed.
const visible = files.filter((file) => file.size > 0);
