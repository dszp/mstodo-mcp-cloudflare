// Change feed (docs/SYNC-API.md section 4) on node:sqlite.
import { describe, it, expect } from "vitest";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "../src/core/index/index-core";
import { bareDate } from "../src/core/index/change-feed";
import { runChangeFeedChecks } from "../test/_change-feed-checks";

describe("change feed (node)", async () => {
  const db = openDatabase(":memory:");
  const state = stateStore(db);
  const c = new IndexCore({ sql: sqlDb(db), transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC", OWNER_EMAIL: "o@example.com" } as never });
  c.bootstrap();
  const r = await runChangeFeedChecks(c);
  for (const [name, ok] of Object.entries(r)) it(name, () => expect(ok).toBe(true));
});

describe("bareDate", () => {
  it("reads UTC-midnight and local-midnight storage as the same date", () => {
    expect(bareDate(Date.parse("2026-11-25T00:00:00Z"), "America/New_York")).toBe("2026-11-25");
    expect(bareDate(Date.parse("2026-11-25T05:00:00Z"), "America/New_York")).toBe("2026-11-25");
    expect(bareDate(Date.parse("2026-11-24T14:00:00Z"), "Australia/Brisbane")).toBe("2026-11-25"); // UTC+10
    expect(bareDate(Date.parse("2026-11-24T11:00:00Z"), "Pacific/Auckland")).toBe("2026-11-25"); // UTC+13
    expect(bareDate(Date.parse("2026-11-25T00:00:00Z"), "Pacific/Auckland")).toBe("2026-11-25");
    expect(bareDate(null, "UTC")).toBeNull();
  });
});
