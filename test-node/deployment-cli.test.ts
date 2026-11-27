import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type CliDeps } from "../scripts/deployment/cli.ts";
import { deploymentPaths } from "../scripts/deployment/schema.ts";
import type { CloudflareApi } from "../scripts/deployment/live.ts";
import type { RunResult } from "../scripts/deployment/runner.ts";

// Fake values only.
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const realRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

const alphaFile = {
  account_id: ACCOUNT,
  worker_name: "example-alpha",
  base_url: "https://example-alpha.example.workers.dev",
  workers_dev: true,
  preview_urls: false,
  kv: { OAUTH_KV: "0123456789abcdef0123456789abcda1", TODO_CACHE: "0123456789abcdef0123456789abcda2" },
  r2: { BLOBS: "example-alpha-blobs" },
};
const betaFile = {
  account_id: ACCOUNT,
  worker_name: "example-beta",
  base_url: "https://example-beta.example.workers.dev",
  workers_dev: true,
  preview_urls: false,
  kv: { OAUTH_KV: "0123456789abcdef0123456789abcdb1", TODO_CACHE: "0123456789abcdef0123456789abcdb2" },
  r2: { BLOBS: null },
};

let root: string;
const writeDeployment = (name: string, body: unknown): void => {
  const p = deploymentPaths(root, name);
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.file, `// fake\n${JSON.stringify(body, null, 2)}\n`);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deployment-cli-"));
  copyFileSync(join(realRoot, "wrangler.example.jsonc"), join(root, "wrangler.example.jsonc"));
  writeDeployment("alpha", alphaFile);
  writeDeployment("beta", betaFile);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type SpawnCall = { args: string[]; env: Record<string, string> };
type RunCall = { cmd: string; args: string[]; opts?: { stdin?: string; env?: Record<string, string> } };

const liveApi = (over: Partial<CloudflareApi> = {}): CloudflareApi => ({
  getWorkerKv: async () => ({ found: true, kv: { ...alphaFile.kv } }),
  listCustomDomains: async () => [],
  domainChangeset: async () => ({ added: [], removed: [], conflicting: [] }),
  getSubdomain: async () => ({ enabled: true, previews_enabled: false }),
  ...over,
});

function harness(over: Partial<CliDeps> & { apiImpl?: CloudflareApi; onSpawn?: (c: SpawnCall) => number; onRun?: (c: RunCall) => RunResult } = {}) {
  const spawns: SpawnCall[] = [];
  const runs: RunCall[] = [];
  const logs: string[] = [];
  const confirms: string[] = [];
  let apiCalls = 0;
  const deps: CliDeps = {
    repoRoot: root,
    env: {},
    run: async (cmd, args, opts) => {
      const c = { cmd, args, opts };
      runs.push(c);
      return over.onRun ? over.onRun(c) : { code: 0, stdout: "", stderr: "" };
    },
    spawnInteractive: async (args, env) => {
      const c = { args, env };
      spawns.push(c);
      return over.onSpawn ? over.onSpawn(c) : 0;
    },
    stdoutIsTTY: true,
    confirm: async (q) => {
      confirms.push(q);
      return true;
    },
    api: async () => {
      apiCalls++;
      return over.apiImpl ?? liveApi();
    },
    log: (l) => logs.push(l),
    ...over,
  };
  return { deps, spawns, runs, logs, confirms, apiCalls: () => apiCalls };
}

const paths = () => deploymentPaths(root, "alpha");
// Puts the current render in last-deployed.json, so a deploy sees no changes.
async function seedLastDeployed(): Promise<void> {
  const h = harness();
  expect(await main(["render", "alpha"], h.deps)).toBe(0);
  copyFileSync(paths().rendered, paths().lastDeployed);
}

describe("main: arguments", () => {
  it("refuses a missing name before any child or API call", async () => {
    const h = harness();
    expect(await main(["deploy"], h.deps)).toBe(1);
    expect(h.spawns).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(h.apiCalls()).toBe(0);
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatch(/^refused: \(command line\): name: /);
  });

  it("refuses a deployment with no file", async () => {
    const h = harness();
    expect(await main(["check", "gamma"], h.deps)).toBe(1);
    expect(h.logs[0]).toMatch(/^refused: deployments\/gamma\/deployment\.jsonc: /);
  });
});

