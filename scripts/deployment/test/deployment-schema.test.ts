import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  DEPLOYMENT_NAME,
  DeploymentRefusal,
  deploymentPaths,
  parseDeploymentFile,
  parseJsonc,
} from "../schema.ts";

const root = new URL("../../../", import.meta.url).pathname;

describe("deployment files stay out of git", () => {
  const paths = [
    "deployments/x/deployment.jsonc",
    "deployments/x/.dev.vars",
    "deployments/x/last-deployed.json",
    ".wrangler/deployments/x/rendered.json",
  ];
  for (const path of paths) {
    it(`ignores ${path}`, () => {
      const r = spawnSync("git", ["check-ignore", "-q", path], { cwd: root });
      expect(r.status, `git check-ignore ${path}`).toBe(0);
    });
  }
});

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const valid = {
  account_id: ACCOUNT,
  worker_name: "potem-test",
  base_url: "https://todo.example.test",
  workers_dev: false,
  preview_urls: true,
  kv: { OAUTH_KV: "kv-id-oauth", TODO_CACHE: "kv-id-cache" },
  r2: { BLOBS: "test-blobs" },
};
const text = (o: object) => JSON.stringify(o);
const parse = (o: object) => parseDeploymentFile(text(o), "deployments/t/deployment.jsonc", "t");
const without = (key: string) => {
  const { [key]: _omitted, ...rest } = valid as Record<string, unknown>;
  return rest;
};
function refusal(fn: () => unknown): DeploymentRefusal {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DeploymentRefusal);
    return e as DeploymentRefusal;
  }
  throw new Error("expected a DeploymentRefusal");
}

