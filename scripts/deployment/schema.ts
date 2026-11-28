// Parsing and validation of deployments/<name>/deployment.jsonc, the file that
// names what varies between deployments of this Worker. Hand-written on purpose:
// every refusal names the file and the field in one line, and the script that
// imports this runs on bare Node (type stripping), so the syntax here is erasable
// TypeScript only.
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { join } from "node:path";

export class DeploymentRefusal extends Error {
  readonly file: string;
  readonly field: string;
  constructor(file: string, field: string, reason: string) {
    super(`${file}: ${field}: ${reason}`);
    this.name = "DeploymentRefusal";
    this.file = file;
    this.field = field;
  }
}

// "server" is the MCP and sync server Worker; "web" is the web client Worker in
// workers/web. A file without `kind` is a server.
export type DeploymentKind = "server" | "web";

export type DeploymentFile = {
  name: string;
  kind: DeploymentKind;
  account_id: string;
  worker_name: string;
  base_url: string;
  workers_dev: boolean;
  preview_urls: boolean;
  custom_domains: string[];
  kv: Record<string, string>;
  r2: Record<string, string | null>;
  vars: Record<string, string>;
  op_account?: string;
  // web only: the server Worker the web Worker reaches through a service binding.
  server_service?: string;
};

export const DEPLOYMENT_NAME = /^[a-z0-9][a-z0-9-]*$/;

// An https origin as written in a config: no path, query, trailing slash or port.
export function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.port === "" && url.origin === value;
  } catch {
    return false;
  }
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const KNOWN_KEYS = new Set([
  "kind",
  "account_id",
  "worker_name",
  "base_url",
  "workers_dev",
  "preview_urls",
  "custom_domains",
  "kv",
  "r2",
  "vars",
  "op_account",
  "server_service",
]);

export function parseJsonc(text: string, file: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const e = errors[0];
    const before = text.slice(0, e.offset);
    const line = before.split("\n").length;
    const column = e.offset - before.lastIndexOf("\n");
    throw new DeploymentRefusal(file, "(syntax)", `${printParseErrorCode(e.error)} at line ${line}, column ${column}`);
  }
  return value;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseDeploymentFile(text: string, file: string, name: string): DeploymentFile {
  const refuse = (field: string, reason: string): never => {
    throw new DeploymentRefusal(file, field, reason);
  };
  if (!DEPLOYMENT_NAME.test(name)) refuse("name", `"${name}" must match ${DEPLOYMENT_NAME}`);

  const raw = parseJsonc(text, file);
  if (!isObject(raw)) return refuse("(root)", "must be a JSON object");

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) refuse(key, "unknown key");
  }

  const required = (key: string): unknown => {
    if (!(key in raw)) refuse(key, "required");
    return raw[key];
  };
  const requiredString = (key: string): string => {
    const v = required(key);
    if (typeof v !== "string" || v === "") refuse(key, "must be a non-empty string");
    return v as string;
  };
  const requiredBoolean = (key: string): boolean => {
    const v = required(key);
    if (typeof v !== "boolean") refuse(key, "must be true or false (a boolean, not a string)");
    return v as boolean;
  };
  const stringMap = <T extends string | null>(key: string, value: unknown, allowNull: boolean): Record<string, T> => {
    if (!isObject(value)) return refuse(key, "must be an object");
    for (const [k, v] of Object.entries(value)) {
      const ok = typeof v === "string" && v !== "" ? true : allowNull && v === null;
      if (!ok) refuse(`${key}.${k}`, allowNull ? "must be a non-empty string or null" : "must be a non-empty string");
    }
    return value as Record<string, T>;
  };

  let kind: DeploymentKind = "server";
  if ("kind" in raw) {
    if (raw.kind !== "server" && raw.kind !== "web") refuse("kind", 'must be "server" or "web"');
    kind = raw.kind as DeploymentKind;
  }
  if (kind === "server" && "server_service" in raw) refuse("server_service", 'only valid when kind is "web"');

  const account_id = requiredString("account_id");
  if (!ACCOUNT_ID.test(account_id)) refuse("account_id", "must be 32 lowercase hex characters");
  const worker_name = requiredString("worker_name");
  const base_url = requiredString("base_url");
  if (!base_url.startsWith("https://")) refuse("base_url", "must be an https origin");
  const workers_dev = requiredBoolean("workers_dev");
  const preview_urls = requiredBoolean("preview_urls");
  // A web Worker has no KV or R2 bindings; the keys may be left out or empty.
  const bindingMap = <T extends string | null>(key: string, allowNull: boolean): Record<string, T> => {
    if (kind === "server") return stringMap<T>(key, required(key), allowNull);
    if (!(key in raw)) return {};
    const v = stringMap<T>(key, raw[key], allowNull);
    if (Object.keys(v).length > 0) refuse(key, 'a web deployment has no bindings of this kind; leave it out or empty');
    return {};
  };
  const kv = bindingMap<string>("kv", false);
  const r2 = bindingMap<string | null>("r2", true);

  let custom_domains: string[] = [];
  if ("custom_domains" in raw) {
    const v = raw.custom_domains;
    if (!Array.isArray(v) || v.some((d) => typeof d !== "string" || d === "")) {
      refuse("custom_domains", "must be an array of non-empty hostnames");
    }
    custom_domains = v as string[];
  }

  let vars: Record<string, string> = {};
  if ("vars" in raw) {
    // The values are strings because wrangler vars here are strings; the render
    // step checks each key against the example's vars.
    vars = stringMap<string>("vars", raw.vars, false);
    if ("SERVICE_BASE_URL" in vars) refuse("vars.SERVICE_BASE_URL", "set base_url instead");
    if (kind === "web" && "WEB_ORIGIN" in vars) refuse("vars.WEB_ORIGIN", "set base_url instead");
  }
  if (kind === "web") {
    const origin = vars.SERVER_ORIGIN;
    if (origin === undefined) refuse("vars.SERVER_ORIGIN", "required: the https origin of the server this web client talks to");
    else if (!isHttpsOrigin(origin)) refuse("vars.SERVER_ORIGIN", "must be an https origin: no path, query, trailing slash or port");
  }

  const out: DeploymentFile = {
    name,
    kind,
    account_id,
    worker_name,
    base_url,
    workers_dev,
    preview_urls,
    custom_domains,
    kv,
    r2,
    vars,
  };
  if ("op_account" in raw) {
    if (typeof raw.op_account !== "string" || raw.op_account === "") refuse("op_account", "must be a non-empty string");
    out.op_account = raw.op_account as string;
  }
  if ("server_service" in raw) {
    const v = raw.server_service;
    if (typeof v !== "string" || !DEPLOYMENT_NAME.test(v)) {
      refuse("server_service", `must be a Worker name matching ${DEPLOYMENT_NAME}`);
    }
    // The service binding would point the web Worker at itself.
    if (v === worker_name) refuse("server_service", "must name the server Worker, not this web Worker's worker_name");
    out.server_service = v as string;
  }
  return out;
}

export function deploymentPaths(repoRoot: string, name: string) {
  const dir = join(repoRoot, "deployments", name);
  const renderDir = join(repoRoot, ".wrangler", "deployments", name);
  return {
    dir,
    file: join(dir, "deployment.jsonc"),
    devVars: join(dir, ".dev.vars"),
    lastDeployed: join(dir, "last-deployed.json"),
    renderDir,
    rendered: join(renderDir, "rendered.json"),
    resolvedDevVars: join(renderDir, ".dev.vars"),
    devLock: join(renderDir, "dev.lock"),
  };
}
