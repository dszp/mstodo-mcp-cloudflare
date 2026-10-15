// "The owner must sign in to Microsoft again" — raised when a token refresh is
// refused for good (revoked grant, Conditional Access), or when Graph/EXO answer
// with a Conditional Access claims challenge. TodoIndex records it (see
// markReauthRequired); every tool then reports `reauth_required` until the next
// successful /authorize clears it. RPC flattens errors to their message, so
// callers on the far side of a DO stub match on REAUTH_REQUIRED instead.
export const REAUTH_REQUIRED = "reauth_required";

export class ReauthRequiredError extends Error {
  constructor(public readonly reason: string) {
    super(`${REAUTH_REQUIRED}: ${reason}`);
    this.name = "ReauthRequiredError";
  }
}

export function isReauthRequired(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith(REAUTH_REQUIRED);
}

export interface ReauthState {
  reason: string;
  // Decoded claims-challenge JSON to pass to Entra on the next sign-in, if the
  // trigger was a challenge rather than a refused refresh.
  claims?: string;
  at: number;
}

// Optional hook on both token providers (Graph and Substrate). The clients call
// it on a claims challenge instead of retrying: a plain refresh can't satisfy a
// Conditional Access requirement, so the retry would only fail again.
export interface ClaimsChallengeSink {
  reportClaimsChallenge?(claims: string): Promise<void>;
}

// A CAE / Conditional Access challenge is a 401 with
//   WWW-Authenticate: Bearer ..., error="insufficient_claims", claims="<base64 JSON>"
// Returns the decoded claims JSON, or null for an ordinary 401 (expired token),
// which the clients still handle with one refresh-and-retry.
export function parseClaimsChallenge(res: Response): string | null {
  if (res.status !== 401) return null;
  const header = res.headers.get("www-authenticate") ?? "";
  if (!/error="?insufficient_claims"?/i.test(header)) return null;
  const m = /claims="([^"]+)"/i.exec(header);
  if (!m) return null;
  try {
    const json = atob(m[1]);
    JSON.parse(json);
    return json;
  } catch {
    return null;
  }
}
