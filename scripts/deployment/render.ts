// Renders the wrangler config for one named deployment from the committed
// wrangler.example.jsonc plus that deployment's deployment.jsonc. The example stays
// the single source of structure (bindings, migrations, vars, crons); the deployment
// file only supplies what differs. Erasable TypeScript only: this runs on bare Node.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DeploymentRefusal, deploymentPaths, parseJsonc, type DeploymentFile } from "./schema.ts";

export type WranglerConfig = Record<string, unknown>;

type Opts = { repoRoot: string; renderDir: string; file: string };
type Binding = Record<string, unknown>;

const PLACEHOLDER = "<your-";

// The server Worker's example config. Its `main` and `$schema` are relative to its own directory.
export const SERVER_EXAMPLE = "workers/server/wrangler.example.jsonc";

export function renderConfig(example: WranglerConfig, dep: DeploymentFile, opts: Opts): WranglerConfig {
  const refuse = (field: string, reason: string): never => {
    throw new DeploymentRefusal(opts.file, field, reason);
  };
  if (typeof example.main !== "string") refuse("main", "wrangler.example.jsonc must set main to a string");
  const out = structuredClone(example);

  out.name = dep.worker_name;
  out.account_id = dep.account_id;
  out.workers_dev = dep.workers_dev;
  out.preview_urls = dep.preview_urls;

  // wrangler resolves `main` relative to the config file, which now lives in renderDir.
  // The example's own paths are relative to the example's directory.
  const exampleDir = dirname(join(opts.repoRoot, SERVER_EXAMPLE));
  out.main = relative(opts.renderDir, join(exampleDir, String(example.main)));
  if (typeof example.$schema === "string") {
    out.$schema = relative(opts.renderDir, join(exampleDir, example.$schema));
  }

  // The deployment file is the only source of routes; one the example carries
  // would attach this Worker to somebody else's hostname.
  if (dep.custom_domains.length > 0) {
    out.routes = dep.custom_domains.map((pattern) => ({ pattern, custom_domain: true }));
  } else {
    delete out.routes;
  }

  const kv = (out.kv_namespaces ?? []) as Binding[];
  const kvNames = new Set(kv.map((b) => String(b.binding)));
  for (const key of Object.keys(dep.kv)) {
    if (!kvNames.has(key)) refuse(`kv.${key}`, "the example declares no KV binding with this name");
  }
  for (const b of kv) {
    const id = dep.kv[String(b.binding)];
    if (id === undefined) refuse(`kv.${String(b.binding)}`, "required: the example declares this KV binding");
    b.id = id;
  }

  const r2 = (out.r2_buckets ?? []) as Binding[];
  const r2Names = new Set(r2.map((b) => String(b.binding)));
  for (const key of Object.keys(dep.r2)) {
    if (!r2Names.has(key)) refuse(`r2.${key}`, "the example declares no R2 binding with this name");
  }
  const keptR2: Binding[] = [];
  for (const b of r2) {
    const name = String(b.binding);
    if (!Object.hasOwn(dep.r2, name)) refuse(`r2.${name}`, "required: a bucket name, or null to leave this binding out");
    const bucket = dep.r2[name];
    if (bucket === null) continue;
    keptR2.push({ ...b, bucket_name: bucket });
  }
  if (keptR2.length > 0) out.r2_buckets = keptR2;
  else delete out.r2_buckets;

  const vars = (out.vars ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(dep.vars)) {
    if (!Object.hasOwn(vars, key)) refuse(`vars.${key}`, "the example declares no var with this name");
    vars[key] = value;
  }
  vars.SERVICE_BASE_URL = dep.base_url;
  out.vars = vars;

  return out;
}

export function findPlaceholders(config: WranglerConfig): string[] {
  const found: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (value.includes(PLACEHOLDER)) found.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) walk(v, path === "" ? k : `${path}.${k}`);
    }
  };
  walk(config, "");
  return found;
}

// Renders in memory only. rendered.json is what direct wrangler commands are
// pointed at, so the CLI writes it (writeRender) only once every check passed.
export function loadAndRender(repoRoot: string, dep: DeploymentFile): WranglerConfig {
  const paths = deploymentPaths(repoRoot, dep.name);
  const examplePath = join(repoRoot, SERVER_EXAMPLE);
  const example = parseJsonc(readFileSync(examplePath, "utf8"), examplePath) as WranglerConfig;
  const rendered = renderConfig(example, dep, { repoRoot, renderDir: paths.renderDir, file: paths.file });
  const placeholders = findPlaceholders(rendered);
  if (placeholders.length > 0) {
    throw new DeploymentRefusal(paths.file, placeholders[0], "still holds an example placeholder; the deployment file must supply it");
  }
  return rendered;
}

export function writeRender(repoRoot: string, name: string, rendered: WranglerConfig): void {
  const paths = deploymentPaths(repoRoot, name);
  mkdirSync(paths.renderDir, { recursive: true });
  writeFileSync(paths.rendered, `${JSON.stringify(rendered, null, 2)}\n`);
}

export function removeRender(repoRoot: string, name: string): void {
  rmSync(deploymentPaths(repoRoot, name).rendered, { force: true });
}
