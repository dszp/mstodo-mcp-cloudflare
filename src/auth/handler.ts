import {
  AuthorizationError,
  authorizationErrorRedirect,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import { readBounded } from "../util/body";
import { log } from "../log";
import { OWNER_DO_NAME } from "../cache/sql";
import { consentRememberSecret } from "./crypto";
import { consentPage, errorPage } from "./consent-page";
import {
  buildAnchorMailbox,
  buildAuthorizeUrl,
  computeCodeChallenge,
  decodeJwtClaims,
  exchangeCode,
  fetchMe,
  generateCodeVerifier,
  isOwner,
  loadIdentity,
  storeIdentity,
  storeTokens,
  tokensFromResponse,
  wipeIdentityScopedState,
  TokenExchangeError,
} from "./microsoft";

// The authorization flow, in three requests:
//
//   GET  /authorize                — validate the MCP client's request and show
//                                    the per-client consent page (skipped when
//                                    this browser approved this client before).
//   POST /authorize                — the owner approved: only now start the
//                                    Microsoft sign-in.
//   GET  /auth/microsoft/callback  — exchange Microsoft's code, apply the
//                                    OWNER_EMAIL gate, issue the MCP grant.
//
// Consent before the upstream redirect is the MCP confused-deputy mitigation:
// dynamic registration lets anyone register a client, and Microsoft sign-in is
// often silent, so without this page one click on a crafted /authorize link
// would hand a full grant to whatever redirect URI the registrant chose. The
// library's consent/upstream helpers bind each step to this browser with a
// __Host- cookie and keep the authorization request server-side, so neither the
// form nor Microsoft's `state` can be replayed from elsewhere.

const AUTHORIZE_PATH = "/authorize";
const CALLBACK_PATH = "/auth/microsoft/callback";
// The consent form is a handle, a decision and a checkbox.
const MAX_CONSENT_FORM_BYTES = 8 * 1024;

interface UpstreamData {
  verifier: string;
}

function callbackUrlFor(req: Request): string {
  return `${new URL(req.url).origin}${CALLBACK_PATH}`;
}

function ownerIndex(env: Env) {
  return env.TODO_INDEX_DO.get(env.TODO_INDEX_DO.idFromName(OWNER_DO_NAME));
}

// Remembered consent is per browser; the subject is fixed because this server
// has exactly one user, and the owner isn't known until after Microsoft sign-in.
async function rememberOptions(env: Env) {
  return { secret: await consentRememberSecret(env), subject: "owner" };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === AUTHORIZE_PATH && req.method === "GET") {
        return await handleAuthorize(req, env);
      }
      if (url.pathname === AUTHORIZE_PATH && req.method === "POST") {
        return await handleConsentDecision(req, env);
      }
      if (url.pathname === CALLBACK_PATH && req.method === "GET") {
        return await handleCallback(req, env, url);
      }
    } catch (e) {
      // AuthorizationError with redirectTo: the client and its redirect URI were
      // validated, so the error can go back to the client. Without it, the
      // request isn't trusted enough to redirect anywhere: render it here.
      if (e instanceof AuthorizationError) {
        log.warn("authorize_error", { code: e.code, description: e.description });
        if (e.redirectTo) return Response.redirect(e.redirectTo, 302);
        return errorPage(
          "Sign-in couldn't continue",
          `${e.description} Start connecting again from your MCP client.`,
          400,
        );
      }
      throw e;
    }

    log.debug("auth_path_unknown", { method: req.method, path: url.pathname });
    return new Response("not found", { status: 404 });
  },
};

async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(req);

  if (await oauth.isConsentRemembered(req, authRequest, await rememberOptions(env))) {
    log.info("consent_remembered", { client_id: authRequest.clientId });
    return startMicrosoftSignIn(req, env, authRequest, new Headers());
  }

  // describeConsent first: a failed client lookup then leaves nothing in KV.
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("content-type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function handleConsentDecision(req: Request, env: Env): Promise<Response> {
  const body = await readBounded(req, MAX_CONSENT_FORM_BYTES);
  if (body === null) {
    return errorPage("Request too large", "The consent form submission was too large.", 413);
  }
  const form = new URLSearchParams(body);
  const handle = String(form.get("handle") ?? "");
  const oauth = env.OAUTH_PROVIDER;

  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(req, handle);
    log.info("consent_denied", { client_id: denied.request.clientId });
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const approved = await oauth.approveConsent(
    req,
    handle,
    form.get("remember") === "1" ? { remember: await rememberOptions(env) } : {},
  );
  log.info("consent_approved", { client_id: approved.request.clientId });
  return startMicrosoftSignIn(req, env, approved.request, approved.headers);
}