describe("parseDeploymentFile", () => {
  it("accepts comments and trailing commas, and defaults custom_domains and vars", () => {
    const src = `{
      // the account
      "account_id": "${ACCOUNT}",
      "worker_name": "potem-test", /* inline */
      "base_url": "https://todo.example.test",
      "workers_dev": false,
      "preview_urls": true,
      "kv": { "OAUTH_KV": "kv-id-oauth", },
      "r2": { "BLOBS": null, },
    }`;
    const d = parseDeploymentFile(src, "f", "t");
    expect(d).toEqual({
      name: "t",
      kind: "server",
      account_id: ACCOUNT,
      worker_name: "potem-test",
      base_url: "https://todo.example.test",
      workers_dev: false,
      preview_urls: true,
      custom_domains: [],
      kv: { OAUTH_KV: "kv-id-oauth" },
      r2: { BLOBS: null },
      vars: {},
    });
  });

  it("keeps the optional fields when present", () => {
    const d = parse({ ...valid, custom_domains: ["todo.example.test"], vars: { TIMEZONE: "UTC" }, op_account: "acct" });
    expect(d.custom_domains).toEqual(["todo.example.test"]);
    expect(d.vars).toEqual({ TIMEZONE: "UTC" });
    expect(d.op_account).toBe("acct");
  });

  const refusals: [string, object, string][] = [
    ["an unknown key", { ...valid, acount_id: ACCOUNT }, "acount_id"],
    ["a missing account_id", without("account_id"), "account_id"],
    ["an account_id that is not 32 hex", { ...valid, account_id: "abc" }, "account_id"],
    ["a missing worker_name", without("worker_name"), "worker_name"],
    ["a missing base_url", without("base_url"), "base_url"],
    ["a base_url that is not https", { ...valid, base_url: "http://todo.example.test" }, "base_url"],
    ["a missing workers_dev", without("workers_dev"), "workers_dev"],
    ["a string workers_dev", { ...valid, workers_dev: "true" }, "workers_dev"],
    ["a missing preview_urls", without("preview_urls"), "preview_urls"],
    ["a missing kv", without("kv"), "kv"],
    ["a missing r2", without("r2"), "r2"],
    ["a non-string kv id", { ...valid, kv: { OAUTH_KV: 5 } }, "kv.OAUTH_KV"],
    ["a numeric r2 bucket", { ...valid, r2: { BLOBS: 5 } }, "r2.BLOBS"],
    ["custom_domains that is not an array of strings", { ...valid, custom_domains: [1] }, "custom_domains"],
    ["SERVICE_BASE_URL in vars", { ...valid, vars: { SERVICE_BASE_URL: "https://x.example.test" } }, "vars.SERVICE_BASE_URL"],
    ["a non-string var value", { ...valid, vars: { TIMEZONE: 5 } }, "vars.TIMEZONE"],
    ["a non-string op_account", { ...valid, op_account: 5 }, "op_account"],
  ];
  for (const [label, input, field] of refusals) {
    it(`refuses ${label}`, () => {
      const r = refusal(() => parse(input));
      expect(r.field).toBe(field);
      expect(r.file).toBe("deployments/t/deployment.jsonc");
      expect(r.message).toContain("deployments/t/deployment.jsonc");
      expect(r.message).toContain(field);
      expect(r.message).not.toContain("\n");
    });
  }

  describe("kind", () => {
    const web = {
      account_id: ACCOUNT,
      worker_name: "potem-web-test",
      base_url: "https://web.example.test",
      workers_dev: false,
      preview_urls: false,
      vars: { SERVER_ORIGIN: "https://todo.example.test" },
    };

    it("defaults to server and accepts kind: server", () => {
      expect(parse(valid).kind).toBe("server");
      expect(parse({ ...valid, kind: "server" }).kind).toBe("server");
    });

    it("accepts kind: web with no kv or r2, and returns them empty", () => {
      const d = parse({ ...web, kind: "web" });
      expect(d.kind).toBe("web");
      expect(d.kv).toEqual({});
      expect(d.r2).toEqual({});
      expect(d.server_service).toBeUndefined();
    });

    it("accepts empty kv and r2 objects for web", () => {
      expect(parse({ ...web, kind: "web", kv: {}, r2: {} }).kind).toBe("web");
    });

    it("keeps server_service for web", () => {
      expect(parse({ ...web, kind: "web", server_service: "potem-server" }).server_service).toBe("potem-server");
    });

    const refusals: [string, object, string][] = [
      ["a kind that is neither server nor web", { ...valid, kind: "other" }, "kind"],
      ["a non-string kind", { ...valid, kind: 1 }, "kind"],
      ["a kv entry on a web file", { ...web, kind: "web", kv: { OAUTH_KV: "kv-id" } }, "kv"],
      ["an r2 entry on a web file", { ...web, kind: "web", r2: { BLOBS: null } }, "r2"],
      ["server_service on a server file", { ...valid, server_service: "potem-server" }, "server_service"],
      ["a server_service that is not a Worker name", { ...web, kind: "web", server_service: "Not A Name" }, "server_service"],
      ["a web file without SERVER_ORIGIN", { ...web, kind: "web", vars: {} }, "vars.SERVER_ORIGIN"],
      ["a web file without vars", { ...web, kind: "web", vars: undefined }, "vars.SERVER_ORIGIN"],
      ["a SERVER_ORIGIN that is not an https origin", { ...web, kind: "web", vars: { SERVER_ORIGIN: "http://todo.example.test" } }, "vars.SERVER_ORIGIN"],
      ["a SERVER_ORIGIN with a path", { ...web, kind: "web", vars: { SERVER_ORIGIN: "https://todo.example.test/app" } }, "vars.SERVER_ORIGIN"],
      ["a SERVER_ORIGIN with a trailing slash", { ...web, kind: "web", vars: { SERVER_ORIGIN: "https://todo.example.test/" } }, "vars.SERVER_ORIGIN"],
      ["a SERVER_ORIGIN with a port", { ...web, kind: "web", vars: { SERVER_ORIGIN: "https://todo.example.test:8443" } }, "vars.SERVER_ORIGIN"],
      ["WEB_ORIGIN in vars", { ...web, kind: "web", vars: { ...web.vars, WEB_ORIGIN: "https://web.example.test" } }, "vars.WEB_ORIGIN"],
      ["a missing kv on a server file", { ...without("kv"), kind: "server" }, "kv"],
    ];
    for (const [label, input, field] of refusals) {
      it(`refuses ${label}`, () => {
        const r = refusal(() => parse(input));
        expect(r.field).toBe(field);
        expect(r.message).toContain(field);
      });
    }
  });

  it("refuses a file that is not an object", () => {
    expect(refusal(() => parseDeploymentFile("[]", "f", "t")).field).toBe("(root)");
  });
});

describe("parseJsonc", () => {
  it("refuses a syntax error under the (syntax) field", () => {
    const r = refusal(() => parseJsonc("{ \"a\": ", "f.jsonc"));
    expect(r.field).toBe("(syntax)");
    expect(r.file).toBe("f.jsonc");
  });
});

describe("DEPLOYMENT_NAME", () => {
  for (const bad of ["Prod", "../x", "-x", ""]) {
    it(`rejects ${JSON.stringify(bad)}`, () => expect(DEPLOYMENT_NAME.test(bad)).toBe(false));
  }
  it("accepts second-tenant", () => expect(DEPLOYMENT_NAME.test("second-tenant")).toBe(true));
});

describe("deploymentPaths", () => {
  const p = deploymentPaths("/r", "sv");
  it("puts operator files under deployments/<name>", () => {
    expect(p.dir).toBe("/r/deployments/sv");
    expect(p.file).toBe("/r/deployments/sv/deployment.jsonc");
    expect(p.devVars).toBe("/r/deployments/sv/.dev.vars");
    expect(p.lastDeployed).toBe("/r/deployments/sv/last-deployed.json");
  });
  it("puts generated files under .wrangler/deployments/<name>", () => {
    expect(p.renderDir).toBe("/r/.wrangler/deployments/sv");
    expect(p.rendered).toBe("/r/.wrangler/deployments/sv/rendered.json");
    expect(p.resolvedDevVars).toBe("/r/.wrangler/deployments/sv/.dev.vars");
    expect(p.devLock).toBe("/r/.wrangler/deployments/sv/dev.lock");
  });
});
