import { describe, it, expect } from "vitest";
import { DeploymentRefusal } from "../scripts/deployment/schema.ts";
import { parseArgs } from "../scripts/deployment/args.ts";

const refusal = (argv: string[]): DeploymentRefusal => {
  try {
    parseArgs(argv);
  } catch (e) {
    expect(e).toBeInstanceOf(DeploymentRefusal);
    return e as DeploymentRefusal;
  }
  throw new Error(`expected a refusal for: ${argv.join(" ")}`);
};

describe("parseArgs: command and name", () => {
  it("parses a bare command and name", () => {
    expect(parseArgs(["deploy", "production"])).toEqual({
      command: "deploy",
      name: "production",
      adopt: false,
      nonInteractive: false,
      passthrough: [],
    });
  });

  it("accepts every command", () => {
    for (const c of ["deploy", "dry-run", "check", "secrets", "dev", "tail", "render"]) {
      expect(parseArgs([c, "alpha"]).command).toBe(c);
    }
  });

  it("refuses no arguments with a usage line", () => {
    const r = refusal([]);
    expect(r.file).toBe("(command line)");
    expect(r.field).toBe("usage");
  });

  it("refuses an unknown command", () => {
    expect(refusal(["publish", "alpha"]).field).toBe("command");
  });

  it("refuses a missing name", () => {
    expect(refusal(["deploy"]).field).toBe("name");
    expect(refusal(["deploy", "--minify"]).field).toBe("name");
  });

  it.each(["Prod", "-x", "a_b", "a/b", ""])("refuses the name %j", (name) => {
    expect(refusal(["deploy", name]).field).toBe("name");
  });

  it("refuses a positional token after the name", () => {
    expect(refusal(["deploy", "alpha", "extra"]).field).toBe("extra");
  });
});

describe("parseArgs: refused flags", () => {
  it.each([
    ["--name", "x"],
    ["--name=x"],
    ["-c", "x"],
    ["--config", "x"],
    ["-e", "x"],
    ["--env", "x"],
    ["--cwd", "x"],
    ["--profile", "x"],
    ["--routes", "x"],
    ["--domains", "x"],
    ["--var", "A:B"],
    ["--keep-vars"],
    ["--account-id", "x"],
    ["--account-id=0123456789abcdef0123456789abcdef"],
    ["-x"],
  ])("refuses %j on deploy", (...flags) => {
    const r = refusal(["deploy", "alpha", ...flags]);
    expect(r.file).toBe("(command line)");
    expect(r.field).toBe(flags[0].split("=")[0]);
  });

  it("refuses a flag that belongs to another command", () => {
    expect(refusal(["deploy", "production", "--format", "json"]).field).toBe("--format");
    expect(refusal(["tail", "production", "--minify"]).field).toBe("--minify");
    expect(refusal(["deploy", "alpha", "--port", "1"]).field).toBe("--port");
  });

  it("refuses --minify on secrets, check and render", () => {
    for (const c of ["secrets", "check", "render"]) expect(refusal([c, "alpha", "--minify"]).field).toBe("--minify");
  });

  it("refuses --adopt and --non-interactive outside deploy", () => {
    for (const c of ["secrets", "dry-run", "check", "render", "dev", "tail"]) {
      expect(refusal([c, "alpha", "--adopt"]).field).toBe("--adopt");
      expect(refusal([c, "alpha", "--non-interactive"]).field).toBe("--non-interactive");
    }
  });

  it("refuses a boolean flag given a value", () => {
    expect(refusal(["deploy", "alpha", "--minify=true"]).field).toBe("--minify");
  });
});

describe("parseArgs: passthrough", () => {
  it("passes --minify and --no-minify through on deploy and dry-run", () => {
    expect(parseArgs(["deploy", "alpha", "--minify"]).passthrough).toEqual(["--minify"]);
    expect(parseArgs(["dry-run", "alpha", "--no-minify"]).passthrough).toEqual(["--no-minify"]);
  });

  it("accepts a value as a separate token or after =", () => {
    expect(parseArgs(["deploy", "alpha", "--outdir", "out"]).passthrough).toEqual(["--outdir", "out"]);
    expect(parseArgs(["deploy", "alpha", "--outdir=out"]).passthrough).toEqual(["--outdir", "out"]);
  });

  it("allows the tail flags", () => {
    const p = parseArgs([
      "tail", "alpha", "--format", "json", "--status=error", "--search", "x", "--method", "GET", "--sampling-rate", "0.5",
    ]).passthrough;
    expect(p).toEqual(["--format", "json", "--status", "error", "--search", "x", "--method", "GET", "--sampling-rate", "0.5"]);
  });

  it("allows the dev flags, --local taking no value", () => {
    const p = parseArgs(["dev", "alpha", "--port", "8788", "--ip", "127.0.0.1", "--inspector-port=9230", "--local"]).passthrough;
    expect(p).toEqual(["--port", "8788", "--ip", "127.0.0.1", "--inspector-port", "9230", "--local"]);
  });

  it("consumes --adopt and --non-interactive on deploy", () => {
    const r = parseArgs(["deploy", "alpha", "--adopt", "--minify", "--non-interactive"]);
    expect(r.adopt).toBe(true);
    expect(r.nonInteractive).toBe(true);
    expect(r.passthrough).toEqual(["--minify"]);
  });

  it("refuses a value flag with no value", () => {
    expect(refusal(["deploy", "alpha", "--outdir"]).field).toBe("--outdir");
    expect(refusal(["deploy", "alpha", "--outdir", "--minify"]).field).toBe("--outdir");
    expect(refusal(["deploy", "alpha", "--outdir="]).field).toBe("--outdir");
  });
});
