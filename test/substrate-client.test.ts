import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SubstrateClient,
  compareOrderDateTimeDesc,
  SubstrateSubtaskSchema,
  extractSubtasks,
  type SubstrateTokenProvider,
} from "../src/graph/substrate-client";

// The cross-list move (lossless re-parent) and the My-Day-carry read on the
// copy/delete fallback are the only new Substrate HTTP shapes move_task adds.
// These are precise contracts (URL path, PATCH body, parsed response), easy to
// regress silently, so pin them with a stubbed fetch — mirroring the
// vi.stubGlobal("fetch", …) router pattern used in index-do.test.ts.

const tokens: SubstrateTokenProvider = {
  getSubstrateAccessToken: async () => "tok-exo",
  forceSubstrateRefresh: async () => "tok-exo-2",
};

// A realistic Exchange folder/task id (base64-ish, contains '=' and '-'/'_').
const DEST = "AAMkAGI5KFio3AAA=";
const TASK = "AAMkAGI5Oh5N8AAA=";

type Captured = { url: string; method: string; headers: Record<string, string>; body?: string };

function stubFetch(response: unknown, status = 200): { calls: Captured[] } {
  const calls: Captured[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("compareOrderDateTimeDesc (shared manual-order sort)", () => {
  it("sorts later OrderDateTime first (descending = nearer the top)", () => {
    const arr = ["2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z", "2026-02-01T00:00:00Z"];
    expect([...arr].sort(compareOrderDateTimeDesc)).toEqual([
      "2026-03-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    ]);
  });
  it("places null OrderDateTime last", () => {
    const arr = [null, "2026-01-01T00:00:00Z", null, "2026-02-01T00:00:00Z"];
    expect([...arr].sort(compareOrderDateTimeDesc)).toEqual([
      "2026-02-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
      null,
      null,
    ]);
  });
  it("treats equal values (and two nulls) as equal", () => {
    expect(compareOrderDateTimeDesc("x", "x")).toBe(0);
    expect(compareOrderDateTimeDesc(null, null)).toBe(0);
  });
});

describe("SubstrateClient.reparentTask (lossless cross-list move)", () => {
  it("PATCHes taskfolders/{dest}/tasks/{taskId} with body { ParentFolderId: dest } and returns the parsed task", async () => {
    // Captured web-app shape: the destination folder appears in BOTH the URL
    // path and the body; the response carries a NEW Id encoding the destination.
    const { calls } = stubFetch({ Id: "AAMkAGI5Oh5N8AAA=NEW", ParentFolderId: DEST, Subject: "moved" });
    const client = new SubstrateClient(tokens, "OID:user@tenant");

    const task = await client.reparentTask(DEST, TASK);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe("PATCH");
    expect(call.url).toBe(
      `https://substrate.office.com/todob2/api/v1/taskfolders/${encodeURIComponent(DEST)}/tasks/${encodeURIComponent(TASK)}`,
    );
    expect(JSON.parse(call.body!)).toEqual({ ParentFolderId: DEST });
    expect(call.headers.authorization).toBe("Bearer tok-exo");
    expect(call.headers["x-anchormailbox"]).toBe("OID:user@tenant");
    // Parsed response exposes the new Id + ParentFolderId (passthrough → typed).
    expect(task.Id).toBe("AAMkAGI5Oh5N8AAA=NEW");
    expect(task.ParentFolderId).toBe(DEST);
  });

  it("includes OrderDateTime in the body only when provided", async () => {
    const { calls } = stubFetch({ Id: "x", ParentFolderId: DEST });
    const client = new SubstrateClient(tokens, null);

    await client.reparentTask(DEST, TASK, "2026-05-19T12:00:00Z");

    expect(JSON.parse(calls[0].body!)).toEqual({
      ParentFolderId: DEST,
      OrderDateTime: "2026-05-19T12:00:00Z",
    });
  });
});

describe("SubstrateSubtaskSchema + extractSubtasks", () => {
  it("parses the captured subtask shape leniently", () => {
    const parsed = SubstrateSubtaskSchema.parse({
      CompletedDateTime: null,
      CreatedDateTime: "2026-05-30T04:44:00.55Z",
      Id: "93cc4e58-09b9-42ec-bfe7-8958896b1403",
      OrderDateTime: "2026-05-30T05:52:13.324Z",
      IsCompleted: false,
      Subject: "Step 2",
      ExternalId: null,
    });
    expect(parsed.Id).toBe("93cc4e58-09b9-42ec-bfe7-8958896b1403");
    expect(parsed.OrderDateTime).toBe("2026-05-30T05:52:13.324Z");
    expect(parsed.IsCompleted).toBe(false);
  });

  it("extracts from value / Value / bare array, skipping malformed entries", () => {
    const good = { Id: "a", Subject: "x" };
    expect(extractSubtasks({ value: [good] })).toHaveLength(1);
    expect(extractSubtasks({ Value: [good] })).toHaveLength(1);
    expect(extractSubtasks([good])).toHaveLength(1);
    expect(extractSubtasks({})).toEqual([]);
    expect(extractSubtasks({ value: [good, 42] })).toHaveLength(1); // 42 skipped
  });
});

describe("SubstrateClient.listSubtasks (folder-free subtasks GET)", () => {
  it("GETs /tasks/{taskId}/subtasks and parses the collection", async () => {
    const { calls } = stubFetch({
      value: [
        { Id: "a", Subject: "Step 1", OrderDateTime: "2026-05-30T02:27:25.324Z", IsCompleted: false },
        { Id: "b", Subject: "Step 2", OrderDateTime: "2026-05-30T05:52:13.324Z", IsCompleted: false },
      ],
    });
    const client = new SubstrateClient(tokens, null);

    const subs = await client.listSubtasks(TASK);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(
      `https://substrate.office.com/todob2/api/v1/tasks/${encodeURIComponent(TASK)}/subtasks`,
    );
    expect(subs.map((s) => s.Id)).toEqual(["a", "b"]);
  });
});

describe("SubstrateClient.patchSubtask (set OrderDateTime)", () => {
  const SUBTASK = "93cc4e58-09b9-42ec-bfe7-8958896b1403";
  it("PATCHes /tasks/{taskId}/subtasks/{subtaskId} with the body and returns the parsed subtask", async () => {
    const { calls } = stubFetch({
      Id: SUBTASK,
      Subject: "Step 2",
      OrderDateTime: "2026-05-30T05:52:13.324Z",
      IsCompleted: false,
    });
    const client = new SubstrateClient(tokens, "OID:user@tenant");

    const sub = await client.patchSubtask(TASK, SUBTASK, {
      OrderDateTime: "2026-05-30T05:52:13.324Z",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe(
      `https://substrate.office.com/todob2/api/v1/tasks/${encodeURIComponent(TASK)}/subtasks/${encodeURIComponent(SUBTASK)}`,
    );
    expect(JSON.parse(calls[0].body!)).toEqual({ OrderDateTime: "2026-05-30T05:52:13.324Z" });
    expect(calls[0].headers.authorization).toBe("Bearer tok-exo");
    expect(calls[0].headers["x-anchormailbox"]).toBe("OID:user@tenant");
    expect(sub.OrderDateTime).toBe("2026-05-30T05:52:13.324Z");
  });
});

describe("SubstrateClient.getTask (fallback My-Day read)", () => {
  it("GETs the task and returns its parsed CommittedDay", async () => {
    const { calls } = stubFetch({ Id: TASK, CommittedDay: "2026-05-26T00:00:00Z" });
    const client = new SubstrateClient(tokens, null);

    const task = await client.getTask(DEST, TASK);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(
      `https://substrate.office.com/todob2/api/v1/taskfolders/${encodeURIComponent(DEST)}/tasks/${encodeURIComponent(TASK)}`,
    );
    expect(calls[0].body).toBeUndefined();
    expect(task.CommittedDay).toBe("2026-05-26T00:00:00Z");
  });
});
