import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { TodoTask } from "../src/graph/types";

function indexStub(name: string) {
  return env.TODO_INDEX_DO.getByName(name);
}

// Build a TodoTask with just the fields query/search care about. Dates are ISO
// (createdDateTime/lastModifiedDateTime) or dateTimeTimeZone (due/completed).
function mkTask(
  id: string,
  o: {
    list?: string;
    title?: string;
    status?: string;
    importance?: string;
    due?: string;
    completed?: string;
    created?: string;
    modified?: string;
    body?: string;
    checklist?: number | null; // 1 -> one item, 0 -> empty array, null -> omit
  } = {},
): { task: TodoTask; list: string } {
  const task: TodoTask = {
    id,
    title: o.title ?? `t-${id}`,
    status: o.status ?? "notStarted",
  };
  if (o.importance) task.importance = o.importance;
  if (o.created) task.createdDateTime = o.created;
  if (o.modified) task.lastModifiedDateTime = o.modified;
  if (o.due) task.dueDateTime = { dateTime: o.due, timeZone: "UTC" };
  if (o.completed) task.completedDateTime = { dateTime: o.completed, timeZone: "UTC" };
  if (o.body) task.body = { content: o.body, contentType: "text" };
  if (o.checklist === 1) task.checklistItems = [{ id: "c1" }];
  else if (o.checklist === 0) task.checklistItems = [];
  return { task, list: o.list ?? "list-A" };
}

async function seed(stub: ReturnType<typeof indexStub>, ...specs: ReturnType<typeof mkTask>[]) {
  for (const s of specs) await stub.upsertTask(s.task, s.list);
}

describe("TodoIndex query() filters", () => {
  it("filters by status", async () => {
    const stub = indexStub("q-status");
    await seed(
      stub,
      mkTask("a", { status: "notStarted" }),
      mkTask("b", { status: "completed" }),
      mkTask("c", { status: "inProgress" }),
    );
    const { rows } = await stub.query({ status: ["notStarted", "inProgress"] });
    expect(rows.map((r) => r.task_id).sort()).toEqual(["a", "c"]);
  });

  it("filters by due_before / due_after range (NULL due excluded)", async () => {
    const stub = indexStub("q-due");
    await seed(
      stub,
      mkTask("early", { due: "2026-06-01T00:00:00Z" }),
      mkTask("mid", { due: "2026-06-15T00:00:00Z" }),
      mkTask("late", { due: "2026-07-01T00:00:00Z" }),
      mkTask("none", {}),
    );
    const { rows } = await stub.query({
      due_after: Date.parse("2026-06-10T00:00:00Z"),
      due_before: Date.parse("2026-06-20T00:00:00Z"),
    });
    expect(rows.map((r) => r.task_id)).toEqual(["mid"]);
  });

  it("filters by completed_after", async () => {
    const stub = indexStub("q-completed");
    await seed(
      stub,
      mkTask("old", { status: "completed", completed: "2026-05-01T00:00:00Z" }),
      mkTask("new", { status: "completed", completed: "2026-05-20T00:00:00Z" }),
    );
    const { rows } = await stub.query({
      completed_after: Date.parse("2026-05-10T00:00:00Z"),
    });
    expect(rows.map((r) => r.task_id)).toEqual(["new"]);
  });

  it("filters by lists IN and importance", async () => {
    const stub = indexStub("q-lists-imp");
    await seed(
      stub,
      mkTask("a", { list: "list-A", importance: "high" }),
      mkTask("b", { list: "list-B", importance: "high" }),
      mkTask("c", { list: "list-A", importance: "normal" }),
    );
    expect(
      (await stub.query({ lists: ["list-A"] })).rows.map((r) => r.task_id).sort(),
    ).toEqual(["a", "c"]);
    expect(
      (await stub.query({ importance: "high" })).rows.map((r) => r.task_id).sort(),
    ).toEqual(["a", "b"]);
  });

  it("has_checklist true matches only =1; false matches =0 OR unknown(NULL)", async () => {
    const stub = indexStub("q-checklist");
    await seed(
      stub,
      mkTask("has", { checklist: 1 }),
      mkTask("empty", { checklist: 0 }),
      mkTask("unknown", { checklist: null }),
    );
    expect((await stub.query({ has_checklist: true })).rows.map((r) => r.task_id)).toEqual([
      "has",
    ]);
    expect(
      (await stub.query({ has_checklist: false })).rows.map((r) => r.task_id).sort(),
    ).toEqual(["empty", "unknown"]);
  });
});

describe("TodoIndex query() pagination (keyset)", () => {
  it("paginates by limit + next_cursor with no overlap or gap", async () => {
    const stub = indexStub("q-page");
    // 5 rows, distinct modified_at descending by suffix.
    await seed(
      stub,
      mkTask("t1", { modified: "2026-05-05T00:00:00Z" }),
      mkTask("t2", { modified: "2026-05-04T00:00:00Z" }),
      mkTask("t3", { modified: "2026-05-03T00:00:00Z" }),
      mkTask("t4", { modified: "2026-05-02T00:00:00Z" }),
      mkTask("t5", { modified: "2026-05-01T00:00:00Z" }),
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page: { rows: { task_id: string }[]; next_cursor?: string } =
        await stub.query({ limit: 2, cursor });
      seen.push(...page.rows.map((r) => r.task_id));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(new Set(seen).size).toBe(5);
  });

  it("paginates across NULL-modified rows without dropping them", async () => {
    const stub = indexStub("q-page-null");
    await seed(
      stub,
      mkTask("m1", { modified: "2026-05-02T00:00:00Z" }),
      mkTask("m2", { modified: "2026-05-01T00:00:00Z" }),
      mkTask("n1", {}), // modified_at NULL
      mkTask("n2", {}), // modified_at NULL
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page: { rows: { task_id: string }[]; next_cursor?: string } =
        await stub.query({ limit: 1, cursor });
      seen.push(...page.rows.map((r) => r.task_id));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    // Non-NULL modified first (desc), then the two NULL-modified rows.
    expect(seen.slice(0, 2)).toEqual(["m1", "m2"]);
    expect(seen.slice(2).sort()).toEqual(["n1", "n2"]);
    expect(new Set(seen).size).toBe(4);
  });
});

describe("TodoIndex search() FTS", () => {
  it("matches across lists in title and body, and supports column scoping", async () => {
    const stub = indexStub("q-search");
    await seed(
      stub,
      mkTask("t1", { list: "list-A", title: "Pay invoice" }),
      mkTask("t2", { list: "list-B", title: "Invoice reminder" }),
      mkTask("t3", { list: "list-A", title: "Groceries", body: "monthly invoice pdf" }),
      mkTask("t4", { list: "list-A", title: "Unrelated", body: "nothing here" }),
    );
    expect(
      (await stub.search({ query: "invoice" })).rows.map((r) => r.task_id).sort(),
    ).toEqual(["t1", "t2", "t3"]);
    // Column-scoped: title only → excludes the body-only match (t3).
    expect(
      (await stub.search({ query: "title:invoice" })).rows.map((r) => r.task_id).sort(),
    ).toEqual(["t1", "t2"]);
    // List-scoped search.
    expect(
      (await stub.search({ query: "invoice", lists: ["list-B"] })).rows.map(
        (r) => r.task_id,
      ),
    ).toEqual(["t2"]);
  });
});
