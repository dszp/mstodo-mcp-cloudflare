import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DeploymentRefusal } from "./schema.ts";
import type { Runner } from "./runner.ts";

// Keep in sync with scripts/push-secrets.sh and .dev.vars.example.
export const SECRET_NAMES: readonly string[] = [
  "MS_TENANT_ID",
  "MS_CLIENT_ID",
  "MS_CLIENT_SECRET",
  "OWNER_EMAIL",
  "OWNER_OBJECT_ID",
];

// Value after the first `=` on the first line that starts with `NAME=`. CRLF is
// tolerated and one pair of matching surrounding quotes is stripped, matching
// how wrangler parses .dev.vars and what push-secrets.sh did.
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

const quote = (v: string): string =>
  `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;

// The one place a resolved secret touches disk. The directory is 0700 and the
// file is created 0600 at open, so the value is never readable by another user.
export function writeResolvedDevVars(path: string, entries: [string, string][]): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  rmSync(path, { force: true });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, entries.map(([k, v]) => `${k}=${quote(v)}\n`).join(""));
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
    let pid = NaN;
    try {
      pid = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
    } catch {
      // vanished or unreadable: treat as stale
    }
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) refuse();
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
