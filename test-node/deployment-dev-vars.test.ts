import { afterEach, describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeploymentRefusal } from "../scripts/deployment/schema.ts";
import {
  SECRET_NAMES,
  acquireDevLock,
  readDevVar,
  removeResolvedDevVars,
  resolveSecret,
  sweepResolvedDevVars,
  writeResolvedDevVars,
} from "../scripts/deployment/dev-vars.ts";
import { deploymentPaths } from "../scripts/deployment/schema.ts";
import { nodeRunner, type Runner } from "../scripts/deployment/runner.ts";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "dev-vars-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SECRET_NAMES", () => {
  it("lists the five Worker secrets", () => {
    expect([...SECRET_NAMES]).toEqual([
      "MS_TENANT_ID",
      "MS_CLIENT_ID",
      "MS_CLIENT_SECRET",
      "OWNER_EMAIL",
      "OWNER_OBJECT_ID",
    ]);
  });
});

describe("readDevVar", () => {
  it("takes the value after the first =, tolerating CRLF and spaces", () => {
    expect(readDevVar("MS_CLIENT_SECRET=a=b#c d\r\n", "MS_CLIENT_SECRET")).toBe("a=b#c d");
  });
  it("strips one pair of matching quotes", () => {
    expect(readDevVar(`A="x"`, "A")).toBe("x");
    expect(readDevVar(`A='x'`, "A")).toBe("x");
    expect(readDevVar(`A=""x""`, "A")).toBe(`"x"`);
  });
  it("leaves mismatched or lone quotes alone", () => {
    expect(readDevVar(`A="x'`, "A")).toBe(`"x'`);
    expect(readDevVar(`A="`, "A")).toBe(`"`);
  });
  it("uses the first matching line only", () => {
    expect(readDevVar("A=one\nA=two\n", "A")).toBe("one");
  });
  it("matches the whole name at line start", () => {
    expect(readDevVar("XA=1\n #A=2\nA_B=3\n", "A")).toBeUndefined();
    expect(readDevVar("X=1\nA=2\n", "A")).toBe("2");
  });
  it("returns undefined when absent, and empty string for an empty value", () => {
    expect(readDevVar("B=1\n", "A")).toBeUndefined();
    expect(readDevVar("A=\n", "A")).toBe("");
  });
});

describe("resolveSecret", () => {
  const never: Runner = async () => {
    throw new Error("runner must not be called");
  };

  it("passes a literal through without calling op", async () => {
    expect(await resolveSecret("plain-value", "acct", never)).toBe("plain-value");
  });

  it("reads an op:// reference with --account and strips one trailing newline", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run: Runner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: "resolved\n", stderr: "" };
    };
    expect(await resolveSecret("op://v/i/f", "acct", run)).toBe("resolved");
    expect(calls).toEqual([{ cmd: "op", args: ["read", "--account", "acct", "op://v/i/f"] }]);
  });

  it("omits --account when none is given, and strips CRLF once", async () => {
    let seen: string[] = [];
    const run: Runner = async (_c, args) => {
      seen = args;
      return { code: 0, stdout: "v\n\r\n", stderr: "" };
    };
    expect(await resolveSecret("op://v/i/f", undefined, run)).toBe("v\n");
    expect(seen).toEqual(["read", "op://v/i/f"]);
  });

  it("refuses naming the reference, never the output, on a non-zero exit", async () => {
    const run: Runner = async () => ({ code: 1, stdout: "SECRETLEAK", stderr: "SECRETLEAK too" });
    const err = await resolveSecret("op://v/i/f", "acct", run).catch((e) => e);
    expect(err).toBeInstanceOf(DeploymentRefusal);
    expect(err.message).toContain("op://v/i/f");
    expect(err.message).not.toContain("SECRETLEAK");
    expect(err.file).toBe("(op)");
  });
});

