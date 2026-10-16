import { describe, it, expect } from "vitest";
import { openDatabase, sqlDb } from "../src/hosts/node/sqlite-db";
import { sqliteKv } from "../src/hosts/node/sqlite-kv";
import { stateStore } from "../src/hosts/node/state-store";
import { SCHEMA_DDL } from "../src/core/index/sql";
import { applyMigrations } from "../src/core/index/migrations";

describe("sqlDb", () => {
  it("runs multi-statement DDL and parameterized queries", () => {
    const sql = sqlDb(openDatabase(":memory:"));
    sql.exec("CREATE TABLE a(x TEXT); CREATE VIRTUAL TABLE f USING fts5(x);");
    sql.exec("INSERT INTO a VALUES (?)", "one");
    expect(sql.exec<{ x: string }>("SELECT x FROM a").toArray()).toEqual([{ x: "one" }]);
    expect(sql.exec<{ n: number }>("SELECT count(*) n FROM a").one().n).toBe(1);
    expect(() => sql.exec("SELECT x FROM a WHERE 0").one()).toThrow();
  });

  it("executes every statement of the real schema, triggers included", () => {
    const sql = sqlDb(openDatabase(":memory:"));
    sql.exec(SCHEMA_DDL);
    applyMigrations(sql);
    sql.exec(
      "INSERT INTO tasks (task_id, list_id, status, title, body_plain) VALUES (?, ?, ?, ?, ?)",
      "t1", "l1", "notStarted", "Renew passport", "bring photos",
    );
    // Only the tasks_ai trigger can have put this row into the FTS mirror.
    const hits = sql.exec<{ task_id: string }>(
      "SELECT t.task_id FROM tasks_fts JOIN tasks t ON t.rowid = tasks_fts.rowid WHERE tasks_fts MATCH ?",
      "passport",
    ).toArray();
    expect(hits).toEqual([{ task_id: "t1" }]);
  });

  it("binds ArrayBuffer params as blobs", () => {
    const sql = sqlDb(openDatabase(":memory:"));
    sql.exec("CREATE TABLE b(x BLOB)");
    sql.exec("INSERT INTO b VALUES (?)", new Uint8Array([1, 2, 3]).buffer);
    expect(sql.exec<{ n: number }>("SELECT length(x) n FROM b").one().n).toBe(3);
  });
});

describe("sqliteKv", () => {
  it("accepts the Workers KV get() spellings the OAuth library uses", async () => {
    const kv = sqliteKv(openDatabase(":memory:"), "ns");
    await kv.put("k", '{"a":1}');
    expect(await kv.get("k", { type: "json" })).toEqual({ a: 1 });
    expect(await kv.get("k")).toBe('{"a":1}');
  });

  it("honors an absolute expiration (epoch seconds), with expirationTtl winning", async () => {
    let t = 1_000_000_000;
    const kv = sqliteKv(openDatabase(":memory:"), "ns", () => t);
    const at = t / 1000 + 60;
    await kv.put("grant:a", "v", { expiration: at, metadata: { m: 1 } });
    await kv.put("both", "v", { expiration: at, expirationTtl: 3600 });
    expect(await kv.get("grant:a")).toBe("v");
    expect((await kv.list({ prefix: "grant:" })).keys).toEqual([{ name: "grant:a", expiration: at, metadata: { m: 1 } }]);
    t += 61_000;
    expect(await kv.get("grant:a")).toBeNull();
    expect((await kv.list({ prefix: "grant:" })).keys).toEqual([]);
    expect(await kv.get("both")).toBe("v");
  });

  it("expires keys by TTL without a sweep", async () => {
    let t = 1_000_000;
    const kv = sqliteKv(openDatabase(":memory:"), "ns", () => t);
    await kv.put("k", "v", { expirationTtl: 60 });
    expect(await kv.get("k", "text")).toBe("v");
    t += 61_000;
    expect(await kv.get("k", "text")).toBeNull();
    expect((await kv.list()).keys).toEqual([]);
  });

  it("pages list() by cursor and returns metadata", async () => {
    const kv = sqliteKv(openDatabase(":memory:"), "ns");
    for (let i = 0; i < 5; i++) await kv.put(`grant:owner:${i}`, "{}", { metadata: { i } });
    await kv.put("client:x", "{}");
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await kv.list({ prefix: "grant:", limit: 2, cursor });
      seen.push(...page.keys.map((k) => k.name));
      expect(page.keys.every((k) => (k.metadata as { i: number }).i >= 0)).toBe(true);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    expect(seen).toEqual([0, 1, 2, 3, 4].map((i) => `grant:owner:${i}`));
  });

  it("isolates namespaces", async () => {
    const db = openDatabase(":memory:");
    await sqliteKv(db, "a").put("k", "1");
    expect(await sqliteKv(db, "b").get("k", "text")).toBeNull();
  });
});

describe("stateStore", () => {
  it("persists values and the alarm", async () => {
    const db = openDatabase(":memory:");
    const s = stateStore(db);
    await s.put("auth:epoch", "abc");
    await s.setAlarm(5000);
    const reopened = stateStore(db);
    expect(await reopened.get("auth:epoch")).toBe("abc");
    expect(await reopened.getAlarm()).toBe(5000);
    await reopened.deleteAlarm();
    expect(await reopened.getAlarm()).toBeNull();
  });
});
