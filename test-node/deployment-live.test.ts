import { describe, it, expect } from "vitest";
import { DeploymentRefusal, type DeploymentFile } from "../scripts/deployment/schema.ts";
import type { Runner } from "../scripts/deployment/runner.ts";
import {
  checkDomainChangeset,
  checkLiveWorker,
  createCloudflareApi,
  wranglerToken,
  type CloudflareApi,
} from "../scripts/deployment/live.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const KV_A = "0123456789abcdef0123456789abcde1";
const KV_B = "0123456789abcdef0123456789abcde2";
const KV_OTHER = "0123456789abcdef0123456789abcde9";
const TOKEN = "tok-SECRET-0123456789";

const dep = (over: Partial<DeploymentFile> = {}): DeploymentFile => ({
  name: "alpha",
  account_id: ACCOUNT,
  worker_name: "example-alpha",
  base_url: "https://example-alpha.acct.workers.dev",
  workers_dev: true,
  preview_urls: false,
  custom_domains: [],
  kv: { OAUTH_KV: KV_A, TODO_CACHE: KV_B },
  r2: {},
  vars: {},
  ...over,
});

const stubApi = (over: Partial<CloudflareApi> = {}): CloudflareApi => ({
  getWorkerKv: async () => ({ found: false }),
  listCustomDomains: async () => [],
  domainChangeset: async () => ({ added: [], removed: [], conflicting: [] }),
  getSubdomain: async () => ({ enabled: true, previews_enabled: false }),
  ...over,
});

const refusalOf = async (p: Promise<unknown>): Promise<DeploymentRefusal> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DeploymentRefusal);
    return e as DeploymentRefusal;
  }
  throw new Error("expected a refusal, got a pass");
};

describe("checkLiveWorker", () => {
  it("passes when the Worker does not exist yet (first deploy)", async () => {
    await expect(checkLiveWorker(stubApi(), dep(), { adopt: false })).resolves.toBeUndefined();
  });

  it("passes when the live KV bindings equal the file's", async () => {
    const api = stubApi({ getWorkerKv: async () => ({ found: true, kv: { OAUTH_KV: KV_A, TODO_CACHE: KV_B } }) });
    await expect(checkLiveWorker(api, dep(), { adopt: false })).resolves.toBeUndefined();
  });

  it("refuses a different KV ID, naming the binding and the file", async () => {
    const api = stubApi({ getWorkerKv: async () => ({ found: true, kv: { OAUTH_KV: KV_A, TODO_CACHE: KV_OTHER } }) });
    const r = await refusalOf(checkLiveWorker(api, dep(), { adopt: false }));
    expect(r.file).toBe("deployments/alpha/deployment.jsonc");
    expect(r.field).toBe("kv.TODO_CACHE");
    expect(r.message).toContain("--adopt");
  });

  it("accepts the same difference with adopt: true", async () => {
    const api = stubApi({ getWorkerKv: async () => ({ found: true, kv: { OAUTH_KV: KV_OTHER, TODO_CACHE: KV_OTHER } }) });
    await expect(checkLiveWorker(api, dep(), { adopt: true })).resolves.toBeUndefined();
  });

  it("refuses a live Worker with none of the file's KV bindings, unless adopted", async () => {
    for (const kv of [{}, { CACHE: KV_OTHER }] as Record<string, string>[]) {
      const api = stubApi({ getWorkerKv: async () => ({ found: true, kv }) });
      const r = await refusalOf(checkLiveWorker(api, dep(), { adopt: false }));
      expect(r.field).toBe("kv.OAUTH_KV");
      await expect(checkLiveWorker(api, dep(), { adopt: true })).resolves.toBeUndefined();
    }
  });

  it("does not refuse a binding the live Worker does not have yet", async () => {
    const api = stubApi({ getWorkerKv: async () => ({ found: true, kv: { OAUTH_KV: KV_A } }) });
    await expect(checkLiveWorker(api, dep(), { adopt: false })).resolves.toBeUndefined();
  });

  it("refuses a custom domain attached to another Worker, case and trailing dot ignored", async () => {
    const api = stubApi({ listCustomDomains: async () => [{ hostname: "a.example.com", service: "other-worker" }] });
    const r = await refusalOf(checkLiveWorker(api, dep({ custom_domains: ["A.example.com."] }), { adopt: false }));
    expect(r.field).toBe("custom_domains[0]");
    expect(r.message).toContain("other-worker");
  });

  it("passes a custom domain already on this Worker, and keeps refusing it under adopt", async () => {
    const own = stubApi({ listCustomDomains: async () => [{ hostname: "a.example.com", service: "example-alpha" }] });
    await expect(checkLiveWorker(own, dep({ custom_domains: ["a.example.com"] }), { adopt: false })).resolves.toBeUndefined();
    const other = stubApi({ listCustomDomains: async () => [{ hostname: "a.example.com", service: "other-worker" }] });
    await refusalOf(checkLiveWorker(other, dep({ custom_domains: ["a.example.com"] }), { adopt: true }));
  });

  it("refuses when the Worker settings call rejects, for any reason", async () => {
    for (const why of [Object.assign(new Error("boom"), { status: 403 }), new TypeError("fetch failed")]) {
      const api = stubApi({ getWorkerKv: async () => Promise.reject(why) });
      const r = await refusalOf(checkLiveWorker(api, dep(), { adopt: false }));
      expect(r.message).toContain("could not verify the live Worker example-alpha");
    }
  });

  it("refuses when the domain list rejects, and puts the status or class in the message, not the body", async () => {
    const api = stubApi({
      listCustomDomains: async () => Promise.reject(Object.assign(new Error(`echo ${TOKEN}`), { status: 500 })),
    });
    const r = await refusalOf(checkLiveWorker(api, dep({ custom_domains: ["a.example.com"] }), { adopt: false }));
    expect(r.message).toContain("could not verify the live Worker example-alpha: 500");
    expect(r.message).not.toContain(TOKEN);
  });

  it("does not list domains when the file has none", async () => {
    let listed = false;
    const api = stubApi({ listCustomDomains: async () => ((listed = true), []) });
    await checkLiveWorker(api, dep(), { adopt: false });
    expect(listed).toBe(false);
  });
});

