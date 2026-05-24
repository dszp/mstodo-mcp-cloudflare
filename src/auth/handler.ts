import { log } from "../log";
import {
  buildAuthorizeUrl,
  computeCodeChallenge,
  exchangeCode,
  fetchMe,
  generateCodeVerifier,
  generateStateToken,
  isOwner,
  loadIdentity,
  putAuthState,
  storeIdentity,
  storeTokens,
  takeAuthState,
  tokensFromResponse,
  wipeIdentityScopedState,
  TokenExchangeError,
  type AuthStateRow,
} from "./microsoft";

const AUTHORIZE_PATH = "/authorize";
const CALLBACK_PATH = "/auth/microsoft/callback";

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

function callbackUrlFor(req: Request): string {
  return `${new URL(req.url).origin}${CALLBACK_PATH}`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === AUTHORIZE_PATH && req.method === "GET") {
      return handleAuthorize(req, env);
    }
    if (url.pathname === CALLBACK_PATH && req.method === "GET") {
      return handleCallback(req, env, url);
    }

    log.debug("auth_path_unknown", { method: req.method, path: url.pathname });
    return new Response("not found", { status: 404 });
  },
};

async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(req);

  // Phase-0.5a advisor carry-forward #2 — sanity-check that the parsed shape
  // round-trips losslessly through base64(JSON). If `lossless` ever logs false,
  // some field is a non-JSON-serializable instance (Headers/URL/etc) and
  // completeAuthorization will reject the round-tripped value at the callback.
  const oauthReqInfoB64 = btoa(JSON.stringify(oauthReqInfo));
  const roundTrip = JSON.parse(atob(oauthReqInfoB64));
  log.debug("oauth_req_round_trip", {
    keys: Object.keys(oauthReqInfo),
    lossless: JSON.stringify(oauthReqInfo) === JSON.stringify(roundTrip),
  });

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);
  const stateToken = generateStateToken();
  const stateRow: AuthStateRow = {
    oauth_req_info_b64: oauthReqInfoB64,
    code_verifier: codeVerifier,
    created_at: Date.now(),
  };
  await putAuthState(env, stateToken, stateRow);

  const authorizeUrl = buildAuthorizeUrl(env, {
    redirectUri: callbackUrlFor(req),
    state: stateToken,
    codeChallenge,
  });
  log.debug("authorize_redirect", { stateTokenPrefix: stateToken.slice(0, 8) });
  return Response.redirect(authorizeUrl, 302);
}

async function handleCallback(req: Request, env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    const desc = url.searchParams.get("error_description") ?? "";
    log.warn("oauth_callback_error", { error: oauthError, description: desc.slice(0, 200) });
    return html(
      `<h1>Microsoft sign-in failed</h1><p><code>${escapeHtml(oauthError)}</code>: ${escapeHtml(desc)}</p>`,
      400,
    );
  }
  if (!code || !stateToken) {
    log.warn("oauth_callback_missing_params", { hasCode: !!code, hasState: !!stateToken });
    return html("<h1>Invalid callback</h1>", 400);
  }

  const state = await takeAuthState(env, stateToken);
  if (!state) {
    log.warn("oauth_state_expired_or_missing", { stateTokenPrefix: stateToken.slice(0, 8) });
    return html("<h1>State expired or unknown</h1><p>Restart the authorization flow.</p>", 400);
  }

  let token;
  try {
    token = await exchangeCode(env, {
      code,
      codeVerifier: state.code_verifier,
      redirectUri: callbackUrlFor(req),
    });
  } catch (e) {
    if (e instanceof TokenExchangeError) {
      log.warn("code_exchange_failed", { reason: e.reason });
      return html(`<h1>Token exchange failed</h1><p><code>${escapeHtml(e.reason)}</code></p>`, 502);
    }
    throw e;
  }

  // OWNER_EMAIL gate — runs AFTER code exchange (we need an access_token to
  // hit /me) but BEFORE storeTokens / completeAuthorization. A non-owner that
  // consented at Microsoft must not leave any persistent state in the Worker
  // and must not receive a Claude.ai-side token.
  let me;
  try {
    me = await fetchMe(token.access_token);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn("me_fetch_failed", { message });
    return html("<h1>Identity probe failed</h1><p>Could not contact Microsoft Graph.</p>", 502);
  }
  if (!isOwner(env, me)) {
    log.warn("owner_gate_rejected", {
      attempted_mail: me.mail,
      attempted_upn: me.userPrincipalName,
    });
    return html(
      `<h1>Not authorized</h1>
       <p>This MCP server is configured for a single owner. Signed in as
       <code>${escapeHtml(me.userPrincipalName)}</code>.</p>`,
      403,
    );
  }

  // Identity-change auto-wipe: if the underlying Microsoft account differs
  // from the previously seen one, the per-identity cache (tokens, eventually
  // lists/tasks/delta — see microsoft.ts wipeIdentityScopedState) is from a
  // different person's data. Wipe before storing the new tokens so we never
  // mix two accounts' state. Note: this only wipes TODO_CACHE; OAUTH_KV
  // grants (Claude.ai-side DCR sessions) are left alone — see README for
  // manual cleanup if you want a fresh Claude.ai pairing.
  const prevIdentity = await loadIdentity(env);
  const identityChanged = prevIdentity !== null && prevIdentity.id !== me.id;
  if (identityChanged) {
    log.warn("identity_change_wipe", {
      prev_id: prevIdentity.id,
      prev_mail: prevIdentity.mail,
      new_id: me.id,
      new_mail: me.mail,
      hint: "Per-identity TODO_CACHE wiped. Claude.ai grants in OAUTH_KV remain — clear manually via README §Reset if you want fresh DCR sessions.",
    });
    await wipeIdentityScopedState(env);
  }

  const now = Date.now();
  const stored = tokensFromResponse(token, token.refresh_token ?? "", now);
  await storeTokens(env, stored);
  await storeIdentity(env, {
    id: me.id,
    displayName: me.displayName,
    mail: me.mail,
    userPrincipalName: me.userPrincipalName,
    first_seen: prevIdentity?.id === me.id ? prevIdentity.first_seen : now,
    last_seen: now,
  });
  log.info("owner_authenticated", {
    id: me.id,
    displayName: me.displayName,
    identity_changed: identityChanged,
  });

  const oauthReqInfo = JSON.parse(atob(state.oauth_req_info_b64));
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: "owner",
    metadata: { label: "owner" },
    scope: oauthReqInfo.scope,
    props: { user: "owner" },
  });

  return Response.redirect(redirectTo, 302);
}
