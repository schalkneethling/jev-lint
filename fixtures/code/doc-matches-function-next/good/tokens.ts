import { store } from "./store.ts";

/**
 * Splits a local token into its payload and optional footer.
 */
export function parseLocalToken(token: string): string[] {
  if (!token.startsWith("v4.local.")) throw new Error("Not a local token");
  return token.slice("v4.local.".length).split(".");
}

/**
 * Returns the sessions that have not expired yet.
 */
export function listSessions(): Session[] {
  return store.sessions.filter((session) => session.expiresAt > Date.now());
}

/** Formats a byte count with a binary unit, such as "1.5 MB". */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index++;
  }
  return `${bytes.toFixed(1)} ${units[index]}`;
}

/**
 * Keeps the newest entries so that the cache stays under its size limit.
 * Eviction is best effort: a failure leaves the cache larger than asked for, which is safe.
 */
export function trimCache(limit: number): void {
  store.cache.sort((a, b) => b.usedAt - a.usedAt);
  store.cache.length = Math.min(store.cache.length, limit);
}

// Sessions are written by one process only, so nothing here has to take a lock.
export function touchSession(session: Session): void {
  session.expiresAt = Date.now() + 60_000;
}

interface Session {
  expiresAt: number;
}
