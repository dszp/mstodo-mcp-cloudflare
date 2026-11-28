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
import {
  WRANGLER_NO_ENV,
  checkAccountEnv,
  checkBaseUrl,
  checkCrossFiles,
  checkTargetEnv,
  loadAllDeployments,
  ownFile,
  wranglerEnv,
} from "./checks.ts";
import {
  secretNames,
  acquireDevLock,
  devLockHeld,
  readDevVar,
  removeResolvedDevVars,
  resolveSecret,
  sweepResolvedDevVars,
  writeResolvedDevVars,
} from "./dev-vars.ts";
import { deployedContent, diffRenders } from "./diff.ts";
import {
  attachedDomains,
  checkDomainChangeset,
  createCloudflareApi,
  inspectLiveWorker,
  liveSubdomain,
  wranglerToken,
  type CloudflareApi,
} from "./live.ts";
import { loadAndRender, removeRender, writeRender, type WranglerConfig } from "./render.ts";
import { nodeRunner, wranglerCommand, type Runner } from "./runner.ts";
import { DeploymentRefusal, deploymentPaths, parseDeploymentFile, parseJsonc, type DeploymentFile } from "./schema.ts";

export type CliDeps = {
  repoRoot: string;
  env: Record<string, string | undefined>;
  run: Runner;
  // Runs wrangler with `args` (see wranglerCommand) with cwd at the repo root, stdio inherited, `env` merged over
  // the process environment; resolves with the child's exit code once it has exited.
  spawnInteractive: (args: string[], env: Record<string, string>) => Promise<number>;
  // Whether wrangler will treat this session as interactive (it needs stdin and
  // stdout on a terminal and CI unset); off one it accepts takeovers unasked.
  interactive: boolean;
  confirm: (question: string) => Promise<boolean>;
  api: (dep: DeploymentFile) => Promise<CloudflareApi>;
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
  // First, before even the arguments: resolved secrets a dead `dev` left behind.
  sweepResolvedDevVars(deps.repoRoot);
  const args = parseArgs(argv);
  const paths = deploymentPaths(deps.repoRoot, args.name);

  try {
    return await runChecked(args, paths, deps);
  } catch (e) {
    // The docs send operators to rendered.json for direct wrangler commands, so a
    // deployment that fails a check must not leave one behind, fresh or stale. A
    // running dev for this name is reading its copy; that one stays.
    if (e instanceof DeploymentRefusal && !devLockHeld(paths.devLock)) removeRender(deps.repoRoot, args.name);
    throw e;
  }
}

async function runChecked(args: ParsedArgs, paths: Paths, deps: CliDeps): Promise<number> {
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
  checkTargetEnv(dep, deps.env);

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
      publishRender(ctx);
      return wrangler(ctx, ["tail"]);
  }
}

// Order: wrangler subcommand and this script's own flags, then the rendered
// config and the empty environment, then the allowlisted passthrough (already
// single `--flag[=value]` tokens).
function wrangler(ctx: Ctx, head: string[], tail: string[] = []): Promise<number> {
  return ctx.deps.spawnInteractive(
    [...head, "-c", ctx.paths.rendered, WRANGLER_NO_ENV, ...tail, ...ctx.args.passthrough],
    wranglerEnv(ctx.dep),
  );
}

const list = (xs: string[]): string => (xs.length === 0 ? "(none)" : xs.join(", "));

// rendered.json reflects a render that passed every check the command makes, so
// each command writes it after those checks and before wrangler reads it.
function publishRender(ctx: Ctx): void {
  writeRender(ctx.deps.repoRoot, ctx.dep.name, ctx.rendered);
}

// "live X, file Y", marked when they differ.
const flag = (live: boolean, file: boolean): string => `live ${live}, file ${file}${live === file ? "" : " (mismatch)"}`;

