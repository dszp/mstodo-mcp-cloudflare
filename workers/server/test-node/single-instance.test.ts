import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/hosts/node/sqlite-db";
import { acquireInstanceLock } from "../src/hosts/node/single-instance";

describe("acquireInstanceLock", () => {
  it("refuses a second holder and allows takeover after release", () => {
    const db = openDatabase(":memory:");
    const a = acquireInstanceLock(db);
    expect(() => acquireInstanceLock(db)).toThrow(/another instance/);
    a.release();
    expect(() => acquireInstanceLock(db).release()).not.toThrow();
  });

  it("takes over a lock whose heartbeat is older than the ttl", () => {
    const db = openDatabase(":memory:");
    acquireInstanceLock(db, 60_000); // never released: a crashed holder
    // Age the heartbeat past the ttl instead of sleeping.
    db.prepare("UPDATE instance_lock SET heartbeat_at = heartbeat_at - 120000").run();
    const b = acquireInstanceLock(db, 60_000);
    expect(() => acquireInstanceLock(db, 60_000)).toThrow(/another instance/);
    b.release();
  });

  it("release by a superseded holder does not delete the new holder's lock", () => {
    const db = openDatabase(":memory:");
    const a = acquireInstanceLock(db, 60_000);
    db.prepare("UPDATE instance_lock SET heartbeat_at = heartbeat_at - 120000").run();
    const b = acquireInstanceLock(db, 60_000);
    a.release();
    expect(() => acquireInstanceLock(db, 60_000)).toThrow(/another instance/);
    b.release();
  });

  it("guards across separate connections to the same file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-"));
    const file = `${dir}/db.sqlite`;
    const db1 = openDatabase(file);
    const db2 = openDatabase(file);
    const a = acquireInstanceLock(db1);
    expect(() => acquireInstanceLock(db2)).toThrow(/another instance/);
    a.release();
    acquireInstanceLock(db2).release();
    db1.close();
    db2.close();
  });

  describe("heartbeat", () => {
    afterEach(() => vi.useRealTimers());

    it("keeps the lock fresh past the ttl and stops beating after release", () => {
      vi.useFakeTimers();
      const db = openDatabase(":memory:");
      const a = acquireInstanceLock(db, 60_000);
      vi.advanceTimersByTime(90_000); // 4 beats; without them the row would be stale
      expect(() => acquireInstanceLock(db, 60_000)).toThrow(/another instance/);
      a.release();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("reports a lost lock when another holder has taken it over", () => {
      vi.useFakeTimers();
      const db = openDatabase(":memory:");
      const onLost = vi.fn();
      const a = acquireInstanceLock(db, 60_000, onLost);
      db.prepare("UPDATE instance_lock SET holder = 'someone-else'").run();
      vi.advanceTimersByTime(20_000);
      expect(onLost).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      a.release();
      expect(db.prepare("SELECT holder FROM instance_lock").get()).toEqual({ holder: "someone-else" });
    });
  });
});
