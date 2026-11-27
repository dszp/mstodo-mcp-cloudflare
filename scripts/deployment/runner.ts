import { spawn } from "node:child_process";

export type RunResult = { code: number; stdout: string; stderr: string };

// Captured output, no shell. `opts.env` is merged over process.env for the child.
export type Runner = (
  cmd: string,
  args: string[],
  opts?: { stdin?: string; env?: Record<string, string> },
) => Promise<RunResult>;

export const nodeRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      shell: false,
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