describe("checkDomainChangeset", () => {
  it("asks for the file's account, Worker and hostnames and returns the changeset", async () => {
    const calls: unknown[][] = [];
    const api = stubApi({
      domainChangeset: async (...a) => (calls.push(a), { added: ["a.example.com"], removed: [], conflicting: [] }),
    });
    const out = await checkDomainChangeset(api, dep({ custom_domains: ["a.example.com"] }));
    expect(out.added).toEqual(["a.example.com"]);
    expect(calls).toEqual([[ACCOUNT, "example-alpha", ["a.example.com"]]]);
  });

  it("turns a failure into a could-not-verify refusal", async () => {
    const api = stubApi({ domainChangeset: async () => Promise.reject(new Error("x")) });
    const r = await refusalOf(checkDomainChangeset(api, dep()));
    expect(r.message).toContain("could not verify the live Worker example-alpha");
  });
});

type Seen = { url: string; init: RequestInit };
const jsonResponse = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const ok = (result: unknown) => ({ success: true, errors: [], result });
const fetchStub = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { f, seen };
};

describe("createCloudflareApi", () => {
  it("reads KV bindings from the Worker settings and ignores other binding types", async () => {
    const { f, seen } = fetchStub(() =>
      jsonResponse(200, ok({ bindings: [
        { type: "kv_namespace", name: "OAUTH_KV", namespace_id: KV_A },
        { type: "r2_bucket", name: "BLOBS", bucket_name: "x" },
        { type: "kv_namespace", name: "TODO_CACHE", namespace_id: KV_B },
      ] })),
    );
    const out = await createCloudflareApi(TOKEN, f).getWorkerKv(ACCOUNT, "example-alpha");
    expect(out).toEqual({ found: true, kv: { OAUTH_KV: KV_A, TODO_CACHE: KV_B } });
    expect(seen[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/example-alpha/settings`);
  });

  it("sends the token only as the Authorization header, to api.cloudflare.com", async () => {
    const { f, seen } = fetchStub((url) =>
      jsonResponse(200, ok(url.endsWith("/domains") ? [] : { bindings: [] })),
    );
    const api = createCloudflareApi(TOKEN, f);
    await api.getWorkerKv(ACCOUNT, "example-alpha");
    await api.listCustomDomains(ACCOUNT);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(new URL(s.url).origin).toBe("https://api.cloudflare.com");
      expect(s.url).not.toContain(TOKEN);
      expect(new Headers(s.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(String(s.init.body ?? "")).not.toContain(TOKEN);
    }
  });

  it("encodes the account and Worker name into the path", async () => {
    const { f, seen } = fetchStub(() => jsonResponse(200, ok({ bindings: [] })));
    await createCloudflareApi(TOKEN, f).getWorkerKv("a/b", "w?x");
    expect(seen[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/a%2Fb/workers/scripts/w%3Fx/settings");
  });

  it("maps a 404 with API error 10007 on the settings call to not-found", async () => {
    const { f } = fetchStub(() => jsonResponse(404, { success: false, errors: [{ code: 10007 }], result: null }));
    expect(await createCloudflareApi(TOKEN, f).getWorkerKv(ACCOUNT, "w")).toEqual({ found: false });
  });

  it("rejects a 404 that is not the script-not-found code", async () => {
    for (const body of [{ success: false, errors: [{ code: 7003 }], result: null }, "", "<html>", { success: false, errors: [] }]) {
      const { f } = fetchStub(() => jsonResponse(404, body));
      await expect(createCloudflareApi(TOKEN, f).getWorkerKv(ACCOUNT, "w")).rejects.toMatchObject({ status: 404 });
    }
  });

  it("rejects on 401, 403, 500, a thrown fetch, a non-JSON body and success:false, without the token in the message", async () => {
    const cases: [string, typeof fetch][] = [
      ["401", fetchStub(() => jsonResponse(401, `denied ${TOKEN}`)).f],
      ["403", fetchStub(() => jsonResponse(403, { success: false, errors: [{ message: TOKEN }] })).f],
      ["500", fetchStub(() => jsonResponse(500, "oops")).f],
      ["thrown", (async () => { throw new TypeError(`fetch failed ${TOKEN}`); }) as typeof fetch],
      ["non-JSON", fetchStub(() => jsonResponse(200, "<html>")).f],
      ["success:false", fetchStub(() => jsonResponse(200, { success: false, errors: [{ message: TOKEN }], result: null })).f],
      ["no bindings array", fetchStub(() => jsonResponse(200, ok({}))).f],
    ];
    for (const [label, f] of cases) {
      const err = await createCloudflareApi(TOKEN, f).getWorkerKv(ACCOUNT, "w").then(
        () => { throw new Error(`${label}: expected a rejection`); },
        (e: unknown) => e as Error,
      );
      expect(String(err.message), label).not.toContain(TOKEN);
      expect(JSON.stringify(err), label).not.toContain(TOKEN);
    }
  });

  it("carries the HTTP status on the rejection", async () => {
    const { f } = fetchStub(() => jsonResponse(403, { success: false, errors: [], result: null }));
    await expect(createCloudflareApi(TOKEN, f).getWorkerKv(ACCOUNT, "w")).rejects.toMatchObject({ status: 403 });
  });

  it("rejects on 404 from any call other than the settings call", async () => {
    const { f } = fetchStub(() => jsonResponse(404, { success: false, errors: [], result: null }));
    const api = createCloudflareApi(TOKEN, f);
    await expect(api.listCustomDomains(ACCOUNT)).rejects.toMatchObject({ status: 404 });
    await expect(api.getSubdomain(ACCOUNT, "w")).rejects.toMatchObject({ status: 404 });
    await expect(api.domainChangeset(ACCOUNT, "w", ["a.example.com"])).rejects.toMatchObject({ status: 404 });
  });

  it("lists custom domains as hostname and service", async () => {
    const { f, seen } = fetchStub(() =>
      jsonResponse(200, ok([{ id: "1", hostname: "a.example.com", service: "w1", zone_id: "z", environment: "production" }])),
    );
    const out = await createCloudflareApi(TOKEN, f).listCustomDomains(ACCOUNT);
    expect(out).toEqual([{ hostname: "a.example.com", service: "w1" }]);
    expect(seen[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/domains`);
  });

  it("posts the changeset the way wrangler does and returns hostnames", async () => {
    const { f, seen } = fetchStub(() =>
      jsonResponse(200, ok({
        added: [{ id: "1", hostname: "a.example.com" }],
        removed: [{ id: "2", hostname: "old.example.com" }],
        updated: [],
        conflicting: [{ hostname: "c.example.com" }],
      })),
    );
    const out = await createCloudflareApi(TOKEN, f).domainChangeset(ACCOUNT, "w", ["a.example.com", "c.example.com"]);
    expect(out).toEqual({ added: ["a.example.com"], removed: ["old.example.com"], conflicting: ["c.example.com"] });
    expect(seen[0].url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/w/domains/changeset?replace_state=true`,
    );
    expect(seen[0].init.method).toBe("POST");
    expect(JSON.parse(String(seen[0].init.body))).toEqual([{ hostname: "a.example.com" }, { hostname: "c.example.com" }]);
    expect(new Headers(seen[0].init.headers).get("content-type")).toBe("application/json");
  });

  it("reads the per-script workers.dev subdomain flags", async () => {
    const { f, seen } = fetchStub(() => jsonResponse(200, ok({ enabled: true, previews_enabled: false })));
    expect(await createCloudflareApi(TOKEN, f).getSubdomain(ACCOUNT, "w")).toEqual({ enabled: true, previews_enabled: false });
    expect(seen[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/w/subdomain`);
  });
});

describe("wranglerToken", () => {
  const runner = (code: number, stdout: string, stderr = ""): { run: Runner; calls: unknown[][] } => {
    const calls: unknown[][] = [];
    const run: Runner = async (cmd, args, opts) => (calls.push([cmd, args, opts]), { code, stdout, stderr });
    return { run, calls };
  };
  const NOISE = "\u001b[33m▲ [WARNING]\u001b[0m Proxy environment variables detected.\nSafe-chain: x Invalid URL {y}\n";

  it("runs wrangler auth token --json with the account pinned, and reads the token past the noise", async () => {
    const { run, calls } = runner(0, `${NOISE}${JSON.stringify({ type: "oauth", token: TOKEN }, null, 2)}\n`);
    expect(await wranglerToken(run, dep(), "/repo")).toBe(TOKEN);
    expect(calls).toHaveLength(1);
    const [cmd, args, opts] = calls[0] as [string, string[], { env: Record<string, string>; stdin?: string; cwd?: string }];
    expect(opts.cwd).toBe("/repo");
    expect(cmd).toBe("npx");
    expect(args).toEqual(["wrangler", "auth", "token", "--json", "--env="]);
    expect(opts.env).toEqual({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, WRANGLER_CI_OVERRIDE_NAME: "example-alpha" });
  });

  it("accepts an api_token", async () => {
    const { run } = runner(0, JSON.stringify({ type: "api_token", token: TOKEN }));
    expect(await wranglerToken(run, dep(), "/repo")).toBe(TOKEN);
  });

  it("refuses a global API key, which is not a bearer token", async () => {
    const { run } = runner(0, JSON.stringify({ type: "api_key", key: "k-SECRET", email: "x@example.test" }));
    const r = await refusalOf(wranglerToken(run, dep(), "/repo"));
    expect(r.message).toContain("CLOUDFLARE_API_TOKEN");
    expect(r.message).not.toContain("k-SECRET");
  });

  it("refuses with a login instruction on a non-zero exit, without echoing output", async () => {
    const { run } = runner(1, TOKEN, `Not logged in ${TOKEN}`);
    const r = await refusalOf(wranglerToken(run, dep(), "/repo"));
    expect(r.message).toContain("npx wrangler login");
    expect(r.message).not.toContain(TOKEN);
  });

  it("refuses when no token can be found in the output", async () => {
    for (const out of ["", "no json here", JSON.stringify({ type: "oauth" }), JSON.stringify({ type: "mystery", token: TOKEN })]) {
      const r = await refusalOf(wranglerToken(runner(0, out).run, dep(), "/repo"));
      expect(r.message).not.toContain(TOKEN);
    }
  });
});
