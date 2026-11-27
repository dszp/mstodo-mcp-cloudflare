import { describe, it, expect, vi, afterEach } from "vitest";
import {
  SubstrateClient,
  compareOrderDateTimeDesc,
  SubstrateSubtaskSchema,
  extractSubtasks,
  type SubstrateTokenProvider,
} from "@potem/core/graph/substrate-client";

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
  it("compares instants, not strings, when milliseconds are present on only some values", () => {
    // As strings "…45Z" sorts above "…45.623Z" ('Z' > '.'); as instants it's earlier.
    expect(["2026-11-23T23:45:45Z", "2026-11-23T23:45:45.623Z"].sort(compareOrderDateTimeDesc)).toEqual([
      "2026-11-23T23:45:45.623Z",
      "2026-11-23T23:45:45Z",
    ]);
  });
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

describe("SubstrateClient.listSubtasks (inline Subtasks on folder-scoped task GET)", () => {
  it("GETs taskfolders/{folder}/tasks/{id}?$select=* and pulls the inline Subtasks array", async () => {
    // Steps ride inline on the task body (no standalone subtasks collection).
    const { calls } = stubFetch({
      Id: TASK,
      Subject: "parent",
      Subtasks: [
        { Id: "a", Subject: "Step 1", OrderDateTime: "2026-05-30T02:27:25.324Z", IsCompleted: false },
        { Id: "b", Subject: "Step 2", OrderDateTime: null, IsCompleted: false },
      ],
    });
    const client = new SubstrateClient(tokens, null);

    const subs = await client.listSubtasks(DEST, TASK);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(
      `https://substrate.office.com/todob2/api/v1/taskfolders/${encodeURIComponent(DEST)}/tasks/${encodeURIComponent(TASK)}?$select=*`,
    );
    expect(subs.map((s) => s.Id)).toEqual(["a", "b"]);
    expect(subs[1].OrderDateTime).toBeNull();
  });

  it("returns [] when the task has no Subtasks property", async () => {
    stubFetch({ Id: TASK, Subject: "no steps" });
    const client = new SubstrateClient(tokens, null);
    expect(await client.listSubtasks(DEST, TASK)).toEqual([]);
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

describe("SubstrateClient.listFolders / listFolderGroups (sidebar appearance)", () => {
  // Answers each call from `pages` in order, recording the URLs.
  function stubPages(pages: Array<{ status?: number; body: unknown }>) {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        const p = pages.shift() ?? { status: 404, body: {} };
        return new Response(JSON.stringify(p.body), { status: p.status ?? 200, headers: { "content-type": "application/json" } });
      }),
    );
    return urls;
  }
  const BASE = "https://substrate.office.com/todob2/api/v1";

  it("asks for only the appearance fields and parses them, keeping theme values as sent", async () => {
    const urls = stubPages([
      { body: { value: [{ Id: DEST, OrderDateTime: "2026-11-20T10:00:00Z", ParentFolderGroupId: "G1", ThemeColor: "blue", ThemeBackground: { Image: "x" } }] } },
    ]);
    const folders = await new SubstrateClient(tokens, null).listFolders();
    expect(urls).toEqual([`${BASE}/taskfolders?$select=Id,OrderDateTime,ParentFolderGroupId,ThemeColor,ThemeBackground`]);
    expect(folders).toHaveLength(1);
    expect(folders[0]).toMatchObject({ Id: DEST, ParentFolderGroupId: "G1", ThemeColor: "blue", ThemeBackground: { Image: "x" } });
  });

  it("asks again without $select when Substrate refuses it with a 400", async () => {
    const urls = stubPages([{ status: 400, body: { error: { code: "ParseUri" } } }, { body: { value: [{ Id: DEST }] } }]);
    const folders = await new SubstrateClient(tokens, null).listFolders();
    expect(urls).toEqual([expect.stringContaining("$select="), `${BASE}/taskfolders`]);
    expect(folders.map((f) => f.Id)).toEqual([DEST]);
  });

  it("follows @odata.nextLink and ignores the trailing delta link", async () => {
    const urls = stubPages([
      { body: { value: [{ Id: "G1", Name: "One", OrderDateTime: null }], "@odata.nextLink": `${BASE}/foldergroups?$skiptoken=2` } },
      { body: { value: [{ Id: "G2", Name: "Two" }], "@odata.deltaLink": `${BASE}/foldergroups?$deltatoken=3` } },
    ]);
    const groups = await new SubstrateClient(tokens, null).listFolderGroups();
    expect(urls).toEqual([`${BASE}/foldergroups`, `${BASE}/foldergroups?$skiptoken=2`]);
    expect(groups.map((g) => g.Name)).toEqual(["One", "Two"]);
  });

  it("refuses a next link on another host before sending the token", async () => {
    const urls = stubPages([{ body: { value: [], "@odata.nextLink": "https://evil.example.com/steal" } }]);
    await expect(new SubstrateClient(tokens, null).listFolderGroups()).rejects.toMatchObject({ message: "substrate_url_host_rejected" });
    expect(urls).toHaveLength(1);
  });

  it("fails the read on an envelope it doesn't recognize", async () => {
    stubPages([{ body: { groups: [{ Id: "G1" }] } }]);
    await expect(new SubstrateClient(tokens, null).listFolderGroups()).rejects.toMatchObject({ message: "substrate_unexpected_shape" });
  });

  it("fails the read when one item doesn't parse, instead of dropping it", async () => {
    stubPages([{ body: { value: [{ Id: "G1", Name: "ok" }, { Name: "no Id" }] } }]);
    await expect(new SubstrateClient(tokens, null).listFolderGroups()).rejects.toMatchObject({ message: "substrate_unexpected_item" });
  });

  it("accepts an empty collection", async () => {
    stubPages([{ body: { value: [] } }]);
    expect(await new SubstrateClient(tokens, null).listFolderGroups()).toEqual([]);
  });

  it("normalizes an OrderDateTime sent as { DateTime, TimeZone } to an instant string", async () => {
    stubPages([
      { body: { value: [
        { Id: "A", OrderDateTime: { DateTime: "2026-11-23T23:45:45.623", TimeZone: "UTC" } },
        { Id: "B", OrderDateTime: { DateTime: "2026-11-23T23:45:47Z", TimeZone: "UTC" } },
        { Id: "C", OrderDateTime: "2026-11-23T23:45:48Z" },
        { Id: "D", OrderDateTime: null },
      ] } },
    ]);
    const folders = await new SubstrateClient(tokens, null).listFolders();
    expect(folders.map((f) => f.OrderDateTime)).toEqual([
      "2026-11-23T23:45:45.623Z",
      "2026-11-23T23:45:47Z",
      "2026-11-23T23:45:48Z",
      null,
    ]);
  });

  it("with fast set, doesn't retry a 429", async () => {
    const urls = stubPages([{ status: 429, body: {} }, { body: { value: [] } }]);
    await expect(new SubstrateClient(tokens, null).listFolderGroups({ fast: true })).rejects.toMatchObject({ status: 429 });
    expect(urls).toHaveLength(1);
  });

  it("fails rather than return a partial list when the pages don't end", async () => {
    const endless = Array.from({ length: 12 }, () => ({ body: { value: [{ Id: "G" }], "@odata.nextLink": `${BASE}/foldergroups?$skiptoken=n` } }));
    stubPages(endless);
    await expect(new SubstrateClient(tokens, null).listFolderGroups()).rejects.toMatchObject({ message: "substrate_too_many_pages" });
  });
});
