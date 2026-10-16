import { ownerIndex } from "../core/owner-index";
import { log } from "../log";
import type { Props } from "../types";
import type { AppEnv } from "../core/ports";

// A grant's total life, however often it is refreshed.
export const MAX_GRANT_AGE_MS = 90 * 86_400_000;

export type GrantRefusal = "grant_revoked" | "grant_expired" | "reauth_required";

// The single check both the token endpoint (on refresh) and the tool layer (on
// every call) apply to a grant. Grants issued before the epoch existed carry no
// `epoch` and are refused: there's no way to tell an owner's grant from one a
// confused-deputy attack obtained, so every client re-authorizes once.
//
// Callers must pass the props of the token on THIS request. McpAgent's
// this.props is the props of the token that first started the session and is
// never refreshed afterwards, so it can't be used here — the HTTP layer
// (auth/oauth.ts apiHandler) runs this check with ctx.props instead.
export async function grantRefusal(env: AppEnv, props: Partial<Props> | undefined): Promise<GrantRefusal | null> {
  const { epoch, reauth } = await ownerIndex(env).authState();
  if (!props?.epoch || props.epoch !== epoch) return "grant_revoked";
  if (typeof props.authorized_at !== "number" || Date.now() - props.authorized_at > MAX_GRANT_AGE_MS) {
    return "grant_expired";
  }
  if (reauth) return "reauth_required";
  return null;
}

// The HTTP-layer gate for /mcp: null to let the request through, or the 401
// invalid_token response for a refused grant (see the apiHandler in oauth.ts).
export async function refuseMcpRequest(env: AppEnv, props: Partial<Props> | undefined): Promise<Response | null> {
  const refusal = await grantRefusal(env, props);
  if (!refusal) return null;
  log.warn("mcp_request_refused", { reason: refusal });
  const description = refusalDescription(refusal);
  return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer error="invalid_token", error_description="${description}"`,
    },
  });
}

// The part of the gate that doesn't depend on which grant is calling: has
// Microsoft refused our refresh token or demanded a Conditional Access sign-in?
export async function reauthPending(env: AppEnv): Promise<boolean> {
  return (await ownerIndex(env).authState()).reauth !== null;
}

export function refusalDescription(refusal: GrantRefusal): string {
  switch (refusal) {
    case "grant_revoked":
      return "This connection was revoked. Reconnect the MCP server to sign in again.";
    case "grant_expired":
      return "This connection is older than the maximum allowed age. Reconnect the MCP server to sign in again.";
    case "reauth_required":
      return "Microsoft needs you to sign in again. Reconnect the MCP server.";
  }
}
