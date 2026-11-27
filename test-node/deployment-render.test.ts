import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DeploymentRefusal,
  deploymentPaths,
  parseDeploymentFile,
  parseJsonc,
  type DeploymentFile,
} from "../scripts/deployment/schema.ts";
import { findPlaceholders, loadAndRender, renderConfig, type WranglerConfig } from "../scripts/deployment/render.ts";

const repoRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const exampleText = readFileSync(join(repoRoot, "wrangler.example.jsonc"), "utf8");
const fixtureText = readFileSync(join(repoRoot, "test-node/fixtures/deployment-fixture.jsonc"), "utf8");
const example = () => parseJsonc(exampleText, "wrangler.example.jsonc") as WranglerConfig;
const fixture = (over: Partial<DeploymentFile> = {}): DeploymentFile => ({
  ...parseDeploymentFile(fixtureText, "fixture.jsonc", "fixture"),
  ...over,
});
const opts = { repoRoot, renderDir: join(repoRoot, ".wrangler", "deployments", "fixture"), file: "deployments/fixture/deployment.jsonc" };
const render = (dep: DeploymentFile = fixture()) => renderConfig(example(), dep, opts);
const refusal = (fn: () => unknown): DeploymentRefusal => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DeploymentRefusal);
    return e as DeploymentRefusal;
  }
  throw new Error("expected a DeploymentRefusal");
};

describe("renderConfig", () => {
  it("copies identity fields from the deployment file", () => {
    const out = render(fixture({ workers_dev: true, preview_urls: false }));
    expect(out.name).toBe("example-potem");
    expect(out.account_id).toBe("0123456789abcdef0123456789abcdef");
    expect((out.vars as Record<string, string>).SERVICE_BASE_URL).toBe("https://example-potem.example.workers.dev");
    expect(out.workers_dev).toBe(true);
    expect(out.preview_urls).toBe(false);
  });

  it("does not mutate the example", () => {
    const ex = example();
    const before = structuredClone(ex);
    renderConfig(ex, fixture(), opts);
    expect(ex).toEqual(before);
  });

  it("turns custom_domains into routes, and omits routes when there are none", () => {
    expect(render(fixture({ custom_domains: ["a.example.com"] })).routes).toEqual([
      { pattern: "a.example.com", custom_domain: true },
    ]);
    expect("routes" in render(fixture({ custom_domains: [] }))).toBe(false);
  });

  it("maps each KV binding to the deployment's namespace id", () => {
    const kv = render().kv_namespaces as Array<{ binding: string; id: string }>;
    const dep = fixture();
    for (const b of kv) expect(b.id, b.binding).toBe(dep.kv[b.binding]);
    expect(kv.map((b) => b.binding)).toEqual(["OAUTH_KV", "TODO_CACHE"]);
  });

  it("refuses a KV binding the deployment does not map", () => {
    const dep = fixture();
    const kv = { ...dep.kv };
    delete kv.OAUTH_KV;
    const r = refusal(() => render({ ...dep, kv }));
    expect(r.field).toBe("kv.OAUTH_KV");
    expect(r.file).toBe(opts.file);
  });

  it("refuses a KV key the example does not declare", () => {
    const dep = fixture();
    expect(refusal(() => render({ ...dep, kv: { ...dep.kv, EXTRA_KV: "0123" } })).field).toBe("kv.EXTRA_KV");
  });

  it("maps an R2 binding to the deployment's bucket", () => {
    const r2 = render(fixture({ r2: { BLOBS: "other-bucket" } })).r2_buckets;
    expect(r2).toEqual([{ binding: "BLOBS", bucket_name: "other-bucket" }]);
  });

  it("drops an R2 binding mapped to null, and r2_buckets when it empties", () => {
    expect("r2_buckets" in render(fixture({ r2: { BLOBS: null } }))).toBe(false);
  });

  it("refuses an R2 binding the deployment does not map", () => {
    expect(refusal(() => render(fixture({ r2: {} }))).field).toBe("r2.BLOBS");
  });

  it("refuses an R2 key the example does not declare", () => {
    expect(refusal(() => render(fixture({ r2: { BLOBS: "x", OTHER: "y" } }))).field).toBe("r2.OTHER");
  });

  it("overrides a var from the deployment file", () => {
    const vars = render(fixture({ vars: { ENABLE_MY_DAY: "true" } })).vars as Record<string, string>;
    expect(vars.ENABLE_MY_DAY).toBe("true");
    expect(vars.TIMEZONE).toBe((example().vars as Record<string, string>).TIMEZONE);
  });

  it("refuses an override for a var the example does not declare", () => {
    const r = refusal(() => render(fixture({ vars: { ENABLE_MY_DAAY: "true" } })));
    expect(r.field).toBe("vars.ENABLE_MY_DAAY");
    expect(r.file).toBe(opts.file);
  });

  it("rewrites main and $schema so they resolve from the render directory", () => {
    const out = render();
    expect(resolve(opts.renderDir, out.main as string)).toBe(join(repoRoot, "src/hosts/cloudflare/worker.ts"));
    expect(resolve(opts.renderDir, out.$schema as string)).toBe(
      join(repoRoot, "node_modules/wrangler/config-schema.json"),
    );
  });

  it("leaves structural sections identical to the example", () => {
    const out = render();
    const ex = example();
    for (const key of ["durable_objects", "migrations", "triggers", "compatibility_date", "compatibility_flags", "observability"]) {
      expect(out[key], key).toEqual(ex[key]);
    }
  });

  it("renders the real example with no placeholder left (drift guard)", () => {
    expect(findPlaceholders(render())).toEqual([]);
  });
});

describe("findPlaceholders", () => {
  it("lists account_id and both KV ids in the raw example", () => {
    const found = findPlaceholders(example());
    expect(found).toContain("account_id");
    expect(found).toContain("kv_namespaces[0].id");
    expect(found).toContain("kv_namespaces[1].id");
  });
});

describe("loadAndRender", () => {
  it("writes rendered.json under the repo's render directory and returns the config", () => {
    const root = mkdtempSync(join(tmpdir(), "potem-render-"));
    // A scratch repo root: only the example is needed.
    writeFileSync(join(root, "wrangler.example.jsonc"), exampleText);
    const out = loadAndRender(root, fixture({ name: "scratch" }));
    const p = deploymentPaths(root, "scratch").rendered;
    expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(out);
  });

  it("refuses with the first placeholder path when one survives", () => {
    const root = mkdtempSync(join(tmpdir(), "potem-render-"));
    writeFileSync(join(root, "wrangler.example.jsonc"), exampleText.replace(/"vars": \{/, '"vars": { "NOTE": "<your-thing>",'));
    const r = refusal(() => loadAndRender(root, fixture({ name: "scratch" })));
    expect(r.field).toBe("vars.NOTE");
    expect(existsSync(deploymentPaths(root, "scratch").rendered)).toBe(false);
  });
});
