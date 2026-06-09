/**
 * M — lightweight in-memory presence.
 *
 * Every authenticated API request stamps the caller's "last seen" time
 * (via the requireUser middleware), and the admin shell sends a cheap
 * heartbeat every ~45s so a logged-in user stays "online" even on pages
 * that don't otherwise poll. A user is online if seen within
 * ONLINE_WINDOW_MS.
 *
 * Deliberately in-memory: no schema, no storage, fine for a single
 * server instance. On restart the map is empty and everyone simply
 * re-appears online on their next request/heartbeat. If the server is
 * ever scaled horizontally this should move to a shared store (Redis).
 */

const lastSeen = new Map<string, number>();

// Heartbeat is ~45s; allow two missed beats before going offline.
const ONLINE_WINDOW_MS = 100_000;

export function touchPresence(userId: string): void {
  if (!userId) return;
  lastSeen.set(userId, Date.now());
}

export function isOnline(userId: string): boolean {
  const t = lastSeen.get(userId);
  return t !== undefined && Date.now() - t < ONLINE_WINDOW_MS;
}
