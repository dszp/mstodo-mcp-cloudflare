import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeploymentRefusal, type DeploymentFile } from "../scripts/deployment/schema.ts";
import {
  checkAccountEnv,
  checkBaseUrl,
  checkCrossFiles,
  loadAllDeployments,
  normalizeHost,
} from "../scripts/deployment/checks.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";
const dep = (over: Partial<DeploymentFile> = {}): DeploymentFile => ({
  name: "alpha",
  account_id: ACCOUNT,
  worker_name: "example-alpha",
  base_url: "https://example-alpha.acct.workers.dev",
  workers_dev: true,
  preview_urls: false,
  custom_domains: [],
  kv: { OAUTH_KV: "0123456789abcdef0123456789abcde1", TODO_CACHE: "0123456789abcdef0123456789abcde2" },
  r2: { BLOBS: "example-alpha-blobs" },
  vars: {},
  ...over,
});
const beta = (over: Partial<DeploymentFile> = {}): DeploymentFile =>
  dep({
    name: "beta",
    worker_name: "example-beta",
    base_url: "https://example-beta.acct.workers.dev",
    kv: { OAUTH_KV: "0123456789abcdef0123456789abcde3", TODO_CACHE: "0123456789abcdef0123456789abcde4" },
    r2: { BLOBS: "example-beta-blobs" },
    ...over,
  });
const BETA_FILE = "/repo/deployments/beta/deployment.jsonc";
const others = (d: DeploymentFile) => [{ file: BETA_FILE, dep: d }];
const refusal = (fn: () => unknown): DeploymentRefusal => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DeploymentRefusal);
    return e as DeploymentRefusal;
  }
  throw new Error("expected a DeploymentRefusal");
};

describe("normalizeHost", () => {
  it("lowercases and strips one trailing dot", () => {
    expect(normalizeHost("Mstdo.Example.COM.")).toBe("mstdo.example.com");
    expect(normalizeHost("a.example.com..")).toBe("a.example.com.");
  });
});

describe("checkBaseUrl", () => {
  const f = "deployments/alpha/deployment.jsonc";
  it("accepts the workers.dev host of this Worker when workers_dev is on", () => {
    expect(() => checkBaseUrl(dep(), f)).not.toThrow();
  });

  it.each([
    ["http scheme", "http://example-alpha.acct.workers.dev"],
    ["trailing slash", "https://example-alpha.acct.workers.dev/"],
    ["a path", "https://example-alpha.acct.workers.dev/path"],
    ["a query", "https://example-alpha.acct.workers.dev?q=1"],
    ["a port", "https://example-alpha.acct.workers.dev:8443"],
    ["not a URL", "https://"],
  ])("refuses a base_url with %s", (_label, base_url) => {
    const r = refusal(() => checkBaseUrl(dep({ base_url }), f));
    expect(r.field).toBe("base_url");
    expect(r.file).toBe(f);
  });

  it("accepts a host listed in custom_domains, ignoring case and a trailing dot", () => {
    const d = dep({ base_url: "https://mstdo.example.com", workers_dev: false, custom_domains: ["MSTDO.Example.com."] });
    expect(() => checkBaseUrl(d, f)).not.toThrow();
  });

  it("refuses workers.dev with workers_dev off", () => {
    expect(refusal(() => checkBaseUrl(dep({ workers_dev: false }), f)).field).toBe("base_url");
  });

  it("refuses a workers.dev host whose first label is another Worker's name", () => {
    const d = dep({ worker_name: "example-alpha", base_url: "https://example-beta.acct.workers.dev" });
    expect(refusal(() => checkBaseUrl(d, f)).field).toBe("base_url");
  });

  it("refuses a worker name that is only a prefix of the first label", () => {
    const d = dep({ worker_name: "example", base_url: "https://example-alpha.acct.workers.dev" });
    expect(refusal(() => checkBaseUrl(d, f)).field).toBe("base_url");
  });

  it("refuses a host that is neither listed nor workers.dev", () => {
    const d = dep({ base_url: "https://other.example.com", custom_domains: ["mstdo.example.com"] });
    expect(refusal(() => checkBaseUrl(d, f)).field).toBe("base_url");
  });

  it.each([
    ["a scheme", "https://mstdo.example.com"],
    ["a path", "mstdo.example.com/x"],
    ["a port", "mstdo.example.com:8443"],
    ["no dot", "localhost"],
    ["a wildcard", "*.example.com"],
    ["an underscore", "ms_tdo.example.com"],
  ])("refuses a custom domain with %s", (_label, domain) => {
    const d = dep({ custom_domains: ["ok.example.com", domain] });
    const r = refusal(() => checkBaseUrl(d, f));
    expect(r.field).toBe("custom_domains[1]");
    expect(r.file).toBe(f);
  });
});

