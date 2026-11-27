// Identity check 4: read what is deployed through the Cloudflare API before any
// write. Only a definite "this Worker does not exist" (HTTP 404 on its settings)
// counts as a first deploy; every other failure refuses, so an expired token or
// the wrong account can never read as "nothing there, go ahead".
//
// Endpoint shapes come from wrangler's own bundle (node_modules/wrangler/
// wrangler-dist/cli.js, wrangler 4.158), the authority for what the API returns.
// Every response is { success, errors, result }.
import { DeploymentRefusal, type DeploymentFile } from "./schema.ts";
import { normalizeHost, ownFile, WRANGLER_NO_ENV, wranglerEnv } from "./checks.ts";
import type { Runner } from "./runner.ts";

export interface CloudflareApi {
  getWorkerKv(account: string, worker: string): Promise<{ found: false } | { found: true; kv: Record<string, string> }>;
  listCustomDomains(account: string): Promise<{ hostname: string; service: string }[]>;
  domainChangeset(
    account: string,
    worker: string,
    hostnames: string[],
  ): Promise<{ added: string[]; removed: string[]; conflicting: string[] }>;
  getSubdomain(account: string, worker: string): Promise<{ enabled: boolean; previews_enabled: boolean }>;
}

const API_BASE = "https://api.cloudflare.com/client/v4";

// Carries the HTTP status (when there was one) and nothing from the response: its
// message is one of the fixed strings below, so refusals may print it.
class CloudflareApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function createCloudflareApi(token: string, fetchImpl: typeof fetch = fetch): CloudflareApi {
  const accountUrl = (account: string, rest: string) => `${API_BASE}/accounts/${encodeURIComponent(account)}${rest}`;
  const scriptUrl = (account: string, worker: string, rest: string) =>
    accountUrl(account, `/workers/scripts/${encodeURIComponent(worker)}${rest}`);

  // Resolves to the response status and, for a 2xx, the unwrapped `result`.
  // Messages here are fixed strings: a thrown fetch error or a response body can
  // echo request headers, so neither is ever copied into an error.
  async function call(url: string, init: { method: string; body?: unknown }, tolerate404 = false) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch {
      throw new CloudflareApiError("request failed");
    }
    if (tolerate404 && res.status === 404) {
      // Wrangler's isWorkerNotFoundError (cli.js:165489-165497) keys on the API error
      // code 10007, not the status. 10090 there is the legacy-environment code, which
      // the services/environments endpoints raise, not this scripts endpoint. Any
      // other 404 (another code, an empty or non-JSON body) is not a definite not-found.
      let notFound = false;
      try {
        const b: unknown = await res.json();
        notFound =
          isObject(b) && Array.isArray(b.errors) && (b.errors as unknown[]).some((e) => isObject(e) && e.code === 10007);
      } catch {
        // unreadable body: not definite
      }
      if (notFound) return { status: 404, result: undefined as unknown };
      throw new CloudflareApiError("HTTP 404", 404);
    }
    if (res.status < 200 || res.status > 299) throw new CloudflareApiError(`HTTP ${res.status}`, res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new CloudflareApiError("response was not JSON", res.status);
    }
    if (!isObject(body) || body.success !== true) throw new CloudflareApiError("API reported success: false", res.status);
    return { status: res.status, result: body.result };
  }

  const malformed = (what: string): never => {
    throw new CloudflareApiError(`unexpected ${what} response`);
  };
  const hostnames = (list: unknown, what: string): string[] => {
    if (!Array.isArray(list)) return malformed(what);
    return (list as unknown[]).map((x) => (isObject(x) && typeof x.hostname === "string" ? x.hostname : malformed(what)));
  };

  return {
    // cli.js:118674, the SDK's scripts settings GET: result.bindings[] with
    // { type: "kv_namespace", name, namespace_id } (the same fields wrangler reads
    // at cli.js:32640 and 176017). The only call where a 404 with API error code 10007 means "no such Worker".
    async getWorkerKv(account, worker) {
      const { status, result } = await call(scriptUrl(account, worker, "/settings"), { method: "GET" }, true);
      if (status === 404) return { found: false };
      if (!isObject(result) || !Array.isArray(result.bindings)) return malformed("settings");
      const kv: Record<string, string> = {};
      for (const b of result.bindings as unknown[]) {
        if (!isObject(b) || b.type !== "kv_namespace") continue;
        if (typeof b.name !== "string" || typeof b.namespace_id !== "string") return malformed("settings");
        kv[b.name] = b.namespace_id;
      }
      return { found: true, kv };
    },

    // cli.js:117796, the SDK's account-wide domains list (single page): each entry
    // has hostname and service (the Worker name), as wrangler reads them at
    // cli.js:166230 (`domain3.hostname`, `domain3.service`).
    async listCustomDomains(account) {
      const { result } = await call(accountUrl(account, "/workers/domains"), { method: "GET" });
      if (!Array.isArray(result)) return malformed("domains");
      return (result as unknown[]).map((d) => {
        if (!isObject(d) || typeof d.hostname !== "string" || typeof d.service !== "string") return malformed("domains");
        const o = d as { hostname: string; service: string };
        return { hostname: o.hostname, service: o.service };
      });
    },

    // cli.js:166145-166170 (publishCustomDomains): POST <script>/domains/changeset
    // ?replace_state=true with an array of origins ({ hostname, zone_id?, ... });
    // result is { added, removed, updated, conflicting }, each a list of objects
    // with `hostname` (cli.js:166231). This only computes a diff; it writes nothing.
    async domainChangeset(account, worker, wanted) {
      const { result } = await call(scriptUrl(account, worker, "/domains/changeset?replace_state=true"), {
        method: "POST",
        body: wanted.map((hostname) => ({ hostname })),
      });
      if (!isObject(result)) return malformed("changeset");
      return {
        added: hostnames(result.added, "changeset"),
        removed: hostnames(result.removed, "changeset"),
        conflicting: hostnames(result.conflicting, "changeset"),
      };
    },

    // cli.js:118895, the SDK's per-script subdomain GET (wrangler's deploy reads
    // the same flags at cli.js:166664-166676): result is { enabled, previews_enabled }.
    async getSubdomain(account, worker) {
      const { result } = await call(scriptUrl(account, worker, "/subdomain"), { method: "GET" });
      if (!isObject(result) || typeof result.enabled !== "boolean" || typeof result.previews_enabled !== "boolean") {
        return malformed("subdomain");
      }
      return { enabled: result.enabled, previews_enabled: result.previews_enabled };
    },
  };
}