// Exits 1 on anything deploy would refuse or ask about: a conflicting domain, a
// domain the deploy would detach, or a workers.dev / preview URL mismatch.
async function check(ctx: Ctx): Promise<number> {
  const { dep, deps } = ctx;
  deps.log("local checks OK: base_url, other deployment files, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ENV, WRANGLER_CI_OVERRIDE_NAME");
  const api = await deps.api(dep);
  const { found } = await inspectLiveWorker(api, dep, { adopt: false });
  if (!found) {
    deps.log(`live Worker ${dep.worker_name}: no live Worker yet; the first deploy creates it`);
    publishRender(ctx);
    deps.log(`rendered: ${ctx.paths.rendered}`);
    return 0;
  }
  deps.log(`live Worker ${dep.worker_name}: found${dep.kind === "server" ? ", KV bindings match" : ""}`);
  deps.log(`custom domains attached: ${list(await attachedDomains(api, dep))}`);
  const cs = await checkDomainChangeset(api, dep);
  deps.log(`custom domain changeset: added: ${list(cs.added)}; removed: ${list(cs.removed)}; conflicting: ${list(cs.conflicting)}`);
  const detaches = detachedDomains(dep, cs.removed);
  if (cs.removed.length > 0 && detaches.length === 0) {
    deps.log("  custom_domains is empty, so deploy leaves them attached");
  }
  const sub = await liveSubdomain(api, dep);
  deps.log(`workers.dev: ${flag(sub.enabled, dep.workers_dev)}`);
  deps.log(`preview URLs: ${flag(sub.previews_enabled, dep.preview_urls)}`);

  const ok =
    cs.conflicting.length === 0 &&
    detaches.length === 0 &&
    sub.enabled === dep.workers_dev &&
    sub.previews_enabled === dep.preview_urls;
  if (!ok) {
    if (!devLockHeld(ctx.paths.devLock)) removeRender(deps.repoRoot, dep.name);
    deps.log("check failed: deploy would refuse or ask about the lines marked above");
    return 1;
  }
  publishRender(ctx);
  deps.log(`rendered: ${ctx.paths.rendered}`);
  return 0;
}

// Wrangler sends the custom-domain changeset with replace_state=true only when the
// config has custom-domain routes (cli.js 166957 in wrangler 4.158); with none it
// leaves attached domains alone, so `removed` detaches something only then.
const detachedDomains = (dep: DeploymentFile, removed: string[]): string[] =>
  dep.custom_domains.length > 0 ? removed : [];

async function dryRun(ctx: Ctx): Promise<number> {
  // Wrangler's dry run makes no API calls, so the live check is the only one.
  const api = await ctx.deps.api(ctx.dep);
  await inspectLiveWorker(api, ctx.dep, { adopt: false });
  publishRender(ctx);
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
  // Off a terminal wrangler accepts custom-domain takeovers without asking.
  if (!deps.interactive && !args.nonInteractive) {
    throw new DeploymentRefusal(
      file,
      "(terminal)",
      "not an interactive session (stdin and stdout on a terminal, CI unset); pass --non-interactive to deploy without prompts",
    );
  }
  const refuseUnattended = (field: string, reason: string): void => {
    if (args.nonInteractive) throw new DeploymentRefusal(file, field, `${reason}; deploy once from a terminal to confirm it`);
  };

  const api = await deps.api(dep);
  const { found } = await inspectLiveWorker(api, dep, { adopt: args.adopt });
  const last = readLastDeployed(ctx);
  // Whatever the operator must see and confirm before wrangler runs.
  let ask = false;

  // Checked in every mode: wrangler's own takeover prompt is skipped whenever it
  // decides the session is not interactive, which this script cannot fully predict.
  // The changeset and subdomain endpoints need an uploaded script; a first deploy
  // always shows a change, so it is confirmed interactively or refused below.
  if (found) {
    const cs = await checkDomainChangeset(api, dep);
    if (cs.conflicting.length > 0) {
      throw new DeploymentRefusal(file, "custom_domains", `conflicts with existing DNS or domains: ${cs.conflicting.join(", ")}`);
    }
    const detaches = detachedDomains(dep, cs.removed);
    if (detaches.length > 0) {
      deps.log(`attached to ${dep.worker_name} but not in custom_domains; this deploy detaches: ${detaches.join(", ")}`);
      refuseUnattended("custom_domains", `the deploy would detach ${detaches.join(", ")}`);
      ask = true;
    }

    // wrangler deploy applies workers_dev and preview_urls from the config.
    const sub = await liveSubdomain(api, dep);
    const devMismatch = sub.enabled !== dep.workers_dev;
    const previewMismatch = sub.previews_enabled !== dep.preview_urls;
    if (devMismatch || previewMismatch || last === null) {
      deps.log(`workers.dev: ${flag(sub.enabled, dep.workers_dev)}`);
      deps.log(`preview URLs: ${flag(sub.previews_enabled, dep.preview_urls)}`);
    }
    if (devMismatch) refuseUnattended("workers_dev", `live is ${sub.enabled}, the file says ${dep.workers_dev}`);
    if (previewMismatch) refuseUnattended("preview_urls", `live is ${sub.previews_enabled}, the file says ${dep.preview_urls}`);
    if (devMismatch || previewMismatch) ask = true;
    if (last === null) deps.log(`custom domains attached: ${list(await attachedDomains(api, dep))}`);
  }

  const changes = diffRenders(last, ctx.rendered);
  if (changes.length > 0) {
    deps.log(`changes since the last deploy from this machine:`);
    for (const line of changes) deps.log(`  ${line}`);
    if (last === null) {
      deps.log("this deploy sends these vars and bindings:");
      for (const line of deployedContent(ctx.rendered)) deps.log(`  ${line}`);
    }
    if (args.nonInteractive) {
      throw new DeploymentRefusal(file, "(changes)", "a non-interactive deploy must have no unseen changes; deploy once from a terminal");
    }
    ask = true;
  }

  if (ask && !(await deps.confirm(`Deploy to ${dep.worker_name} in account ${dep.account_id}?`))) {
    deps.log("not deployed");
    return 1;
  }

  publishRender(ctx);
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
  for (const name of secretNames(ctx.dep.kind)) {
    const raw = readDevVar(text, name);
    if (raw === undefined || raw === "") continue;
    out.push([name, await resolveSecret(raw, ctx.dep.op_account, ctx.deps.run)]);
  }
  return out;
}