describe("checkCrossFiles", () => {
  it("passes for two distinct deployments", () => {
    expect(() => checkCrossFiles(dep(), others(beta()))).not.toThrow();
  });

  it("skips the deployment itself", () => {
    expect(() => checkCrossFiles(dep(), [{ file: "/repo/deployments/alpha/deployment.jsonc", dep: dep() }])).not.toThrow();
  });

  it("refuses the same account and worker name, naming the other file", () => {
    const r = refusal(() => checkCrossFiles(dep(), others(beta({ worker_name: "example-alpha" }))));
    expect(r.field).toBe("worker_name");
    expect(r.message).toContain(BETA_FILE);
  });

  it("allows the same worker name in a different account", () => {
    expect(() =>
      checkCrossFiles(dep(), others(beta({ worker_name: "example-alpha", account_id: OTHER_ACCOUNT }))),
    ).not.toThrow();
  });

  it("refuses a KV namespace id shared under any binding", () => {
    const shared = dep().kv.OAUTH_KV;
    const r = refusal(() => checkCrossFiles(dep(), others(beta({ kv: { OAUTH_KV: "x1", TODO_CACHE: shared } }))));
    expect(r.field).toBe("kv.OAUTH_KV");
    expect(r.message).toContain(BETA_FILE);
  });

  it("refuses the same R2 bucket in the same account", () => {
    const r = refusal(() => checkCrossFiles(dep(), others(beta({ r2: { BLOBS: "example-alpha-blobs" } }))));
    expect(r.field).toBe("r2.BLOBS");
    expect(r.message).toContain(BETA_FILE);
  });

  it("allows the same R2 bucket name in different accounts", () => {
    expect(() =>
      checkCrossFiles(dep(), others(beta({ account_id: OTHER_ACCOUNT, r2: { BLOBS: "example-alpha-blobs" } }))),
    ).not.toThrow();
  });

  it("ignores a null R2 binding on both sides", () => {
    expect(() => checkCrossFiles(dep({ r2: { BLOBS: null } }), others(beta({ r2: { BLOBS: null } })))).not.toThrow();
  });

  it("refuses the same custom domain after normalization", () => {
    const r = refusal(() =>
      checkCrossFiles(dep({ custom_domains: ["a.example.com", "b.example.com"] }), others(beta({ custom_domains: ["B.Example.com."] }))),
    );
    expect(r.field).toBe("custom_domains[1]");
    expect(r.message).toContain(BETA_FILE);
  });

  it("refuses the same base_url", () => {
    const r = refusal(() => checkCrossFiles(dep(), others(beta({ base_url: dep().base_url }))));
    expect(r.field).toBe("base_url");
    expect(r.message).toContain(BETA_FILE);
  });
});

describe("checkAccountEnv", () => {
  it("passes when unset, empty, or equal", () => {
    expect(() => checkAccountEnv(dep(), {})).not.toThrow();
    expect(() => checkAccountEnv(dep(), { CLOUDFLARE_ACCOUNT_ID: "" })).not.toThrow();
    expect(() => checkAccountEnv(dep(), { CLOUDFLARE_ACCOUNT_ID: ACCOUNT })).not.toThrow();
  });

  it("refuses a different account, naming CLOUDFLARE_ACCOUNT_ID", () => {
    const r = refusal(() => checkAccountEnv(dep(), { CLOUDFLARE_ACCOUNT_ID: OTHER_ACCOUNT }));
    expect(r.field).toBe("CLOUDFLARE_ACCOUNT_ID");
  });
});

describe("loadAllDeployments", () => {
  const roots: string[] = [];
  const scratch = (): string => {
    const root = mkdtempSync(join(tmpdir(), "potem-checks-"));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const write = (root: string, name: string, text: string): string => {
    mkdirSync(join(root, "deployments", name), { recursive: true });
    const file = join(root, "deployments", name, "deployment.jsonc");
    writeFileSync(file, text);
    return file;
  };
  const body = (worker: string) => `{
    "account_id": "${ACCOUNT}", "worker_name": "${worker}",
    "base_url": "https://${worker}.acct.workers.dev", "workers_dev": true, "preview_urls": false,
    "kv": { "OAUTH_KV": "a1", "TODO_CACHE": "a2" }, "r2": { "BLOBS": null }
  }`;

  it("returns an empty list when there is no deployments directory", () => {
    expect(loadAllDeployments(scratch())).toEqual([]);
  });

  it("loads every deployment.jsonc, naming each by its folder, and skips folders without one", () => {
    const root = scratch();
    const a = write(root, "alpha", body("example-alpha"));
    const b = write(root, "beta", body("example-beta"));
    mkdirSync(join(root, "deployments", "empty"));
    const all = loadAllDeployments(root);
    expect(all.map((x) => [x.file, x.dep.name])).toEqual([
      [a, "alpha"],
      [b, "beta"],
    ]);
  });

  it("refuses naming the file that fails to parse", () => {
    const root = scratch();
    write(root, "alpha", body("example-alpha"));
    const bad = write(root, "broken", "{ not json");
    const r = refusal(() => loadAllDeployments(root));
    expect(r.file).toBe(bad);
  });
});
