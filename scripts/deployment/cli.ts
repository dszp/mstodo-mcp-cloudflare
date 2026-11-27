// One entry point for every operation on a named deployment:
//   node scripts/deployment/cli.ts <deploy|dry-run|check|secrets|dev|tail|render> <name> [flags]
// (the npm scripts of the same names). It wires the pure modules beside it to
// wrangler, op and the Cloudflare API, in an order where every identity check
// runs before anything is written anywhere. This is the only module that prints
// or chooses an exit code. Erasable TypeScript only: Node runs this file directly.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParsedArgs } from "./args.ts";
import { checkAccountEnv, checkBaseUrl, checkCrossFiles, loadAllDeployments, ownFile } from "./checks.ts";
import {
  SECRET_NAMES,
  acquireDevLock,
  devLockHeld,
  readDevVar,
  removeResolvedDevVars,
  resolveSecret,
  writeResolvedDevVars,
} from "./dev-vars.ts";
import { diffRenders } from "./diff.ts";
import {
  attachedDomains,
  checkDomainChangeset,
  createCloudflareApi,
  inspectLiveWorker,
  liveSubdomain,
  wranglerToken,
  type CloudflareApi,
} from "./live.ts";
import { loadAndRender, type WranglerConfig } from "./render.ts";
import { nodeRunner, type Runner } from "./runner.ts";
import { DeploymentRefusal, deploymentPaths, parseDeploymentFile, parseJsonc, type DeploymentFile } from "./schema.ts";

export type CliDeps = {
  repoRoot: string;
  env: Record<string, string | undefined>;
  run: Runner;
  // Runs `npx <args>` with cwd at the repo root, stdio inherited, `env` merged over
  // the process environment; resolves with the child's exit code once it has exited.
  spawnInteractive: (args: string[], env: Record<string, string>) => Promise<number>;
  stdoutIsTTY: boolean;
  confirm: (question: string) => Promise<boolean>;
  api: (accountId: string) => Promise<CloudflareApi>;
  log: (line: string) => void;
};

type Paths = ReturnType<typeof deploymentPaths>;
type Ctx = { args: ParsedArgs; dep: DeploymentFile; paths: Paths; rendered: WranglerConfig; deps: CliDeps };

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  try {
    return await runCommand(argv, deps);
  } catch (e) {
    if (e instanceof DeploymentRefusal) {
      deps.log(`refused: ${e.message}`);
      return 1;
    }
    // Every path that handles a secret value raises DeploymentRefusal, whose
    // messages name fields only; what lands here is a bug or an I/O failure.
    const name = e instanceof Error ? e.name : "Error";
    const message = e instanceof Error ? e.message : String(e);
    deps.log(`error: ${name}: ${message}`);
    return 2;
  }
}

async function runCommand(argv: string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv);
  const paths = deploymentPaths(deps.repoRoot, args.name);

  // A crash or SIGKILL during `dev` can leave resolved secrets on disk; every
  // command clears them first, unless a live `dev` for this name is using them.
  if (!devLockHeld(paths.devLock)) removeResolvedDevVars(paths.resolvedDevVars);

  const relFile = `deployments/${args.name}/deployment.jsonc`;
  if (!existsSync(paths.file)) {
    throw new DeploymentRefusal(relFile, "(file)", "not found; copy deployment.example.jsonc there and fill it in");
  }
  const dep = parseDeploymentFile(readFileSync(paths.file, "utf8"), relFile, args.name);
  const rendered = loadAndRender(deps.repoRoot, dep);

  if (args.command === "render") {
    deps.log(JSON.stringify(rendered, null, 2));
    return 0;
  }

  checkBaseUrl(dep, relFile);
  checkCrossFiles(dep, loadAllDeployments(deps.repoRoot));
  checkAccountEnv(dep, deps.env);

  const ctx: Ctx = { args, dep, paths, rendered, deps };
  switch (args.command) {
    case "check":
      return check(ctx);
    case "dry-run":
      return dryRun(ctx);
    case "deploy":
      return deploy(ctx);
    case "secrets":
      return secrets(ctx);
    case "dev":
      return dev(ctx);
    case "tail":
      return wrangler(ctx, ["tail"]);
  }
}

const childEnv = (dep: DeploymentFile): Record<string, string> => ({ CLOUDFLARE_ACCOUNT_ID: dep.account_id });