type ApiCall = "settings" | "domains" | "changeset" | "subdomain";

// What a refusal may say about a failure: which call, then the client's own
// message (fixed strings, built from the status at most), else an HTTP status,
// else the error class. Never another error's message: it can echo a body or a header.
function failureReason(call: ApiCall, e: unknown): string {
  let reason = "unknown error";
  if (e instanceof CloudflareApiError) reason = e.message;
  else if (e instanceof Error) {
    const status = (e as { status?: unknown }).status;
    reason = typeof status === "number" ? `HTTP ${status}` : e.name;
  }
  return `${call} call: ${reason}`;
}

const couldNotVerify = (dep: DeploymentFile, call: ApiCall, e: unknown): DeploymentRefusal =>
  new DeploymentRefusal(
    ownFile(dep),
    "(live Worker)",
    `could not verify the live Worker ${dep.worker_name}: ${failureReason(call, e)}`,
  );

// Refusal file is the deployment's own path (`deployments/<name>/deployment.jsonc`,
// the same helper the other environment checks use), so the signature stays
// (api, dep, opts).
export async function checkLiveWorker(api: CloudflareApi, dep: DeploymentFile, opts: { adopt: boolean }): Promise<void> {
  await inspectLiveWorker(api, dep, opts);
}

// checkLiveWorker, also reporting whether the Worker exists, so a caller can skip
// the reads that only make sense for an uploaded script (changeset, subdomain).
export async function inspectLiveWorker(
  api: CloudflareApi,
  dep: DeploymentFile,
  opts: { adopt: boolean },
): Promise<{ found: boolean }> {
  const file = ownFile(dep);

  let live: Awaited<ReturnType<CloudflareApi["getWorkerKv"]>>;
  try {
    live = await api.getWorkerKv(dep.account_id, dep.worker_name);
  } catch (e) {
    throw couldNotVerify(dep, "settings", e);
  }
  // A binding the live Worker lacks is a new binding (a template addition), so it
  // is not a mismatch by itself; but at least one file binding must match live
  // exactly, otherwise this is a different Worker that happens to share the name.
  if (live.found && !opts.adopt) {
    const entries = Object.entries(dep.kv);
    for (const [binding, id] of entries) {
      const liveId = live.kv[binding];
      if (liveId !== undefined && liveId !== id) {
        throw new DeploymentRefusal(
          file,
          `kv.${binding}`,
          `the live Worker ${dep.worker_name} binds ${binding} to ${liveId}, the file says ${id}; pass --adopt only if you mean to rebind it`,
        );
      }
    }
    if (entries.length > 0 && !entries.some(([binding, id]) => live.kv[binding] === id)) {
      const [first] = entries[0];
      throw new DeploymentRefusal(
        file,
        `kv.${first}`,
        `the live Worker ${dep.worker_name} has none of the file's KV bindings (${first} is missing); pass --adopt only if this is the Worker you mean to take over`,
      );
    }
  }

  if (dep.custom_domains.length === 0) return { found: live.found };
  let domains: Awaited<ReturnType<CloudflareApi["listCustomDomains"]>>;
  try {
    domains = await api.listCustomDomains(dep.account_id);
  } catch (e) {
    throw couldNotVerify(dep, "domains", e);
  }
  dep.custom_domains.forEach((d, i) => {
    const holder = domains.find((x) => normalizeHost(x.hostname) === normalizeHost(d));
    if (holder && holder.service !== dep.worker_name) {
      throw new DeploymentRefusal(file, `custom_domains[${i}]`, `${d} is attached to the Worker ${holder.service}, not ${dep.worker_name}`);
    }
  });
  return { found: live.found };
}