describe("main: identity checks", () => {
  it("refuses a cross-file collision before calling the API", async () => {
    writeDeployment("beta", { ...betaFile, kv: { ...betaFile.kv, OAUTH_KV: alphaFile.kv.OAUTH_KV } });
    const h = harness();
    expect(await main(["check", "alpha"], h.deps)).toBe(1);
    expect(h.apiCalls()).toBe(0);
    expect(h.logs.at(-1)).toMatch(/^refused: deployments\/alpha\/deployment\.jsonc: kv\.OAUTH_KV: same KV namespace id/);
  });

  it("refuses a CLOUDFLARE_ACCOUNT_ID that names another account", async () => {
    const h = harness({ env: { CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdee" } });
    expect(await main(["tail", "alpha"], h.deps)).toBe(1);
    expect(h.spawns).toEqual([]);
  });
});

describe("main: render", () => {
  it("prints the rendered config and calls nothing", async () => {
    const h = harness();
    expect(await main(["render", "alpha"], h.deps)).toBe(0);
    expect(JSON.parse(h.logs.join("\n")).name).toBe("example-alpha");
    expect(h.apiCalls()).toBe(0);
    expect(h.spawns).toEqual([]);
  });

  it("deletes a stale resolved .dev.vars", async () => {
    mkdirSync(paths().renderDir, { recursive: true });
    writeFileSync(paths().resolvedDevVars, "MS_CLIENT_SECRET=stale\n");
    expect(await main(["render", "alpha"], harness().deps)).toBe(0);
    expect(existsSync(paths().resolvedDevVars)).toBe(false);
  });

  it("leaves the resolved .dev.vars of a running dev alone", async () => {
    mkdirSync(paths().renderDir, { recursive: true });
    writeFileSync(paths().resolvedDevVars, "MS_CLIENT_SECRET=live\n");
    writeFileSync(paths().devLock, String(process.pid));
    expect(await main(["render", "alpha"], harness().deps)).toBe(0);
    expect(existsSync(paths().resolvedDevVars)).toBe(true);
  });
});

describe("main: check", () => {
  it("reports the live Worker, domains, changeset and subdomain settings", async () => {
    const h = harness({
      apiImpl: liveApi({
        listCustomDomains: async () => [
          { hostname: "a.example.test", service: "example-alpha" },
          { hostname: "b.example.test", service: "example-other" },
        ],
        domainChangeset: async () => ({ added: [], removed: ["a.example.test"], conflicting: [] }),
        getSubdomain: async () => ({ enabled: true, previews_enabled: true }),
      }),
    });
    expect(await main(["check", "alpha"], h.deps)).toBe(0);
    const out = h.logs.join("\n");
    expect(out).toMatch(/live Worker example-alpha: found, KV bindings match/);
    expect(out).toMatch(/custom domains attached: a\.example\.test$/m);
    expect(out).toMatch(/removed: a\.example\.test/);
    expect(out).toMatch(/preview URLs: live true, file false \(mismatch\)/);
    expect(out).toMatch(/workers\.dev: live true, file true$/m);
    expect(h.spawns).toEqual([]);
  });

  it("skips the changeset when no Worker exists yet", async () => {
    let changesetCalls = 0;
    const h = harness({
      apiImpl: liveApi({
        getWorkerKv: async () => ({ found: false }),
        domainChangeset: async () => {
          changesetCalls++;
          throw new Error("404");
        },
      }),
    });
    expect(await main(["check", "alpha"], h.deps)).toBe(0);
    expect(changesetCalls).toBe(0);
    expect(h.logs.join("\n")).toMatch(/no live Worker yet/);
  });
});

describe("main: dry-run and tail", () => {
  it("dry-run checks the live Worker, then runs wrangler with the rendered config and passthrough", async () => {
    const h = harness();
    expect(await main(["dry-run", "alpha", "--minify"], h.deps)).toBe(0);
    expect(h.apiCalls()).toBe(1);
    expect(h.spawns).toEqual([
      { args: ["wrangler", "deploy", "--dry-run", "-c", paths().rendered, "--minify"], env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT } },
    ]);
  });

  it("tail passes the child's exit code through", async () => {
    const h = harness({ onSpawn: () => 3 });
    expect(await main(["tail", "alpha", "--format", "json"], h.deps)).toBe(3);
    expect(h.spawns[0].args).toEqual(["wrangler", "tail", "-c", paths().rendered, "--format=json"]);
  });
});

describe("main: deploy", () => {
  it("refuses off a TTY without --non-interactive, before calling the API", async () => {
    const h = harness({ stdoutIsTTY: false });
    expect(await main(["deploy", "alpha"], h.deps)).toBe(1);
    expect(h.apiCalls()).toBe(0);
    expect(h.spawns).toEqual([]);
  });

  it("proceeds off a TTY with --non-interactive when nothing changed", async () => {
    await seedLastDeployed();
    const h = harness({ stdoutIsTTY: false });
    expect(await main(["deploy", "alpha", "--non-interactive"], h.deps)).toBe(0);
    expect(h.spawns).toHaveLength(1);
    expect(h.confirms).toEqual([]);
  });

  it("refuses --non-interactive when there are unseen changes, including a first deploy", async () => {
    const h = harness({ stdoutIsTTY: false });
    expect(await main(["deploy", "alpha", "--non-interactive"], h.deps)).toBe(1);
    expect(h.spawns).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/first deploy from this machine/);
  });

  it("refuses --non-interactive when the domain changeset has a conflict", async () => {
    await seedLastDeployed();
    const h = harness({
      stdoutIsTTY: false,
      apiImpl: liveApi({ domainChangeset: async () => ({ added: [], removed: [], conflicting: ["c.example.test"] }) }),
    });
    expect(await main(["deploy", "alpha", "--non-interactive"], h.deps)).toBe(1);
    expect(h.spawns).toEqual([]);
  });

  it("does nothing when the operator declines the change", async () => {
    const h = harness({ confirm: async () => false });
    expect(await main(["deploy", "alpha"], h.deps)).toBe(1);
    expect(h.spawns).toEqual([]);
    expect(existsSync(paths().lastDeployed)).toBe(false);
  });

  it("asks before deploying changes, then runs wrangler deploy --strict and records the render", async () => {
    const h = harness();
    expect(await main(["deploy", "alpha", "--minify"], h.deps)).toBe(0);
    expect(h.confirms).toEqual([`Deploy these changes to example-alpha in account ${ACCOUNT}?`]);
    expect(h.spawns).toEqual([
      { args: ["wrangler", "deploy", "--strict", "-c", paths().rendered, "--minify"], env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT } },
    ]);
    expect(JSON.parse(readFileSync(paths().lastDeployed, "utf8"))).toEqual(JSON.parse(readFileSync(paths().rendered, "utf8")));
  });

  it("leaves last-deployed.json alone when wrangler fails", async () => {
    writeFileSync(paths().lastDeployed, `{"name":"previous"}\n`);
    const h = harness({ onSpawn: () => 1 });
    expect(await main(["deploy", "alpha"], h.deps)).toBe(1);
    expect(readFileSync(paths().lastDeployed, "utf8")).toBe(`{"name":"previous"}\n`);
  });

  it("refuses when the live Worker binds a different KV namespace", async () => {
    const h = harness({
      apiImpl: liveApi({ getWorkerKv: async () => ({ found: true, kv: { OAUTH_KV: "0123456789abcdef0123456789abcd99" } }) }),
    });
    expect(await main(["deploy", "alpha"], h.deps)).toBe(1);
    expect(h.spawns).toEqual([]);
  });
});