async function startMicrosoftSignIn(
  req: Request,
  env: Env,
  authRequest: AuthRequest,
  headers: Headers,
): Promise<Response> {
  const verifier = generateCodeVerifier();
  const upstream = await env.OAUTH_PROVIDER.beginUpstream(authRequest, {
    data: { verifier } satisfies UpstreamData,
    headers,
  });
  // A pending Conditional Access claims challenge has to ride on the next
  // Microsoft sign-in, or Entra issues tokens that fail the same way.
  const { reauth } = await ownerIndex(env).authState();
  const authorizeUrl = buildAuthorizeUrl(env, {
    redirectUri: callbackUrlFor(req),
    state: upstream.state,
    codeChallenge: await computeCodeChallenge(verifier),
    claims: reauth?.claims,
  });
  upstream.headers.set("location", authorizeUrl);
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function handleCallback(req: Request, env: Env, url: URL): Promise<Response> {
  // Recover the approved MCP request and our PKCE verifier. Refused unless this
  // browser holds the binding cookie set when the sign-in started (one use).
  const { request: authRequest, data, headers } =
    await env.OAUTH_PROVIDER.finishUpstream<UpstreamData>(req);

  // Microsoft refused or the owner cancelled there. The upstream record is
  // already consumed, so answer the MCP client now (access_denied, with its
  // state and iss) instead of leaving its authorization hanging.
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const desc = url.searchParams.get("error_description") ?? "";
    log.warn("oauth_callback_error", { error: oauthError, description: desc.slice(0, 200) });
    headers.set("location", authorizationErrorRedirect(authRequest, "access_denied"));
    return new Response(null, { status: 302, headers });
  }
  const code = url.searchParams.get("code");
  if (!code) {
    log.warn("oauth_callback_missing_code", {});
    return errorPage("Invalid callback", "Microsoft didn't return an authorization code.", 400);
  }

  let token;
  try {
    token = await exchangeCode(env, {
      code,
      codeVerifier: data.verifier,
      redirectUri: callbackUrlFor(req),
    });
  } catch (e) {
    if (e instanceof TokenExchangeError) {
      log.warn("code_exchange_failed", { reason: e.reason });
      return errorPage("Token exchange failed", e.reason, 502);
    }
    throw e;
  }

  // OWNER_EMAIL gate — runs AFTER code exchange (we need an access_token to
  // hit /me) but BEFORE storeTokens / completeAuthorization. A non-owner that
  // consented at Microsoft must not leave any persistent state in the Worker
  // and must not receive an MCP grant.
  let me;
  try {
    me = await fetchMe(token.access_token);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn("me_fetch_failed", { message });
    return errorPage("Identity probe failed", "Could not contact Microsoft Graph.", 502);
  }
  if (!isOwner(env, me)) {
    // Log only the domain: the full address belongs to someone who isn't the
    // owner and has no reason to be in this Worker's logs.
    const attempted = me.mail ?? me.userPrincipalName ?? "";
    log.warn("owner_gate_rejected", { attempted_domain: attempted.split("@")[1] ?? null });
    return errorPage(
      "Not authorized",
      `This MCP server is configured for a single owner. You signed in as ${me.userPrincipalName}.`,
      403,
    );
  }

  // Identity-change auto-wipe: if the underlying Microsoft account differs
  // from the previously seen one, the per-identity cache is from a different
  // person's data. Wipe before storing the new tokens so two accounts' state
  // never mixes. The wipe also bumps the auth epoch, which revokes every MCP
  // grant paired with the previous account.
  const index = ownerIndex(env);
  const prevIdentity = await loadIdentity(env);
  const identityChanged = prevIdentity !== null && prevIdentity.id !== me.id;
  if (identityChanged) {
    log.warn("identity_change_wipe", { prev_id: prevIdentity.id, new_id: me.id });
    await wipeIdentityScopedState(env);
  }

  const now = Date.now();
  await storeTokens(env, tokensFromResponse(token, token.refresh_token ?? "", now));

  // x-anchormailbox (OID:{oid}@{tid}) for the Substrate My Day endpoint. oid =
  // Graph /me.id; tid is not in /me, so read it from our own access token's
  // claims (more reliable than MS_TENANT_ID, which may be common/consumers).
  // Best-effort: if tid can't be resolved the anchor is omitted — the My Day
  // write still persists, other clients just refresh it on their next poll.
  const claims = decodeJwtClaims(token.access_token);
  const tid = typeof claims?.tid === "string" ? claims.tid : null;
  const anchorMailbox = tid ? buildAnchorMailbox(me.id, tid) : undefined;
  await storeIdentity(env, {
    id: me.id,
    displayName: me.displayName,
    mail: me.mail,
    userPrincipalName: me.userPrincipalName,
    first_seen: prevIdentity?.id === me.id ? prevIdentity.first_seen : now,
    last_seen: now,
    anchorMailbox,
  });

  // Fresh Microsoft tokens satisfy any pending re-auth; resume syncing.
  await index.clearReauth();
  const { epoch } = await index.authState();
  log.info("owner_authenticated", { id: me.id, identity_changed: identityChanged });

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: "owner",
    metadata: { label: "owner" },
    scope: authRequest.scope,
    props: { user: "owner", epoch, authorized_at: now },
  });
  headers.set("location", redirectTo);
  return new Response(null, { status: 302, headers });
}