// Hostnames currently attached to this deployment's Worker, for `check` to print.
export async function attachedDomains(api: CloudflareApi, dep: DeploymentFile): Promise<string[]> {
  try {
    const all = await api.listCustomDomains(dep.account_id);
    return all.filter((d) => d.service === dep.worker_name).map((d) => d.hostname);
  } catch (e) {
    throw couldNotVerify(dep, "domains", e);
  }
}

// The live workers.dev and preview-URL switches, for `check` to compare with the file.
export async function liveSubdomain(api: CloudflareApi, dep: DeploymentFile) {
  try {
    return await api.getSubdomain(dep.account_id, dep.worker_name);
  } catch (e) {
    throw couldNotVerify(dep, "subdomain", e);
  }
}

// What attaching this deployment's custom_domains would add, remove or collide
// with; used by `check` and `deploy --non-interactive` to refuse on conflicts.
export async function checkDomainChangeset(api: CloudflareApi, dep: DeploymentFile) {
  try {
    return await api.domainChangeset(dep.account_id, dep.worker_name, dep.custom_domains);
  } catch (e) {
    throw couldNotVerify(dep, "changeset", e);
  }
}

// `wrangler auth token --json` prints { type: "api_token" | "oauth", token } or
// { type: "api_key", key, email } (cli.js:353070-353115). Wrangler also prints
// warnings and sometimes other noise around it, so the JSON object is located in
// stdout instead of parsing all of it. The token stays in this process: the
// only consumer is the Authorization header in createCloudflareApi.
// `cwd` is the repo root, where every wrangler child runs.
export async function wranglerToken(run: Runner, dep: DeploymentFile, cwd: string): Promise<string> {
  const refuse = (reason: string): never => {
    throw new DeploymentRefusal("wrangler", "auth token", reason);
  };
  const res = await run("npx", ["wrangler", "auth", "token", "--json", WRANGLER_NO_ENV], { env: wranglerEnv(dep), cwd });
  if (res.code !== 0) return refuse("could not read wrangler's login; run `npx wrangler login` and retry");

  const parsed = findJsonObject(res.stdout);
  if (!parsed || typeof parsed.type !== "string") return refuse("wrangler printed no token; run `npx wrangler login` and retry");
  if (parsed.type === "api_key") {
    return refuse("wrangler is using CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL; set CLOUDFLARE_API_TOKEN or run `npx wrangler login`");
  }
  if ((parsed.type === "oauth" || parsed.type === "api_token") && typeof parsed.token === "string" && parsed.token !== "") {
    return parsed.token;
  }
  return refuse("wrangler printed a credential type this script cannot use; run `npx wrangler login`");
}

// The first top-level JSON object in `text` that parses, ignoring surrounding noise.
function findJsonObject(text: string): Record<string, unknown> | undefined {
  const ends: number[] = [];
  for (let i = text.length - 1; i >= 0; i--) if (text[i] === "}") ends.push(i);
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    for (const end of ends) {
      if (end < start) break;
      try {
        const v: unknown = JSON.parse(text.slice(start, end + 1));
        if (isObject(v)) return v;
      } catch {
        // not this span
      }
    }
  }
  return undefined;
}
