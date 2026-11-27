import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DeploymentRefusal, deploymentPaths } from "./schema.ts";
import type { Runner } from "./runner.ts";

// Keep in sync with .dev.vars.example.
export const SECRET_NAMES: readonly string[] = [
  "MS_TENANT_ID",
  "MS_CLIENT_ID",
  "MS_CLIENT_SECRET",
  "OWNER_EMAIL",
  "OWNER_OBJECT_ID",
];

// Value after the first `=` on the first line that starts with `NAME=`. CRLF is
// tolerated and one pair of matching surrounding quotes is stripped, matching
// how wrangler parses .dev.vars and what the old push-secrets.sh did.
export function readDevVar(text: string, name: string): string | undefined {
  const prefix = `${name}=`;
  for (const raw of text.split("\n")) {
    if (!raw.startsWith(prefix)) continue;
    let value = raw.slice(prefix.length);
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (value.length >= 2) {
      const q = value[0];
      if ((q === '"' || q === "'") && value[value.length - 1] === q) value = value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

// op:// references are read through the op CLI; literals pass through. The
// refusal names the reference only: neither op's output nor its stderr is
// echoed, because a failed `op read` is not guaranteed to be free of values.
export async function resolveSecret(
  value: string,
  opAccount: string | undefined,
  run: Runner,
): Promise<string> {
  if (!value.startsWith("op://")) return value;
  const args = ["read", ...(opAccount ? ["--account", opAccount] : []), value];
  const r = await run("op", args);
  if (r.code !== 0) {
    throw new DeploymentRefusal(
      "(op)",
      value,
      `op read failed (exit ${r.code}); is op installed and signed in?`,
    );
  }
  // Strip exactly one trailing newline: the value may legitimately end in others.
  let out = r.stdout;
  if (out.endsWith("\n")) {
    out = out.slice(0, -1);
    if (out.endsWith("\r")) out = out.slice(0, -1);
  }
  return out;
}

// wrangler reads .dev.vars with dotenv 16.3.1, which never unescapes \" or \\:
// a quoted value is taken raw between its delimiters. So the delimiter is chosen
// to be absent from the value rather than escaping inside it. Only double quotes
// trigger dotenv's \n and \r unescaping, hence the preference order.
function quote(name: string, value: string): string {
  const refuse = (reason: string): never => {
    throw new DeploymentRefusal("(dev vars)", name, reason);
  };
  if (value.includes("\r")) refuse("value contains a carriage return, which .dev.vars cannot hold");
  const delim = ["'", "`", '"'].find((d) => !value.includes(d));
  if (delim === undefined) refuse("value contains all of ' ` and \", which .dev.vars cannot quote");
  if (delim === '"' && /\\[nr]/.test(value)) {
    refuse("value contains a backslash-n or backslash-r sequence and needs double quotes, which .dev.vars would rewrite");
  }
  return `${delim}${value}${delim}`;
}

// Copy of dotenv 16.3.1's parse as bundled in wrangler (the LINE regex and the
// quote handling), used to prove the file round-trips before it is written.
const DOTENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;
function dotenvParse(src: string): Record<string, string> {
  const obj: Record<string, string> = {};
  const text = src.replace(/\r\n?/gm, "\n");
  const re = new RegExp(DOTENV_LINE.source, DOTENV_LINE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let v = (m[2] ?? "").trim();
    const q = v[0];
    v = v.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
    if (q === '"') v = v.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    obj[m[1]!] = v;
  }
  return obj;
}

// The one place a resolved secret touches disk. The directory is 0700 and the
// file is created 0600 at open, so the value is never readable by another user.
export function writeResolvedDevVars(path: string, entries: [string, string][]): void {
  const content = entries.map(([k, v]) => `${k}=${quote(k, v)}\n`).join("");
  // A backslash before the closing quote can swallow it in dotenv's regex and
  // run into a later line; check every entry survives instead of reasoning about it.
  const parsed = dotenvParse(content);
  for (const [k, v] of entries) {
    if (parsed[k] !== v) throw new DeploymentRefusal("(dev vars)", k, "value does not survive wrangler's .dev.vars parsing");
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  rmSync(path, { force: true });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, content);
  } catch (e) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw e;
  }
  closeSync(fd);
}

export function removeResolvedDevVars(path: string): void {
  rmSync(path, { force: true });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

// True when a live process holds the lock: its resolved .dev.vars is in use.
export function devLockHeld(lockPath: string): boolean {
  let pid = NaN;
  try {
    pid = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
  } catch {
    return false;
  }
  return Number.isInteger(pid) && pid > 0 && alive(pid);
}

// A crash, SIGKILL or closed terminal during `dev` can leave resolved secrets on
// disk, for any deployment. Every command removes each one whose dev lock is not
// held by a live process, not only the named deployment's.
export function sweepResolvedDevVars(repoRoot: string): void {
  let entries;
  try {
    entries = readdirSync(join(repoRoot, ".wrangler", "deployments"), { withFileTypes: true });
  } catch {
    return; // nothing rendered yet
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const p = deploymentPaths(repoRoot, entry.name);
    if (!devLockHeld(p.devLock)) removeResolvedDevVars(p.resolvedDevVars);
  }
}

// One `dev` per deployment. The lock holds the pid; a dead pid is replaced.
export function acquireDevLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const refuse = (): never => {
    throw new DeploymentRefusal(lockPath, "(lock)", `dev already running for ${basename(lockPath, ".lock")}`);
  };
  const create = (): boolean => {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };
  if (!create()) {
    // A vanished, unreadable or dead-pid lock is stale.
    if (devLockHeld(lockPath)) refuse();
    rmSync(lockPath, { force: true });
    if (!create()) refuse();
  }
  return () => {
    try {
      if (readFileSync(lockPath, "utf8") === String(process.pid)) rmSync(lockPath, { force: true });
    } catch {
      // already gone
    }
  };
}
