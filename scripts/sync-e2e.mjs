#!/usr/bin/env node
// End-to-end check of the client sync API (docs/SYNC-API.md section 12, step 9).
//
//   node scripts/sync-e2e.mjs https://<your-worker-host>
//
// Signs in as an app would (dynamic client registration, PKCE, resource
// /api/v1), pulls the whole change feed, then holds the push socket open. Edit
// a task in Microsoft To Do: each `changed` message is followed by a pull, and
// the script prints what changed and how long after the task's Graph
// modification time the message arrived. Ctrl-C to stop.
//
// Sign-in: open the printed URL in a browser. If the browser can reach this
// machine's 127.0.0.1:8765 (same machine, or a forwarded port) the script
// continues by itself; otherwise copy the address the browser ends on (it
// starts with http://127.0.0.1:8765/cb?code=) and paste it here.
//
// With --write, it also sends a create, an update and a delete for a
// throwaway task in the default list through POST /sync/mutations, and shows
// each result and the push messages they cause.
//
// Tokens are kept in ~/.cache/mstodo-sync-e2e/<host>.json (mode 600) and
// refreshed as needed, so later runs skip sign-in.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import WebSocket from "ws";

const origin = new URL(process.argv[2] ?? "").origin;
const WRITE = process.argv.includes("--write");
const RESOURCE = `${origin}/api/v1`;
const PORT = 8765;
const REDIRECT = `http://127.0.0.1:${PORT}/cb`;
const cacheDir = join(homedir(), ".cache", "mstodo-sync-e2e");
const cacheFile = join(cacheDir, `${new URL(origin).host}.json`);
const b64url = (b) => b.toString("base64url");
const now = () => new Date().toISOString().slice(11, 23);

function load() {
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch {
    return {};
  }
}
function save(state) {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  writeFileSync(cacheFile, JSON.stringify(state), { mode: 0o600 });
}

async function form(path, body) {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${json.error ?? ""} ${json.error_description ?? ""}`);
  return json;
}

async function register() {
  const res = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Sync API end-to-end check",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (!res.ok) throw new Error(`/register: ${res.status} ${await res.text()}`);
  return (await res.json()).client_id;
}

// Resolves with the callback URL, from the local listener or a paste.
function waitForCallback() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (!req.url?.startsWith("/cb")) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/plain" }).end("Signed in. You can close this tab.");
      done(`http://127.0.0.1:${PORT}${req.url}`);
    });
    server.on("error", () => {}); // port busy: paste only
    server.listen(PORT, "127.0.0.1");
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => line.includes("code=") && done(line.trim()));
    function done(url) {
      server.close();
      rl.close();
      resolve(url);
    }
  });
}

