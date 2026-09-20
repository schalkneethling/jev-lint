try {
  localStorage.setItem("theme", theme);
} catch {
  // Private browsing blocks storage. The theme still applies for this visit, which is all we need.
}

try {
  navigator.vibrate(50);
} catch {
  // Haptics are a progressive enhancement; devices without them lose nothing.
}

try {
  cached = JSON.parse(sessionStorage.getItem("results") ?? "");
} catch {
  // A missing or corrupt cache entry means we fetch fresh results below, which is the normal path anyway.
}

try {
  await fs.unlink(tempFile);
} catch {
  // The file may already be gone if the upload was cancelled; cleanup is best effort and the OS clears the temp dir.
}
