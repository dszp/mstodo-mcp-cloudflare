// The web client's Worker: serves the built app from the ASSETS binding and
// routes /auth/* and /bff/* to the backend-for-frontend. The Worker runs first
// on every path (run_worker_first), so every response, assets included, gets the
// security headers. The BFF itself is host-independent; this file is the only
// place that knows about bindings.

import { route } from "../../bff/router.ts";
import { HSTS, isBffPath, withSecurityHeaders } from "../../bff/headers.ts";
import { sealer } from "../../bff/seal.ts";
import { type BffConfig, upstreamVia } from "../../bff/upstream.ts";

/** The part of a Workers `Fetcher` binding this host uses. */
export interface Binding {
  fetch(req: Request): Promise<Response>;
}

export interface Env {
  ASSETS: Binding;
  /** Service binding to potem-server; global fetch is used when it is absent. */
  SERVER?: Binding;
  SERVER_ORIGIN: string;
  WEB_ORIGIN: string;
  WEB_SESSION_SECRET: string;
  WEB_SESSION_MAX_HOURS?: string;
  WEB_SESSION_IDLE_MINUTES?: string;
  /** Which app icon the deployment shows: "blue" (the default, production) or "teal" (development). */
  WEB_ICON?: string;
}

const DEFAULT_MAX_HOURS = 12;
const DEFAULT_IDLE_MINUTES = 60;

type Icon = "blue" | "teal";
type Checked = { ok: true; cfg: BffConfig; icon: Icon } | { ok: false; variable: string };

// The icon files at the site root are the blue set; a teal deployment serves
// the same names from public/icons/teal/, so index.html and the sidebar logo
// never need to know which deployment they are on.
const ICON_FILES = new Set(["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png"]);

/** An https origin with no path, query or userinfo; plain http only for loopback. */
function originOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
  return u.origin === value ? u.origin : null;
}

/** `fallback` when the variable is absent; null when it is present but not a positive integer. */
function positiveInt(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

// Workers have no startup hook, so the configuration is checked on every request.
async function checkConfig(env: Env): Promise<Checked> {
  const serverOrigin = originOf(env.SERVER_ORIGIN);
  if (!serverOrigin) return { ok: false, variable: "SERVER_ORIGIN" };
  const webOrigin = originOf(env.WEB_ORIGIN);
  if (!webOrigin) return { ok: false, variable: "WEB_ORIGIN" };
  const secret = env.WEB_SESSION_SECRET;
  try {
    await sealer(typeof secret === "string" ? secret : "");
  } catch {
    return { ok: false, variable: "WEB_SESSION_SECRET" };
  }
  const maxHours = positiveInt(env.WEB_SESSION_MAX_HOURS, DEFAULT_MAX_HOURS);
  if (maxHours === null) return { ok: false, variable: "WEB_SESSION_MAX_HOURS" };
  const idleMinutes = positiveInt(env.WEB_SESSION_IDLE_MINUTES, DEFAULT_IDLE_MINUTES);
  if (idleMinutes === null) return { ok: false, variable: "WEB_SESSION_IDLE_MINUTES" };
  const icon = env.WEB_ICON ?? "blue";
  if (icon !== "blue" && icon !== "teal") return { ok: false, variable: "WEB_ICON" };

  const fetchFn = env.SERVER ? (r: Request) => env.SERVER!.fetch(r) : (r: Request) => fetch(r);
  return {
    ok: true,
    icon,
    cfg: {
      webOrigin,
      serverOrigin,
      secret,
      maxHours,
      idleMinutes,
      upstream: upstreamVia(serverOrigin, fetchFn),
      now: () => Math.floor(Date.now() / 1000),
      random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  };
}

function misconfigured(variable: string, pathname: string): Response {
  // The variable's name only: a value could be the session secret.
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "strict-transport-security": HSTS,
  });
  // As withSecurityHeaders does for /auth and /bff, which can't run without a config.
  if (isBffPath(pathname)) headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(`Service misconfigured: ${variable} is missing or invalid.\n`, { status: 503, headers });
}

const text = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const checked = await checkConfig(env);
    if (!checked.ok) return misconfigured(checked.variable, new URL(req.url).pathname);
    const { cfg, icon } = checked;
    const url = new URL(req.url);

    // A second hostname on the Worker would mint cookies and OAuth callbacks
    // for the wrong origin.
    if (url.origin !== cfg.webOrigin) {
      return withSecurityHeaders(text("Misdirected request.\n", 421), cfg, url.pathname);
    }

    const bff = await route(req, cfg);
    if (bff) return bff;

    if (req.method !== "GET" && req.method !== "HEAD") {
      return withSecurityHeaders(text("Method not allowed.\n", 405, { allow: "GET, HEAD" }), cfg, url.pathname);
    }
    if (icon === "teal" && ICON_FILES.has(url.pathname)) {
      const teal = new URL(url);
      teal.pathname = `/icons/teal${url.pathname}`;
      return withSecurityHeaders(await env.ASSETS.fetch(new Request(teal, req)), cfg, url.pathname);
    }
    return withSecurityHeaders(await env.ASSETS.fetch(req), cfg, url.pathname);
  },
};
