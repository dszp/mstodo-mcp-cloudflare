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

export type DeploymentFile = {
  name: string;
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
};

export const DEPLOYMENT_NAME = /^[a-z0-9][a-z0-9-]*$/;

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const KNOWN_KEYS = new Set([
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

  const account_id = requiredString("account_id");
  if (!ACCOUNT_ID.test(account_id)) refuse("account_id", "must be 32 lowercase hex characters");
  const worker_name = requiredString("worker_name");
  const base_url = requiredString("base_url");
  if (!base_url.startsWith("https://")) refuse("base_url", "must be an https origin");
  const workers_dev = requiredBoolean("workers_dev");
  const preview_urls = requiredBoolean("preview_urls");
  const kv = stringMap<string>("kv", required("kv"), false);
  const r2 = stringMap<string | null>("r2", required("r2"), true);

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
  }

  const out: DeploymentFile = {
    name,
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
