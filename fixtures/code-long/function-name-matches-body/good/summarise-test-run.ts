// Mirrors the shape of the bad cases: long, branchy, with logging and error handling, and it only
// summarises. Nothing is written, sent, deleted, or navigated to.

interface TestResult {
  file: string;
  title: string;
  status: "passed" | "failed" | "skipped" | "timedOut";
  durationMs: number;
  retries: number;
  error?: { message: string; stack?: string };
  annotations?: { type: string; description?: string }[];
}

export function summariseTestRun(results: TestResult[], options: { slowMs: number; flakyRetries: number }) {
  const byFile = new Map<string, TestResult[]>();
  for (const result of results) {
    byFile.set(result.file, [...(byFile.get(result.file) ?? []), result]);
  }

  const counts = { passed: 0, failed: 0, skipped: 0, timedOut: 0 };
  let totalMs = 0;
  const slow: { title: string; file: string; durationMs: number }[] = [];
  const flaky: { title: string; file: string; retries: number }[] = [];
  const failures: { title: string; file: string; message: string; firstStackLine?: string }[] = [];

  for (const result of results) {
    counts[result.status] += 1;
    totalMs += result.durationMs;

    if (result.durationMs >= options.slowMs && result.status !== "skipped") {
      slow.push({ title: result.title, file: result.file, durationMs: result.durationMs });
    }
    if (result.status === "passed" && result.retries >= options.flakyRetries) {
      flaky.push({ title: result.title, file: result.file, retries: result.retries });
    }
    if (result.status === "failed" || result.status === "timedOut") {
      const message = result.error?.message.split("\n")[0] ?? (result.status === "timedOut" ? "Timed out" : "Failed without a message");
      const firstStackLine = result.error?.stack
        ?.split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("at ") && !line.includes("node_modules"));
      failures.push({ title: result.title, file: result.file, message, firstStackLine });
    }
  }

  slow.sort((a, b) => b.durationMs - a.durationMs);
  failures.sort((a, b) => a.file.localeCompare(b.file) || a.title.localeCompare(b.title));

  const files = [...byFile.entries()]
    .map(([file, own]) => ({
      file,
      total: own.length,
      failed: own.filter((result) => result.status === "failed" || result.status === "timedOut").length,
      skipped: own.filter((result) => result.status === "skipped").length,
      durationMs: own.reduce((sum, result) => sum + result.durationMs, 0),
    }))
    .sort((a, b) => b.failed - a.failed || b.durationMs - a.durationMs);

  // A run where every test was skipped reads as green in a summary, which is how a broken filter
  // stays unnoticed for a week. Say it plainly instead.
  const everythingSkipped = results.length > 0 && counts.skipped === results.length;
  const ran = counts.passed + counts.failed + counts.timedOut;
  const headline = everythingSkipped
    ? `No tests ran: all ${counts.skipped} were skipped.`
    : `${counts.passed}/${ran} passed in ${(totalMs / 1000).toFixed(1)}s` +
      (counts.failed + counts.timedOut > 0 ? `, ${counts.failed + counts.timedOut} failed` : "") +
      (counts.skipped > 0 ? `, ${counts.skipped} skipped` : "");

  const owed = results.flatMap((result) => (result.annotations ?? []).filter((note) => note.type === "fixme").map((note) => `${result.title}: ${note.description ?? "fixme"}`));

  return {
    headline,
    counts,
    totalMs,
    files,
    failures,
    flaky,
    slowest: slow.slice(0, 10),
    fixmes: owed,
    green: counts.failed === 0 && counts.timedOut === 0 && !everythingSkipped,
  };
}
