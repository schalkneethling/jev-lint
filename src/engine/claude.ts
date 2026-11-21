import { spawn } from "node:child_process";
import { VERDICTS_SCHEMA, type Reader } from "./verify.ts";

// Enough for a few dozen findings read with care; a run that takes longer has most likely stalled.
const TIMEOUT_MS = 15 * 60_000;

/**
 * A reader that runs Claude Code without a terminal (`claude --print`), once per prompt. It is the reader
 * the second stage was measured with: an agent that opens the file, and its siblings when it needs them.
 * It uses the sign-in Claude Code already has, so it needs no API key of its own.
 *
 * The linted project is untrusted input to this process, so it gets the three tools that read files and
 * nothing else: `--restricted` removes the tools that run code or fetch pages, ignores the project's own
 * settings files and confines reads to `cwd` and `dirs`; `--strict-mcp-config` loads no MCP servers.
 * Flags are those of `claude --help`, version 2.1.
 */
export function createClaudeReader(options: { model: string; cwd: string; dirs?: string[] }): Reader {
  const args = [
    "--print",
    "--model", options.model,
    "--output-format", "json",
    "--json-schema", JSON.stringify(VERDICTS_SCHEMA),
    "--tools", "Read,Grep,Glob",
    "--allowedTools", "Read,Grep,Glob",
    "--restricted",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    ...(options.dirs ?? []).flatMap((dir) => ["--add-dir", dir]),
  ];

  return (prompt) =>
    new Promise((settle, fail) => {
      const child = spawn("claude", args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], timeout: TIMEOUT_MS });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error: NodeJS.ErrnoException) =>
        fail(error.code === "ENOENT" ? new Error("--verify runs Claude Code, and no `claude` command was found on the PATH.") : error),
      );
      child.on("close", (code, signal) => {
        if (signal) return fail(new Error(`claude was stopped by ${signal} (the limit is ${TIMEOUT_MS / 60_000} minutes per batch).`));
        let result: { is_error?: boolean; result?: string; structured_output?: unknown; total_cost_usd?: number };
        try {
          result = JSON.parse(stdout);
        } catch {
          return fail(new Error(`claude exited with status ${code} and no JSON result: ${(stderr || stdout).trim().slice(0, 300)}`));
        }
        if (result.is_error || result.structured_output === undefined) return fail(new Error(`claude gave no verdicts: ${String(result.result).slice(0, 300)}`));
        settle({ output: result.structured_output, ...(result.total_cost_usd !== undefined && { costUsd: result.total_cost_usd }) });
      });
      // The prompt goes in on standard input: `--tools` and `--add-dir` take lists, and would swallow a trailing argument.
      child.stdin.end(prompt);
    });
}