async function secrets(ctx: Ctx): Promise<number> {
  const { dep, deps } = ctx;
  // On the server, MS_CLIENT_SECRET also derives the key that seals the KV tokens,
  // so a secret pushed to the wrong Worker is the most damaging wrong-target write.
  // On the web Worker, WEB_SESSION_SECRET seals the session cookies.
  const api = await deps.api(dep);
  const { found } = await inspectLiveWorker(api, dep, { adopt: false });
  // On a missing Worker, `wrangler secret put` creates an empty draft one (its
  // prompt defaults to yes when stdin is piped), which the next deploy would
  // then refuse as a stranger.
  if (!found) {
    throw new DeploymentRefusal(ownFile(dep), "(live Worker)", `no live Worker ${dep.worker_name} yet; deploy first`);
  }

  const entries = await resolveAll(ctx);
  const present = new Set(entries.map(([n]) => n));
  for (const name of secretNames(dep.kind)) if (!present.has(name)) deps.log(`${name}: skipped (empty)`);

  publishRender(ctx);
  let failed = 0;
  for (const [name, value] of entries) {
    const r = await deps.run(...wranglerCommand(ctx.deps.repoRoot, ["secret", "put", name, "-c", ctx.paths.rendered, WRANGLER_NO_ENV]), {
      stdin: value,
      env: wranglerEnv(dep),
      cwd: ctx.deps.repoRoot,
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
    publishRender(ctx);
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
      const [cmd, argv] = wranglerCommand(repoRoot, args);
      const child = spawn(cmd, argv, { cwd: repoRoot, stdio: "inherit", env: { ...process.env, ...env }, shell: false });
      // Replacing Node's default handlers keeps this process alive until the child
      // has exited, so a caller's cleanup (dev's secrets file) runs after it.
      const forward = (signal: NodeJS.Signals) => () => {
        child.kill(signal);
      };
      // SIGHUP is a closed terminal or SSH session; Node's default would exit at
      // once and skip dev's cleanup of the resolved secrets.
      const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
      const handlers = signals.map((signal) => [signal, forward(signal)] as const);
      for (const [signal, handler] of handlers) process.on(signal, handler);
      const finish = (code: number) => {
        for (const [signal, handler] of handlers) process.off(signal, handler);
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
    // Approximates wrangler's isNonInteractiveOrCI (TTY stdin and stdout, not CI);
    // wrangler's ci-info also spots CI vendors by their own variables, a gap the
    // deploy command's changeset refusal covers.
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI,
    confirm,
    api: async (dep) => createCloudflareApi(await wranglerToken(nodeRunner, dep, repoRoot)),
    log: (line) => console.log(line),
  });
  process.exit(code);
}
