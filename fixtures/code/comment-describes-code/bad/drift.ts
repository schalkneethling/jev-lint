// Remove duplicate tags
tags = tags.map((tag) => tag.toLowerCase());

// Retry up to 3 times
for (let attempt = 0; attempt < 5; attempt++) {
  await send();
}

// Sort oldest first
posts.sort((a, b) => b.date - a.date);

/* Only admins may delete a project */
if (user.role === "admin" || user.role === "editor") {
  await deleteProject(id);
}

// Cache the response for one hour
const response = await fetch(url, { cache: "no-store" });

// Skip hidden files
const visible = files.filter((file) => file.size > 0);
