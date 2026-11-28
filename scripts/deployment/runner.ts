import { spawn } from "node:child_process";
import { join } from "node:path";

// wrangler runs from the repository's node_modules under the current node, with
// no package manager in between: npx downloads a package it cannot find, and
// `pnpm exec` can start an install before running anything.
export function wranglerCommand(repoRoot: string, args: string[]): [cmd: string, args: string[]] {
  return [process.execPath, [join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js"), ...args]];
}

export type RunResult = { code: number; stdout: string; stderr: string };

// Captured output, no shell. `opts.env` is merged over process.env for the child;
// `opts.cwd` is its working directory (default: this process's).
export type Runner = (
  cmd: string,
  args: string[],
  opts?: { stdin?: string; env?: Record<string, string>; cwd?: string },
) => Promise<RunResult>;

export const nodeRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      shell: false,
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
      stdio: [opts?.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    // A command that cannot start (ENOENT, EACCES) is a failed run, not a throw.
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts?.stdin !== undefined) {
      // A child that exits without reading stdin raises EPIPE here; its exit code carries the outcome.
      child.stdin!.on("error", () => {});
      child.stdin!.end(opts.stdin);
    }
  });
