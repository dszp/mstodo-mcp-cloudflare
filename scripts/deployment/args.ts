// Command-line parsing for scripts/deployment.mjs. Wrangler flags pass through
// only when listed here, per command: the rest (--name, -c, -e, --routes, --var,
// --account-id, ...) can redirect or rewrite a deployment, so they are refused.
// Erasable TypeScript only: this runs on bare Node.
import { DEPLOYMENT_NAME, DeploymentRefusal } from "./schema.ts";

export type Command = "deploy" | "dry-run" | "check" | "secrets" | "dev" | "tail" | "render";

export type ParsedArgs = {
  command: Command;
  name: string;
  adopt: boolean;
  nonInteractive: boolean;
  passthrough: string[];
};

const FILE = "(command line)";

// flag -> whether it takes a value
type Allow = Record<string, boolean>;
const BUILD: Allow = { "--minify": false, "--no-minify": false, "--outdir": true };
const ALLOWED: Record<Command, Allow> = {
  deploy: BUILD,
  "dry-run": BUILD,
  tail: { "--format": true, "--status": true, "--search": true, "--method": true, "--sampling-rate": true },
  dev: { "--port": true, "--ip": true, "--inspector-port": true, "--local": false },
  check: {},
  secrets: {},
  render: {},
};
const COMMANDS = Object.keys(ALLOWED);

const refuse = (field: string, reason: string): never => {
  throw new DeploymentRefusal(FILE, field, reason);
};

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return refuse("usage", `node scripts/deployment.mjs <${COMMANDS.join("|")}> <name> [flags]`);
  }
  const command = argv[0];
  if (!COMMANDS.includes(command)) return refuse("command", `unknown command "${command}"; expected one of ${COMMANDS.join(", ")}`);
  const cmd = command as Command;

  const name = argv[1];
  if (name === undefined) return refuse("name", "required: the deployment name");
  if (!DEPLOYMENT_NAME.test(name)) return refuse("name", `"${name}" must match ${DEPLOYMENT_NAME}`);

  const allowed = ALLOWED[cmd];
  let adopt = false;
  let nonInteractive = false;
  const passthrough: string[] = [];

  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("-")) return refuse(token, "unexpected argument after the deployment name");
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);

    if (cmd === "deploy" && (flag === "--adopt" || flag === "--non-interactive")) {
      if (inline !== undefined) return refuse(flag, "takes no value");
      if (flag === "--adopt") adopt = true;
      else nonInteractive = true;
      continue;
    }
    if (!Object.hasOwn(allowed, flag)) return refuse(flag, `not allowed on ${cmd}`);

    if (!allowed[flag]) {
      if (inline !== undefined) return refuse(flag, "takes no value");
      passthrough.push(flag);
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      }
    }
    if (value === undefined || value === "") return refuse(flag, "needs a value");
    passthrough.push(flag, value);
  }

  return { command: cmd, name, adopt, nonInteractive, passthrough };
}
