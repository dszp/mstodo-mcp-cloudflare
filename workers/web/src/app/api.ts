// Fetches from the BFF's proxy (/bff/api/*, workers/web/src/bff/api.ts): GETs,
// and the one write, POST sync/mutations.
//
// The proxy never refreshes; near expiry it answers 401
// session_refresh_needed. This wrapper then refreshes (shared with every other
// request waiting on it) and retries once. If the retry asks again, the server
// is refusing an access token the session still counts as valid, most likely
// a revoked grant, so it forces one rotation and retries once more. A third
// session_refresh_needed, or signed_out at any point, ends the session. It
// never loops beyond that. On a page nobody has used since it last reached
// the BFF, the refresh throws SessionIdleError (session.ts) before any
// request; it passes through as an ordinary error, not a sign-out, so a poll
// can't keep the BFF's session alive on its own.

import type { SessionClient } from "./session.ts";

/**
 * GET /bff/api/<path>, or POST with a JSON `body`; `path` is the sync API path
 * after /api/v1/, with its query. A POST carries X-Potem: 1, which the BFF
 * requires on every state-changing route; the browser adds Origin itself.
 */
export type BffFetch = (
  path: string,
  init?: { signal?: AbortSignal; method?: "POST"; body?: string },
) => Promise<Response>;

const POST_HEADERS = { "x-potem": "1", "content-type": "application/json" };

function requestInit(init: Parameters<BffFetch>[1]): RequestInit | undefined {
  const out: RequestInit = {};
  if (init?.signal) out.signal = init.signal;
  if (init?.method === "POST") {
    out.method = "POST";
    out.headers = POST_HEADERS;
    if (init.body !== undefined) out.body = init.body;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

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
      // A POST retried after a refresh is sent again unchanged: the BFF
      // answered 401 before forwarding it, and its mutation ids make a resend
      // safe anyway (SYNC-API §5.4).
      const reqInit = requestInit(init);
      const res = await (reqInit ? fetchFn(url, reqInit) : fetchFn(url));
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

/** How long any one request to the BFF may take, answer and body included. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * `fetchFn` with every request aborted after `ms` (a TimeoutError), on top of
 * any signal the caller passed. main.tsx wraps the page's one fetch with it,
 * so it covers bffFetch and the session's own requests: GET /bff/session and
 * the refresh run under the cross-tab lock, and a request that never answers
 * would hold that lock, and every other tab's refresh, forever. The timer
 * also covers reading the body, so callers read it at once (they do).
 */
export function withTimeout(
  fetchFn: typeof fetch,
  ms = REQUEST_TIMEOUT_MS,
  timeoutSignal: (ms: number) => AbortSignal = (n) => AbortSignal.timeout(n),
): typeof fetch {
  return (input, init) => {
    const timeout = timeoutSignal(ms);
    const signal = init?.signal ? anySignal([init.signal, timeout]) : timeout;
    return fetchFn(input, { ...init, signal });
  };
}

/**
 * A signal that aborts when any of `signals` does, with that signal's reason.
 * AbortSignal.any where the browser has it; Safari added it only in 17.4, so
 * older browsers get a controller the signals abort.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const native = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === "function") return native.call(AbortSignal, signals);
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctl.abort(s.reason), { once: true, signal: ctl.signal });
  }
  return ctl.signal;
}
