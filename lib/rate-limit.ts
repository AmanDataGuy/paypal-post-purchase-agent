/**
 * # rate-limit.ts - fixed-window request limits for public endpoints (LLM spend, MCP sessions, console sign-in)
 *
 * - shortcut: counters live in process memory (one Render instance); move to Postgres if we ever run several.
 */
const windows = new Map<string, { count: number; resetAt: number }>();

// True if `key` may make another request within `limit` per `windowMs`.
export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const w = windows.get(key);
  if (!w || now >= w.resetAt) {
    if (windows.size > 50_000) for (const [k, v] of windows) if (now >= v.resetAt) windows.delete(k);
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  return ++w.count <= limit;
}

// Client IP as seen by our proxy (Render appends the real client address last; earlier entries can be forged).
export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "local";
}
