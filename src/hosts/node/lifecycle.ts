import { log } from "../../core/log";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Process-level handlers for the Node host, installed once the instance lock
// is held.
// - exit: release the lock synchronously, whatever path ends the process
//   (shutdown, a fatal error, instance_lock_lost, a failed listen), so the
//   next start does not wait out the lease.
// - unhandledRejection: log and keep running. A Worker survives a stray
//   rejected promise; the Node host matches that rather than dying on one.
// - uncaughtException: log and exit 1. State after a synchronous throw that
//   escaped every handler is unknown; the exit handler still frees the lock.
export function installProcessHandlers(
  lock: { release(): void },
  proc: Pick<NodeJS.Process, "on" | "exit"> = process,
): void {
  proc.on("exit", () => {
    try {
      lock.release();
    } catch {
      // The database may already be closed; the lease then expires on its own.
    }
  });
  proc.on("unhandledRejection", (reason: unknown) => {
    log.error("unhandled_rejection", { error: message(reason) });
  });
  proc.on("uncaughtException", (e: Error) => {
    log.error("uncaught_exception", { error: message(e) });
    proc.exit(1);
  });
}

// Resolves with p's value, or with undefined after ms (calling onTimeout), so
// one stuck step cannot hold shutdown past the container's grace period.
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      resolve(undefined);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
