import { OWNER_DO_NAME } from "../cache/sql";
import type { Props } from "../types";

// A grant's total life, however often it is refreshed.
export const MAX_GRANT_AGE_MS = 90 * 86_400_000;

export type GrantRefusal = "grant_revoked" | "grant_expired" | "reauth_required";

// The single check both the token endpoint (on refresh) and the tool layer (on
// every call) apply to a grant. Grants issued before the epoch existed carry no
// `epoch` and are refused: there's no way to tell an owner's grant from one a
// confused-deputy attack obtained, so every client re-authorizes once.
export async function grantRefusal(env: Env, props: Partial<Props> | undefined): Promise<GrantRefusal | null> {
  const index = env.TODO_INDEX_DO.get(env.TODO_INDEX_DO.idFromName(OWNER_DO_NAME));
  const { epoch, reauth } = await index.authState();
  if (!props?.epoch || props.epoch !== epoch) return "grant_revoked";
  if (typeof props.authorized_at !== "number" || Date.now() - props.authorized_at > MAX_GRANT_AGE_MS) {
    return "grant_expired";
  }
  if (reauth) return "reauth_required";
  return null;
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