// Order: wrangler subcommand and this script's own flags, then the rendered
// config, then the allowlisted passthrough (already single `--flag[=value]` tokens).
function wrangler(ctx: Ctx, head: string[], tail: string[] = []): Promise<number> {
  return ctx.deps.spawnInteractive(
    ["wrangler", ...head, "-c", ctx.paths.rendered, ...tail, ...ctx.args.passthrough],
    childEnv(ctx.dep),
  );
}

const list = (xs: string[]): string => (xs.length === 0 ? "(none)" : xs.join(", "));

async function check(ctx: Ctx): Promise<number> {
  const { dep, deps } = ctx;
  deps.log(`render OK: ${ctx.paths.rendered}`);
  deps.log("local checks OK: base_url, other deployment files, CLOUDFLARE_ACCOUNT_ID");
  const api = await deps.api(dep.account_id);
  const { found } = await inspectLiveWorker(api, dep, { adopt: false });
  if (!found) {
    deps.log(`live Worker ${dep.worker_name}: no live Worker yet; the first deploy creates it`);
    return 0;
  }
  deps.log(`live Worker ${dep.worker_name}: found, KV bindings match`);
  deps.log(`custom domains attached: ${list(await attachedDomains(api, dep))}`);
  const cs = await checkDomainChangeset(api, dep);
  deps.log(`custom domain changeset: added: ${list(cs.added)}; removed: ${list(cs.removed)}; conflicting: ${list(cs.conflicting)}`);
  const sub = await liveSubdomain(api, dep);
  const flag = (live: boolean, file: boolean) => `live ${live}, file ${file}${live === file ? "" : " (mismatch)"}`;
  deps.log(`workers.dev: ${flag(sub.enabled, dep.workers_dev)}`);
  deps.log(`preview URLs: ${flag(sub.previews_enabled, dep.preview_urls)}`);
  return 0;
}

async function dryRun(ctx: Ctx): Promise<number> {
  // Wrangler's dry run makes no API calls, so the live check is the only one.
  const api = await ctx.deps.api(ctx.dep.account_id);
  await inspectLiveWorker(api, ctx.dep, { adopt: false });
  return wrangler(ctx, ["deploy", "--dry-run"]);
}

function readLastDeployed(ctx: Ctx): WranglerConfig | null {
  const p = ctx.paths.lastDeployed;
  if (!existsSync(p)) return null;
  const file = `deployments/${ctx.dep.name}/last-deployed.json`;
  const v = parseJsonc(readFileSync(p, "utf8"), file);
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new DeploymentRefusal(file, "(root)", "must be a JSON object; delete it to treat the next deploy as the first");
  }
  return v as WranglerConfig;
}

async function deploy(ctx: Ctx): Promise<number> {
  const { dep, deps, args } = ctx;
  const file = ownFile(dep);
  // Off a TTY wrangler accepts custom-domain takeovers without asking.
  if (!deps.stdoutIsTTY && !args.nonInteractive) {
    throw new DeploymentRefusal(file, "(terminal)", "stdout is not a terminal; pass --non-interactive to deploy without prompts");
  }

  const api = await deps.api(dep.account_id);
  const { found } = await inspectLiveWorker(api, dep, { adopt: args.adopt });
  // The changeset endpoint needs an uploaded script; a first deploy is refused
  // below anyway when non-interactive, because it always shows a change.
  if (args.nonInteractive && found) {
    const cs = await checkDomainChangeset(api, dep);
    if (cs.conflicting.length > 0) {
      throw new DeploymentRefusal(file, "custom_domains", `conflicts with existing DNS or domains: ${cs.conflicting.join(", ")}`);
    }
  }

  const changes = diffRenders(readLastDeployed(ctx), ctx.rendered);
  if (changes.length > 0) {
    deps.log(`changes since the last deploy from this machine:`);
    for (const line of changes) deps.log(`  ${line}`);
    if (args.nonInteractive) {
      throw new DeploymentRefusal(file, "(changes)", "a non-interactive deploy must have no unseen changes; deploy once from a terminal");
    }
    if (!(await deps.confirm(`Deploy these changes to ${dep.worker_name} in account ${dep.account_id}?`))) {
      deps.log("not deployed");
      return 1;
    }
  }

  const code = await wrangler(ctx, ["deploy", "--strict"]);
  if (code === 0) writeFileSync(ctx.paths.lastDeployed, `${JSON.stringify(ctx.rendered, null, 2)}\n`);
  return code;
}

