// When to delete an MCP session's Durable Object. Each Claude conversation
// opens its own session, and the agents library deletes a session's storage
// only when the client ends it with DELETE, which Claude's connector doesn't
// send. Without this, every conversation leaves an object behind for good.
//
// A session idle for SESSION_IDLE_MS is deleted. A request for it afterwards
// gets 404, and the MCP spec has the client open a new session.

export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

// Activity is written at most this often, so a busy session doesn't spend a
// storage write per request. Must stay well under SESSION_IDLE_MS.
export const SESSION_TOUCH_EVERY_MS = 60 * 60 * 1000;

export type ExpiryDecision = { expire: true } | { expire: false; checkInSeconds: number };

// A session with no recorded activity is expired: it never served a request.
export function sessionExpiry(lastActiveAt: number | undefined, now: number): ExpiryDecision {
  if (lastActiveAt === undefined) return { expire: true };
  const idle = now - lastActiveAt;
  if (idle >= SESSION_IDLE_MS) return { expire: true };
  return { expire: false, checkInSeconds: Math.ceil((SESSION_IDLE_MS - idle) / 1000) };
}

export function shouldTouch(lastTouchAt: number, now: number): boolean {
  return now - lastTouchAt >= SESSION_TOUCH_EVERY_MS;
}