describe("main: secrets", () => {
  const LITERAL = "literal-tenant-0123";
  const RESOLVED = "resolved-client-secret-0123";
  const OWNER = "owner@example.test";
  beforeEach(() => {
    writeFileSync(
      paths().devVars,
      `MS_TENANT_ID=${LITERAL}\nMS_CLIENT_ID=\nMS_CLIENT_SECRET="op://vault/item/secret"\nOWNER_EMAIL=${OWNER}\n`,
    );
  });
  const opOk = (c: RunCall): RunResult =>
    c.cmd === "op" ? { code: 0, stdout: `${RESOLVED}\n`, stderr: "" } : { code: 0, stdout: "", stderr: "" };

  it("pipes each value over stdin, never in argv or the environment", async () => {
    const h = harness({ onRun: opOk });
    expect(await main(["secrets", "alpha"], h.deps)).toBe(0);
    const puts = h.runs.filter((r) => r.cmd === "npx");
    expect(puts.map((p) => p.args[3])).toEqual(["MS_TENANT_ID", "MS_CLIENT_SECRET", "OWNER_EMAIL"]);
    const values: Record<string, string> = { MS_TENANT_ID: LITERAL, MS_CLIENT_SECRET: RESOLVED, OWNER_EMAIL: OWNER };
    for (const p of puts) {
      const name = p.args[3];
      expect(p.args, name).toEqual(["wrangler", "secret", "put", name, "-c", paths().rendered]);
      expect(p.opts?.stdin, name).toBe(values[name]);
      expect(p.opts?.env, name).toEqual({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
    }
    for (const v of Object.values(values)) {
      expect(h.logs.join("\n"), v).not.toContain(v);
    }
    expect(h.apiCalls()).toBe(1);
  });

  it("stops before any put when op read fails, without logging values", async () => {
    const h = harness({
      onRun: (c) => (c.cmd === "op" ? { code: 1, stdout: "leaked-op-output", stderr: "leaked-op-error" } : { code: 0, stdout: "", stderr: "" }),
    });
    expect(await main(["secrets", "alpha"], h.deps)).toBe(1);
    expect(h.runs.filter((r) => r.cmd === "npx")).toEqual([]);
    const out = h.logs.join("\n");
    for (const v of [LITERAL, OWNER, "leaked-op-output", "leaked-op-error"]) expect(out, v).not.toContain(v);
  });

  it("reports a failed put by name and exits non-zero", async () => {
    const h = harness({
      onRun: (c) => (c.cmd === "npx" && c.args[3] === "OWNER_EMAIL" ? { code: 1, stdout: "", stderr: "x" } : opOk(c)),
    });
    expect(await main(["secrets", "alpha"], h.deps)).toBe(1);
    expect(h.logs.join("\n")).toMatch(/OWNER_EMAIL: failed/);
  });
});

describe("main: dev", () => {
  beforeEach(() => {
    writeFileSync(paths().devVars, `MS_CLIENT_SECRET=dev-secret-0123\nOWNER_EMAIL=\n`);
  });

  it("writes the resolved file for the child's lifetime only", async () => {
    let seen: { exists: boolean; mode: number; content: string; locked: boolean } | undefined;
    const h = harness({
      onSpawn: () => {
        const p = paths();
        seen = {
          exists: existsSync(p.resolvedDevVars),
          mode: statSync(p.resolvedDevVars).mode & 0o777,
          content: readFileSync(p.resolvedDevVars, "utf8"),
          locked: existsSync(p.devLock),
        };
        return 0;
      },
    });
    expect(await main(["dev", "alpha", "--port", "8788"], h.deps)).toBe(0);
    expect(seen).toEqual({ exists: true, mode: 0o600, content: "MS_CLIENT_SECRET='dev-secret-0123'\n", locked: true });
    expect(h.spawns[0].args).toEqual([
      "wrangler",
      "dev",
      "-c",
      paths().rendered,
      "--persist-to",
      join(root, ".wrangler", "state", "alpha"),
      "--port=8788",
    ]);
    expect(h.apiCalls()).toBe(0);
    expect(existsSync(paths().resolvedDevVars)).toBe(false);
    expect(existsSync(paths().devLock)).toBe(false);
  });

  it("cleans up when the child fails", async () => {
    const h = harness({ onSpawn: () => 130 });
    expect(await main(["dev", "alpha"], h.deps)).toBe(130);
    expect(existsSync(paths().resolvedDevVars)).toBe(false);
    expect(existsSync(paths().devLock)).toBe(false);
  });

  it("refuses a second dev while one holds the lock", async () => {
    mkdirSync(paths().renderDir, { recursive: true });
    writeFileSync(paths().devLock, String(process.pid));
    const h = harness();
    expect(await main(["dev", "alpha"], h.deps)).toBe(1);
    expect(h.spawns).toEqual([]);
  });
});

describe("main: unexpected errors", () => {
  it("exits 2 with the error class, not a refusal", async () => {
    const h = harness({
      api: async () => {
        throw new TypeError("boom");
      },
    });
    expect(await main(["check", "alpha"], h.deps)).toBe(2);
    expect(h.logs.at(-1)).toBe("error: TypeError: boom");
  });
});