function readDevVarsFile(ctx: Ctx): string {
  if (!existsSync(ctx.paths.devVars)) {
    throw new DeploymentRefusal(`deployments/${ctx.dep.name}/.dev.vars`, "(file)", "not found; copy .dev.vars.example there and fill it in");
  }
  return readFileSync(ctx.paths.devVars, "utf8");
}

// Every non-empty secret, resolved. All are resolved before any is used, so a
// failed `op read` leaves nothing half-pushed or half-written.
async function resolveAll(ctx: Ctx): Promise<[string, string][]> {
  const text = readDevVarsFile(ctx);
  const out: [string, string][] = [];
  for (const name of SECRET_NAMES) {
    const raw = readDevVar(text, name);
    if (raw === undefined || raw === "") continue;
    out.push([name, await resolveSecret(raw, ctx.dep.op_account, ctx.deps.run)]);
  }
  return out;
}

async function secrets(ctx: Ctx): Promise<number> {
  const { dep, deps } = ctx;
  // MS_CLIENT_SECRET also derives the key that seals the KV tokens, so a secret
  // pushed to the wrong Worker is the most damaging wrong-target write.
  const api = await deps.api(dep.account_id);
  await inspectLiveWorker(api, dep, { adopt: false });

  const entries = await resolveAll(ctx);
  const present = new Set(entries.map(([n]) => n));
  for (const name of SECRET_NAMES) if (!present.has(name)) deps.log(`${name}: skipped (empty)`);

  let failed = 0;
  for (const [name, value] of entries) {
    const r = await deps.run("npx", ["wrangler", "secret", "put", name, "-c", ctx.paths.rendered], {
      stdin: value,
      env: childEnv(dep),
    });
    // wrangler's output is not echoed: it is the one stream that saw the value.
    if (r.code === 0) {
      deps.log(`${name}: ok`);
    } else {
      failed++;
      deps.log(`${name}: failed (wrangler exit ${r.code})`);
    }
  }
  return failed === 0 ? 0 : 1;
}

async function dev(ctx: Ctx): Promise<number> {
  const release = acquireDevLock(ctx.paths.devLock);
  try {
    const entries = await resolveAll(ctx);
    writeResolvedDevVars(ctx.paths.resolvedDevVars, entries);
    // Separate local state per deployment: a shared store would trigger the
    // identity-change wipe when signing in as the other deployment's owner.
    return await wrangler(ctx, ["dev"], ["--persist-to", join(ctx.deps.repoRoot, ".wrangler", "state", ctx.dep.name)]);
  } finally {
    // spawnInteractive resolves only after the child exits, so wrangler is no
    // longer watching the file when it goes.
    removeResolvedDevVars(ctx.paths.resolvedDevVars);
    release();
  }
}

// Real dependencies.

function spawnInteractive(repoRoot: string) {
  return (args: string[], env: Record<string, string>): Promise<number> =>
    new Promise((done) => {
      const child = spawn("npx", args, { cwd: repoRoot, stdio: "inherit", env: { ...process.env, ...env }, shell: false });
      // Replacing Node's default handlers keeps this process alive until the child
      // has exited, so a caller's cleanup (dev's secrets file) runs after it.
      const forward = (signal: NodeJS.Signals) => () => {
        child.kill(signal);
      };
      const onInt = forward("SIGINT");
      const onTerm = forward("SIGTERM");
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
      const finish = (code: number) => {
        process.off("SIGINT", onInt);
        process.off("SIGTERM", onTerm);
        done(code);
      };
      child.on("error", () => finish(127));
      // A child killed by a signal has no exit code; that is a failure.
      child.on("close", (code) => finish(code ?? 1));
    });
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

if (import.meta.main) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const code = await main(process.argv.slice(2), {
    repoRoot,
    env: process.env,
    run: nodeRunner,
    spawnInteractive: spawnInteractive(repoRoot),
    stdoutIsTTY: process.stdout.isTTY === true,
    confirm,
    api: async (accountId) => createCloudflareApi(await wranglerToken(nodeRunner, accountId)),
    log: (line) => console.log(line),
  });
  process.exit(code);
}