describe("writeResolvedDevVars / removeResolvedDevVars", () => {
  it("creates the dir 0700 and the file 0600 with quoted lines", () => {
    const path = join(tmp(), "sub", "deployment.dev.vars");
    writeResolvedDevVars(path, [
      ["A", "one"],
      ["B", "two words"],
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).toBe("A='one'\nB='two words'\n");
  });

  // Copy of the dotenv 16.3.1 parse that wrangler bundles for .dev.vars
  // (node_modules/wrangler/wrangler-dist/cli.js, "function parse17", ~line 164071).
  const LINE =
    /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;
  const wranglerParse = (src: string): Record<string, string> => {
    const obj: Record<string, string> = {};
    const lines = src.replace(/\r\n?/gm, "\n");
    const re = new RegExp(LINE.source, LINE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines)) !== null) {
      let value = (m[2] || "").trim();
      const q = value[0];
      value = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
      if (q === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      obj[m[1]!] = value;
    }
    return obj;
  };

  const cases: Record<string, string> = {
    "double quote": 'a"b',
    backslash: "a\\b",
    "literal backslash-n": "a\\nb",
    "trailing backslash": "abc\\",
    hash: "a#b",
    spaces: "  a b  ",
    dollar: "$X and ${Y}",
    "single quote": "it's",
    "multi-line": "line1\nline2\n",
    "single quote and backtick": "a'b`c",
    empty: "",
  };

  for (const [label, value] of Object.entries(cases)) {
    it(`round-trips through wrangler's parser: ${label}`, () => {
      const path = join(tmp(), "d", "f");
      // A neighbour on each side catches a value that runs into another line.
      writeResolvedDevVars(path, [
        ["BEFORE", "'"],
        ["TARGET", value],
        ["AFTER", "next'"],
      ]);
      const parsed = wranglerParse(readFileSync(path, "utf8"));
      expect(parsed.TARGET, label).toBe(value);
      expect(parsed.BEFORE).toBe("'");
      expect(parsed.AFTER).toBe("next'");
    });
  }

  describe("refusals", () => {
    const refusal = (value: string): DeploymentRefusal => {
      const path = join(tmp(), "d", "f");
      try {
        writeResolvedDevVars(path, [["SECRET_X", value]]);
      } catch (e) {
        expect(existsSync(path)).toBe(false);
        return e as DeploymentRefusal;
      }
      throw new Error("expected a refusal");
    };
    const labelled: Record<string, string> = {
      "carriage return": "abc\rXYZ-leak",
      "all three quote characters": "a'b`c\"XYZ-leak",
      "needs double quotes and holds a literal backslash-n": "a'b`c\\nXYZ-leak",
    };
    for (const [label, value] of Object.entries(labelled)) {
      it(`refuses ${label} without echoing the value`, () => {
        const err = refusal(value);
        expect(err).toBeInstanceOf(DeploymentRefusal);
        expect(err.field).toBe("SECRET_X");
        expect(err.message).not.toContain("XYZ-leak");
      });
    }
  });

  it("replaces a stale file, resetting its mode to 0600", () => {
    const dir = tmp();
    const path = join(dir, "f");
    writeFileSync(path, "OLD", { mode: 0o644 });
    writeResolvedDevVars(path, [["A", "new"]]);
    expect(readFileSync(path, "utf8")).toBe("A='new'\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("removes the file, and is quiet when it is absent", () => {
    const path = join(tmp(), "d", "f");
    writeResolvedDevVars(path, [["A", "x"]]);
    removeResolvedDevVars(path);
    expect(existsSync(path)).toBe(false);
    expect(() => removeResolvedDevVars(path)).not.toThrow();
  });
});

describe("acquireDevLock", () => {
  it("writes the pid and removes the lock on release", () => {
    const lock = join(tmp(), "alpha.lock");
    const release = acquireDevLock(lock);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(lock)).toBe(false);
    expect(() => release()).not.toThrow();
  });

  it("refuses when the recorded pid is alive", () => {
    const dir = tmp();
    const lock = join(dir, "alpha.lock");
    const release = acquireDevLock(lock);
    const err = (() => {
      try {
        acquireDevLock(lock);
      } catch (e) {
        return e as DeploymentRefusal;
      }
    })();
    expect(err).toBeInstanceOf(DeploymentRefusal);
    expect(err!.message).toContain("dev already running for alpha");
    release();
  });

  it("replaces a lock whose pid is dead or unreadable", () => {
    const dir = tmp();
    const lock = join(dir, "alpha.lock");
    writeFileSync(lock, "999999");
    const release = acquireDevLock(lock);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
    release();
    writeFileSync(lock, "garbage");
    const release2 = acquireDevLock(lock);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
    release2();
  });

  it("creates the lock's directory when missing", () => {
    const lock = join(tmp(), "nested", "alpha.lock");
    const release = acquireDevLock(lock);
    expect(existsSync(lock)).toBe(true);
    release();
  });
});