async function signIn(state) {
  state.client_id ??= await register();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const csrf = b64url(randomBytes(16));
  const url = new URL(`${origin}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: state.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: csrf,
    resource: RESOURCE,
  }).toString();
  console.log(`\nOpen this URL and sign in:\n\n${url}\n\nWaiting for the callback (or paste the final address here)...`);
  const cb = new URL(await waitForCallback());
  if (cb.searchParams.get("state") !== csrf) throw new Error("state mismatch");
  const code = cb.searchParams.get("code");
  if (!code) throw new Error(`no code: ${cb.searchParams.get("error") ?? cb}`);
  const tok = await form("/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: state.client_id,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  Object.assign(state, { access: tok.access_token, refresh: tok.refresh_token, exp: Date.now() + tok.expires_in * 1000 });
  save(state);
}

async function token(state) {
  if (state.access && state.exp > Date.now() + 60_000) return state.access;
  if (state.refresh) {
    try {
      const tok = await form("/token", {
        grant_type: "refresh_token",
        refresh_token: state.refresh,
        client_id: state.client_id,
        resource: RESOURCE,
      });
      Object.assign(state, { access: tok.access_token, refresh: tok.refresh_token ?? state.refresh, exp: Date.now() + tok.expires_in * 1000 });
      save(state);
      return state.access;
    } catch (e) {
      console.log(`refresh failed (${e.message}); signing in again`);
    }
  }
  await signIn(state);
  return state.access;
}

async function api(state, path) {
  const res = await fetch(`${origin}/api/v1${path}`, { headers: { authorization: `Bearer ${await token(state)}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${body.error ?? ""}`);
  return body;
}

// Pulls from `cursor` until caught up; returns the new cursor and the changes.
async function pull(state, cursor) {
  const all = [];
  for (;;) {
    const q = new URLSearchParams({ scope: "all", limit: "500", ...(cursor ? { cursor } : {}) });
    const page = await api(state, `/sync/changes?${q}`);
    all.push(...page.changes);
    cursor = page.cursor;
    if (!page.has_more) return { cursor, changes: all, backfill: page.backfill };
  }
}

const describe = (c) =>
  c.deleted ? `${c.kind} ${c.id.slice(0, 8)} deleted` : `${c.kind} ${c.id.slice(0, 8)} "${c.data.title ?? c.data.name}"${c.data.status ? ` [${c.data.status}]` : ""}`;

async function main() {
  if (!process.argv[2]) throw new Error("usage: node scripts/sync-e2e.mjs https://<worker-host>");
  const state = load();
  console.log("server:", (await (await fetch(`${origin}/api/v1/sync/info`)).json()).server_id);
  const info = await api(state, "/sync/info");
  console.log(`account: ${info.account.name} (${info.account.email_hint}), version ${info.version}, push ${info.capabilities.push}`);

  const t0 = Date.now();
  let { cursor, changes, backfill } = await pull(state, state.cursor && state.epoch === info.cursor.split(".")[0] ? state.cursor : null);
  const counts = changes.reduce((m, c) => ((m[`${c.kind}${c.deleted ? " deleted" : ""}`] = (m[`${c.kind}${c.deleted ? " deleted" : ""}`] ?? 0) + 1), m), {});
  console.log(`pulled ${changes.length} changes in ${Date.now() - t0} ms`, counts, `backfill remaining ${backfill.remaining}`);
  Object.assign(state, { cursor, epoch: cursor.split(".")[0] });
  save(state);

  const connect = async () => {
    const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/api/v1/sync/socket`, {
      headers: { authorization: `Bearer ${await token(state)}`, "x-client-id": "sync-e2e" },
    });
    const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
    ws.on("unexpected-response", (_req, res) => console.log(`${now()} socket refused: ${res.statusCode}`));
    ws.on("message", async (data) => {
      const text = data.toString();
      if (text === "pong") return;
      const msg = JSON.parse(text);
      const at = Date.now();
      if (msg.type === "hello") return console.log(`${now()} socket open, server cursor ${msg.cursor}; edit a task in To Do now`);
      if (msg.type === "reauth") return console.log(`${now()} reauth requested`);
      if (msg.type !== "changed") return;
      const r = await pull(state, state.cursor);
      state.cursor = r.cursor;
      save(state);
      for (const c of r.changes) {
        const mod = c.data?.modified_at ? Date.parse(c.data.modified_at) : null;
        const lag = mod ? ` — ${((at - mod) / 1000).toFixed(1)} s after Graph's modified time` : "";
        console.log(`${now()} changed: ${describe(c)}${lag}`);
      }
    });
    ws.on("close", (code) => {
      clearInterval(ping);
      console.log(`${now()} socket closed (${code}); reconnecting`);
      setTimeout(connect, 1000);
    });
    ws.on("error", (e) => console.log(`${now()} socket error: ${e.message}`));
  };
  await connect();
  if (WRITE) setTimeout(() => writeRoundTrip(state, changes).catch((e) => console.log(`write test failed: ${e.message}`)), 2000);
}

async function mutate(state, mutations) {
  const res = await fetch(`${origin}/api/v1/sync/mutations`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token(state)}`, "content-type": "application/json" },
    body: JSON.stringify({ client_id: "sync-e2e", mutations }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`mutations: ${res.status} ${body.error ?? ""}`);
  for (const r of body.results) console.log(`${now()} result ${r.id}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
  return body;
}

async function writeRoundTrip(state, initial) {
  const list = initial.find((c) => c.kind === "list" && !c.deleted && c.data.wellknown === "defaultList");
  if (!list) throw new Error("no default list in the feed");
  const sid = crypto.randomUUID();
  const at = () => new Date().toISOString();
  const id = () => `e2e-${crypto.randomUUID()}`;
  console.log(`${now()} write test: creating task ${sid.slice(0, 8)} in "${list.data.name}"`);
  await mutate(state, [{ id: id(), at: at(), op: "task.create", sid, fields: { list_id: list.id, title: "[sync e2e] safe to delete" } }]);
  await new Promise((r) => setTimeout(r, 1500));
  await mutate(state, [{ id: id(), at: at(), op: "task.update", sid, fields: { title: "[sync e2e] renamed", importance: "high" } }]);
  await new Promise((r) => setTimeout(r, 1500));
  await mutate(state, [{ id: id(), at: at(), op: "task.delete", sid }]);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
