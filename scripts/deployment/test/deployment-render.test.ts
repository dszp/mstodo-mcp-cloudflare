import { afterEach, describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DeploymentRefusal,
  deploymentPaths,
  parseDeploymentFile,
  parseJsonc,
  type DeploymentFile,
} from "../schema.ts";
import {
  SERVER_EXAMPLE,
  WEB_EXAMPLE,
  exampleFor,
  findPlaceholders,
  loadAndRender,
  removeRender,
  renderConfig,
  writeRender,
  type WranglerConfig,
} from "../render.ts";

const repoRoot = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const exampleText = readFileSync(join(repoRoot, "workers/server/wrangler.example.jsonc"), "utf8");
const fixtureText = readFileSync(join(repoRoot, "scripts/deployment/test/fixtures/deployment-fixture.jsonc"), "utf8");
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

  it("deletes routes the example carries when the deployment has no custom domains", () => {
    const ex = { ...example(), routes: [{ pattern: "example-other.test", custom_domain: true }] };
    expect("routes" in renderConfig(ex, fixture({ custom_domains: [] }), opts)).toBe(false);
  });

  it("refuses an example without a string main", () => {
    const ex = example();
    delete ex.main;
    const r = refusal(() => renderConfig(ex, fixture(), opts));
    expect(r.field).toBe("main");
    expect(r.file).toBe(opts.file);
  });

  it("refuses an r2 override named after an inherited property", () => {
    const r = refusal(() => render(fixture({ r2: { BLOBS: "example-blobs", toString: "x" } })));
    expect(r.field).toBe("r2.toString");
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

  it("refuses a var override named after an inherited property", () => {
    const r = refusal(() => render(fixture({ vars: { toString: "x" } })));
    expect(r.field).toBe("vars.toString");
  });

  it("resolves main relative to the server example's directory", () => {
    const out = render();
    expect(resolve(opts.renderDir, out.main as string)).toBe(join(repoRoot, "workers/server/src/hosts/cloudflare/worker.ts"));
  });

  it("rewrites main and $schema so they resolve from the render directory", () => {
    const out = render();
    expect(resolve(opts.renderDir, out.main as string)).toBe(join(repoRoot, "workers/server/src/hosts/cloudflare/worker.ts"));
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

const webExampleText = readFileSync(join(repoRoot, "workers/web/wrangler.example.jsonc"), "utf8");
const webExample = () => parseJsonc(webExampleText, "workers/web/wrangler.example.jsonc") as WranglerConfig;
const webDep = (over: Partial<DeploymentFile> = {}): DeploymentFile => ({
  name: "fixture",
  kind: "web",
  account_id: "0123456789abcdef0123456789abcdef",
  worker_name: "example-potem-web",
  base_url: "https://example-potem-web.example.workers.dev",
  workers_dev: true,
  preview_urls: false,
  custom_domains: [],
  kv: {},
  r2: {},
  vars: { SERVER_ORIGIN: "https://example-potem.example.workers.dev" },
  ...over,
});
const renderWeb = (dep: DeploymentFile = webDep()) => renderConfig(webExample(), dep, opts);

describe("exampleFor", () => {
  it("names the example each kind renders from", () => {
    expect(exampleFor("server")).toBe(SERVER_EXAMPLE);
    expect(exampleFor("web")).toBe(WEB_EXAMPLE);
    expect(WEB_EXAMPLE).toBe("workers/web/wrangler.example.jsonc");
  });
});

describe("renderConfig for a web deployment", () => {
  it("resolves main and assets.directory against the web example's directory", () => {
    const out = renderWeb();
    expect(resolve(opts.renderDir, out.main as string)).toBe(join(repoRoot, "workers/web/src/hosts/cloudflare/worker.ts"));
    const assets = out.assets as Record<string, unknown>;
    expect(resolve(opts.renderDir, assets.directory as string)).toBe(join(repoRoot, "workers/web/dist"));
    expect(assets.binding).toBe("ASSETS");
    expect(assets.run_worker_first).toBe(true);
  });

  it("points $schema at wrangler's schema from the render directory", () => {
    const out = renderWeb();
    expect(resolve(opts.renderDir, out.$schema as string)).toBe(join(repoRoot, "node_modules/wrangler/config-schema.json"));
  });

  it("sets WEB_ORIGIN from base_url and leaves no SERVICE_BASE_URL", () => {
    const vars = renderWeb().vars as Record<string, string>;
    expect(vars.WEB_ORIGIN).toBe("https://example-potem-web.example.workers.dev");
    expect("SERVICE_BASE_URL" in vars).toBe(false);
    expect(vars.SERVER_ORIGIN).toBe("https://example-potem.example.workers.dev");
    expect(vars.WEB_SESSION_MAX_HOURS).toBe("12");
  });

  it("carries the identity fields and no KV or R2 bindings", () => {
    const out = renderWeb();
    expect(out.name).toBe("example-potem-web");
    expect(out.account_id).toBe("0123456789abcdef0123456789abcdef");
    expect("kv_namespaces" in out).toBe(false);
    expect("r2_buckets" in out).toBe(false);
  });

  it("renders services only when server_service is set", () => {
    expect("services" in renderWeb()).toBe(false);
    expect(renderWeb(webDep({ server_service: "example-potem" })).services).toEqual([
      { binding: "SERVER", service: "example-potem" },
    ]);
  });

  it("keeps the build command, which wrangler runs from the repository root", () => {
    expect((renderWeb().build as Record<string, unknown>).command).toBe("npm run web:build");
  });

  it("refuses a kv or r2 entry the web example has no binding for", () => {
    expect(refusal(() => renderWeb(webDep({ kv: { OAUTH_KV: "id" } }))).field).toBe("kv.OAUTH_KV");
    expect(refusal(() => renderWeb(webDep({ r2: { BLOBS: null } }))).field).toBe("r2.BLOBS");
  });

  it("leaves SERVER_ORIGIN as a placeholder when the deployment forgot it", () => {
    const out = renderWeb(webDep({ vars: {} }));
    expect(findPlaceholders(out)).toEqual(["vars.SERVER_ORIGIN"]);
  });
});

describe("loadAndRender by kind", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  it("reads the web example for a web deployment and refuses a forgotten SERVER_ORIGIN", () => {
    const root = mkdtempSync(join(tmpdir(), "potem-render-web-"));
    roots.push(root);
    mkdirSync(join(root, "workers/web"), { recursive: true });
    writeFileSync(join(root, "workers/web/wrangler.example.jsonc"), webExampleText);
    expect(loadAndRender(root, webDep({ name: "scratch" })).name).toBe("example-potem-web");
    const r = refusal(() => loadAndRender(root, webDep({ name: "scratch", vars: {} })));
    expect(r.field).toBe("vars.SERVER_ORIGIN");
  });
});

describe("loadAndRender", () => {
  const scratch: string[] = [];
  const scratchRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "potem-render-"));
    scratch.push(root);
    return root;
  };
  const putExample = (root: string, text: string) => {
    mkdirSync(join(root, "workers/server"), { recursive: true });
    writeFileSync(join(root, "workers/server/wrangler.example.jsonc"), text);
  };
  afterEach(() => {
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("returns the config without writing anything", () => {
    const root = scratchRoot();
    // A scratch repo root: only the example is needed.
    putExample(root, exampleText);
    const out = loadAndRender(root, fixture({ name: "scratch" }));
    expect(out.name).toBe(fixture().worker_name);
    expect(existsSync(deploymentPaths(root, "scratch").renderDir)).toBe(false);
  });

  it("writeRender puts rendered.json under the repo's render directory; removeRender deletes it", () => {
    const root = scratchRoot();
    putExample(root, exampleText);
    const out = loadAndRender(root, fixture({ name: "scratch" }));
    writeRender(root, "scratch", out);
    const p = deploymentPaths(root, "scratch").rendered;
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(out);
    removeRender(root, "scratch");
    expect(existsSync(p)).toBe(false);
    removeRender(root, "scratch");
  });

  it("refuses with the first placeholder path when one survives", () => {
    const root = scratchRoot();
    putExample(root, exampleText.replace(/"vars": \{/, '"vars": { "NOTE": "<your-thing>",'));
    const r = refusal(() => loadAndRender(root, fixture({ name: "scratch" })));
    expect(r.field).toBe("vars.NOTE");
    expect(existsSync(deploymentPaths(root, "scratch").rendered)).toBe(false);
  });
});