describe("sweepResolvedDevVars", () => {
  const seed = (root: string, name: string, lockPid?: string): ReturnType<typeof deploymentPaths> => {
    const p = deploymentPaths(root, name);
    mkdirSync(p.renderDir, { recursive: true });
    writeFileSync(p.resolvedDevVars, "MS_CLIENT_SECRET='x'\n");
    if (lockPid !== undefined) writeFileSync(p.devLock, lockPid);
    return p;
  };

  it("removes every deployment's resolved .dev.vars unless a live pid holds its lock", () => {
    const root = tmp();
    const unlocked = seed(root, "alpha");
    const deadLock = seed(root, "beta", "999999");
    const garbageLock = seed(root, "gamma", "garbage");
    const live = seed(root, "delta", String(process.pid));
    sweepResolvedDevVars(root);
    expect(existsSync(unlocked.resolvedDevVars), "alpha").toBe(false);
    expect(existsSync(deadLock.resolvedDevVars), "beta").toBe(false);
    expect(existsSync(garbageLock.resolvedDevVars), "gamma").toBe(false);
    expect(existsSync(live.resolvedDevVars), "delta").toBe(true);
  });

  it("does nothing when no deployment has rendered yet", () => {
    expect(() => sweepResolvedDevVars(tmp())).not.toThrow();
  });
});

describe("nodeRunner", () => {
  const node = process.execPath;

  it("captures stdout, stderr and the exit code", async () => {
    const r = await nodeRunner(node, ["-e", "process.stdout.write('o');process.stderr.write('e');process.exit(3)"]);
    expect(r).toEqual({ code: 3, stdout: "o", stderr: "e" });
  });

  it("writes opts.stdin to the child and ends it", async () => {
    const r = await nodeRunner(node, ["-e", "process.stdin.pipe(process.stdout)"], { stdin: "secret-in" });
    expect(r.stdout).toBe("secret-in");
  });

  it("ignores stdin when none is given (child sees EOF at once)", async () => {
    const r = await nodeRunner(node, ["-e", "process.stdin.on('data',()=>{}).on('end',()=>process.stdout.write('eof'))"]);
    expect(r.stdout).toBe("eof");
  });

  it("merges opts.env over process.env", async () => {
    process.env.RUNNER_TEST_KEEP = "kept";
    try {
      const r = await nodeRunner(
        node,
        ["-e", "process.stdout.write(process.env.RUNNER_TEST_KEEP+'|'+process.env.RUNNER_TEST_NEW)"],
        { env: { RUNNER_TEST_NEW: "added" } },
      );
      expect(r.stdout).toBe("kept|added");
    } finally {
      delete process.env.RUNNER_TEST_KEEP;
    }
  });

  it("runs the child in opts.cwd", async () => {
    const dir = tmp();
    const r = await nodeRunner(node, ["-e", "process.stdout.write(process.cwd())"], { cwd: dir });
    expect(realpathSync(r.stdout)).toBe(realpathSync(dir));
  });

  it("does not use a shell", async () => {
    const r = await nodeRunner(node, ["-e", "process.stdout.write(process.argv[1])", "a; echo injected $HOME"]);
    expect(r.stdout).toBe("a; echo injected $HOME");
  });

  it("reports a missing command as a non-zero result, not a throw", async () => {
    const r = await nodeRunner("definitely-not-a-command-xyz", []);
    expect(r.code).not.toBe(0);
  });
});
