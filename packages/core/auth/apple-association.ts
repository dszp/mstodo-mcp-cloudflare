// /.well-known/apple-app-site-association for the app's https sign-in callback
// (docs/SYNC-API.md section 8). ASWebAuthenticationSession accepts an https
// callback only on a host associated with the app through the `webcredentials`
// service, so that is the one service served.
//
// Off unless APPLE_TEAM_ID and APPLE_BUNDLE_IDS are both set and well formed;
// off, the path is a 404 as before. Served directly with application/json and
// no redirect, which Apple's fetcher requires.
import { log } from "../log";
import type { AppEnv } from "../ports";

export const APPLE_ASSOCIATION_PATH = "/.well-known/apple-app-site-association";

const TEAM_RE = /^[A-Z0-9]{10}$/;
const BUNDLE_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

// "TEAMID.bundle.id" for each configured bundle ID, or null when off or invalid.
export function appleAppIds(env: Pick<AppEnv, "APPLE_TEAM_ID" | "APPLE_BUNDLE_IDS">): string[] | null {
  const team = (env.APPLE_TEAM_ID ?? "").trim();
  const bundles = (env.APPLE_BUNDLE_IDS ?? "").split(",").map((b) => b.trim()).filter(Boolean);
  if (!team && !bundles.length) return null;
  if (!TEAM_RE.test(team) || !bundles.length || !bundles.every((b) => BUNDLE_RE.test(b))) {
    log.warn("apple_association_misconfigured", {});
    return null;
  }
  return bundles.map((b) => `${team}.${b}`);
}

// Null for any other path, or when the feature is off.
export function handleAppleAssociation(req: Request, env: AppEnv): Response | null {
  if (new URL(req.url).pathname !== APPLE_ASSOCIATION_PATH) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const apps = appleAppIds(env);
  if (!apps) return null;
  const body = JSON.stringify({ webcredentials: { apps } });
  return new Response(req.method === "HEAD" ? null : body, {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
  });
}
