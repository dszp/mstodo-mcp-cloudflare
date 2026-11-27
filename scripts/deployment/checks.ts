// Identity checks that need no network: the base URL belongs to this deployment,
// no two deployment files collide, and the shell's account matches the file's.
// Erasable TypeScript only: this runs on bare Node.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DeploymentRefusal, deploymentPaths, parseDeploymentFile, type DeploymentFile } from "./schema.ts";

export type LoadedDeployment = { file: string; dep: DeploymentFile };

const BARE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const WORKERS_DEV_HOST = /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/;

export function normalizeHost(h: string): string {
  const lower = h.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

// The deployment's own file path, for refusals raised without one (the cross-file
// and environment checks). The folder name is the deployment name.
const ownFile = (dep: DeploymentFile): string => `deployments/${dep.name}/deployment.jsonc`;

export function checkBaseUrl(dep: DeploymentFile, file: string): void {
  const refuse = (field: string, reason: string): never => {
    throw new DeploymentRefusal(file, field, reason);
  };
  const domains = dep.custom_domains.map((d, i) => {
    const host = normalizeHost(d);
    if (!BARE_HOST.test(host)) {
      refuse(`custom_domains[${i}]`, "must be a bare hostname (letters, digits, hyphens and dots; no scheme, path or port)");
    }
    if (host !== d) {
      refuse(`custom_domains[${i}]`, `must be written in canonical form (lowercase, no trailing dot): ${host}`);
    }
    return host;
  });

  let url: URL | undefined;
  try {
    url = new URL(dep.base_url);
  } catch {
    // refused below
  }
  if (url === undefined || url.protocol !== "https:" || url.port !== "" || url.origin !== dep.base_url) {
    return refuse("base_url", "must be an https origin: no path, query, trailing slash or port");
  }

  const host = url.hostname;
  if (domains.includes(host)) return;
  if (dep.workers_dev) {
    const m = WORKERS_DEV_HOST.exec(host);
    if (m !== null && m[1] === dep.worker_name) return;
  }
  return refuse(
    "base_url",
    `host ${host} is not served by this deployment: list it in custom_domains, or set workers_dev and use <worker_name>.<subdomain>.workers.dev`,
  );
}

// Origin form of a base_url so a case variant still collides; a value that is not
// a parseable URL is compared raw.
const canonicalUrl = (u: string): string => {
  try {
    return new URL(u).origin;
  } catch {
    return u;
  }
};

export function checkCrossFiles(dep: DeploymentFile, others: LoadedDeployment[]): void {
  const file = ownFile(dep);
  for (const { file: otherFile, dep: o } of others) {
    if (o.name === dep.name) continue;
    const refuse = (field: string, what: string): never => {
      throw new DeploymentRefusal(file, field, `${what} as ${otherFile}`);
    };
    if (o.account_id === dep.account_id && o.worker_name === dep.worker_name) {
      refuse("worker_name", "same account and worker name");
    }
    for (const [binding, id] of Object.entries(dep.kv)) {
      if (Object.values(o.kv).includes(id)) refuse(`kv.${binding}`, "same KV namespace id");
    }
    if (o.account_id === dep.account_id) {
      const theirs = Object.values(o.r2);
      for (const [binding, bucket] of Object.entries(dep.r2)) {
        if (bucket !== null && theirs.includes(bucket)) refuse(`r2.${binding}`, "same R2 bucket in the same account");
      }
    }
    const theirDomains = o.custom_domains.map(normalizeHost);
    dep.custom_domains.forEach((d, i) => {
      if (theirDomains.includes(normalizeHost(d))) refuse(`custom_domains[${i}]`, "same custom domain");
    });
    if (canonicalUrl(o.base_url) === canonicalUrl(dep.base_url)) refuse("base_url", "same base_url");
  }
}

export function checkAccountEnv(dep: DeploymentFile, env: Record<string, string | undefined>): void {
  const set = env.CLOUDFLARE_ACCOUNT_ID;
  if (set !== undefined && set !== "" && set !== dep.account_id) {
    throw new DeploymentRefusal(
      ownFile(dep),
      "CLOUDFLARE_ACCOUNT_ID",
      "the environment names a different account than this deployment's account_id; unset it",
    );
  }
}

export function loadAllDeployments(repoRoot: string): LoadedDeployment[] {
  const root = join(repoRoot, "deployments");
  if (!existsSync(root)) return [];
  const out: LoadedDeployment[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    // statSync follows a symlinked deployment folder; a dirent does not.
    if (!statSync(join(root, entry.name), { throwIfNoEntry: false })?.isDirectory()) continue;
    const file = deploymentPaths(repoRoot, entry.name).file;
    if (!existsSync(file)) continue;
    out.push({ file, dep: parseDeploymentFile(readFileSync(file, "utf8"), file, entry.name) });
  }
  return out;
}
