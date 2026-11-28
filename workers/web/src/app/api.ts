// Fetches from the BFF's read-only proxy (/bff/api/*, workers/web/src/bff/api.ts).
//
// The proxy never refreshes; near expiry it answers 401
// session_refresh_needed. This wrapper then refreshes (shared with every other
// request waiting on it) and retries once. If the retry asks again, the server
// is refusing an access token the session still counts as valid, most likely
// a revoked grant, so it forces one rotation and retries once more. A third
// session_refresh_needed, or signed_out at any point, ends the session. It
// never loops beyond that.

import type { SessionClient } from "./session.ts";

/** GET /bff/api/<path>; `path` is the sync API path after /api/v1/, with its query. */
export type BffFetch = (path: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** The session ended; the signed-out flow has already run. */
export class SignedOutError extends Error {
  constructor() {
    super("signed out");
    this.name = "SignedOutError";
  }
}

async function errorOf(res: Response): Promise<string | null> {
  if (res.status !== 401) return null;
  const body = (await res.clone().json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : null;
}

export function createBffFetch(fetchFn: typeof fetch, session: SessionClient): BffFetch {
  return async (path, init) => {
    // force: false for the first refresh, true for the second.
    for (const force of [false, true, null]) {
      if (session.signedOut) throw new SignedOutError();
      const url = `/bff/api/${path}`;
      const res = await (init?.signal ? fetchFn(url, { signal: init.signal }) : fetchFn(url));
      // A response that lands after the page signed out (another request's
      // signed_out, or another tab's) must not repopulate the cleared mirror.
      if (session.signedOut) throw new SignedOutError();
      const error = await errorOf(res);
      if (error === "signed_out") break;
      if (error !== "session_refresh_needed") return res;
      if (force === null || !(await session.refreshOnce({ force }))) break;
    }
    session.markSignedOut();
    throw new SignedOutError();
  };
}
