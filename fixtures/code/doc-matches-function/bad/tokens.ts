import { store } from "./store.ts";

/**
 * Splits a public token into its header, payload and signature.
 */
export function parseLocalToken(token: string): string[] {
  if (!token.startsWith("v4.local.")) throw new Error("Not a local token");
  return token.slice("v4.local.".length).split(".");
}

/**
 * Returns every session, including the ones that have expired.
 */
export function listSessions(): Session[] {
  return store.sessions.filter((session) => session.expiresAt > Date.now());
}

/** Converts a duration in seconds to a string such as "1h 5m". */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index++;
  }
  return `${bytes.toFixed(1)} ${units[index]}`;
}

interface Session {
  expiresAt: number;
}
