import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

// Pins the Node host's runtime constraint: Node >= 24 with the built-in
// node:sqlite and FTS5, so no native SQLite dependency is needed.
describe("node runtime", () => {
  it("node:sqlite supports FTS5 with bm25()", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body)");
    db.prepare("INSERT INTO t(body) VALUES (?)").run("buy milk and eggs");
    const rows = db
      .prepare("SELECT body, bm25(t) AS rank FROM t WHERE t MATCH ? ORDER BY rank")
      .all("milk") as Array<{ body: string; rank: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("buy milk and eggs");
    expect(typeof rows[0].rank).toBe("number");
    db.close();
  });
});
