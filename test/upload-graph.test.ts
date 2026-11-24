import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphClient, type TokenProvider } from "../src/core/graph/client";
import { attachFile } from "../src/core/upload/graph-upload";

// A GraphClient backed by a static token (no refresh network calls).
const tp: TokenProvider = {
  getAccessToken: async () => "tok",
  forceRefresh: async () => "tok",
};
const graph = new GraphClient(tp);

const realFetch = globalThis.fetch;
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[];

function install(handler: (c: Call) => Response): void {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const c: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body,
    };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const args = (bytes: Uint8Array, maxInlineBytes: number) => ({
  listId: "L1",
  taskId: "T1",
  name: "file.bin",
  bytes,
  contentType: "application/octet-stream",
  maxInlineBytes,
});

describe("attachFile — inline path", () => {
  beforeEach(() => {
    install((c) => {
      if (c.url.endsWith("/attachments") && c.method === "POST") {
        return Response.json(
          { "@odata.type": "#microsoft.graph.taskFileAttachment", id: "INLINE1", name: "file.bin", size: 5 },
          { status: 201 },
        );
      }
      return new Response("unexpected", { status: 500 });
    });
  });

  it("POSTs an inline taskFileAttachment for small files", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const r = await attachFile(graph, "tok", args(bytes, 3072 * 1024));
    expect(r.via).toBe("inline");
    expect(r.attachment_id).toBe("INLINE1");

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toContain("/me/todo/lists/L1/tasks/T1/attachments");
    const body = JSON.parse(post.body as string);
    expect(body["@odata.type"]).toBe("#microsoft.graph.taskFileAttachment");
    expect(typeof body.contentBytes).toBe("string");
    // base64 of [1,2,3,4,5]
    expect(body.contentBytes).toBe(btoa(String.fromCharCode(1, 2, 3, 4, 5)));
  });
});

describe("attachFile — upload-session path", () => {
  it("creates a session then PUTs sequential ranges with the Bearer token", async () => {
    const total = 3_932_160 + 100; // > one 3.75 MiB chunk → two PUTs
    const bytes = new Uint8Array(total);
    let putCount = 0;
    install((c) => {
      if (c.url.endsWith("/createUploadSession") && c.method === "POST") {
        return Response.json(
          {
            uploadUrl:
              "https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/T1/attachmentSessions/S1",
            nextExpectedRanges: ["0-"],
          },
          { status: 200 },
        );
      }
      if (c.url.endsWith("/content") && c.method === "PUT") {
        putCount += 1;
        if (putCount === 1) {
          return Response.json({ nextExpectedRanges: ["3932160"] }, { status: 200 });
        }
        return new Response(null, {
          status: 201,
          headers: {
            Location:
              "https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/T1/attachments/SESSION1",
          },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    const r = await attachFile(graph, "tok", args(bytes, 3072 * 1024));
    expect(r.via).toBe("session");
    expect(r.attachment_id).toBe("SESSION1");
    expect(r.size).toBe(total);

    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[0].url).toBe(
      "https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/T1/attachmentSessions/S1/content",
    );
    expect(puts[0].headers["content-range"]).toBe(`bytes 0-3932159/${total}`);
    expect(puts[1].headers["content-range"]).toBe(`bytes 3932160-${total - 1}/${total}`);
    // To Do upload-session PUTs are graph-hosted and DO require the Bearer token.
    expect(puts[0].headers["authorization"]).toBe("Bearer tok");
    expect(puts[1].headers["authorization"]).toBe("Bearer tok");
  });
});

// Graph has been seen answering 500 generalException both on inline POSTs that
// stored nothing and on upload-session final PUTs that DID store the file.
// attachFile snapshots the task's attachment ids and checks again on a 5xx.
describe("attachFile — Graph 5xx recovery", () => {
  const SESSION_URL = "https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/T1/attachmentSessions/S1";
  const graph500 = () =>
    Response.json({ error: { code: "generalException", message: "Internal Server Error" } }, { status: 500 });
  const att = (id: string, name: string) => ({ "@odata.type": "#microsoft.graph.taskFileAttachment", id, name, size: 300 });

  // A fake task: `stored` is what a GET of the collection returns. Each write
  // option says what the call answers and whether the file lands.
  function fakeTask(opts: {
    initial?: { id: string; name: string }[];
    listStatus?: number;
    inline: "ok" | "500-stored" | "500-lost";
    finalPut?: "201" | "500-stored" | "500-lost";
    firstPutOf2?: "200" | "500";
  }) {
    const stored = [...(opts.initial ?? [])];
    install((c) => {
      if (c.url.endsWith("/attachments") && c.method === "GET") {
        if (opts.listStatus) return new Response("nope", { status: opts.listStatus });
        return Response.json({ value: stored.map((a) => att(a.id, a.name)) });
      }
      if (c.url.endsWith("/attachments") && c.method === "POST") {
        const name = JSON.parse(c.body as string).name as string;
        if (opts.inline === "ok") {
          stored.push({ id: "INLINE1", name });
          return Response.json(att("INLINE1", name), { status: 201 });
        }
        if (opts.inline === "500-stored") stored.push({ id: "INLINE_STORED", name });
        return graph500();
      }
      if (c.url.endsWith("/createUploadSession")) {
        return Response.json({ uploadUrl: SESSION_URL, nextExpectedRanges: ["0-"] }, { status: 200 });
      }
      if (c.url === `${SESSION_URL}/content` && c.method === "PUT") {
        const range = c.headers["content-range"];
        const [, endStr, totalStr] = /bytes \d+-(\d+)\/(\d+)/.exec(range)!;
        const isFinal = Number(endStr) === Number(totalStr) - 1;
        if (!isFinal) {
          return opts.firstPutOf2 === "500" ? graph500() : Response.json({ nextExpectedRanges: [String(Number(endStr) + 1)] });
        }
        if (opts.finalPut === "201" || opts.finalPut === undefined) {
          stored.push({ id: "SESSION1", name: "file.bin" });
          return new Response(null, { status: 201, headers: { Location: `https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/T1/attachments/SESSION1` } });
        }
        if (opts.finalPut === "500-stored") stored.push({ id: "SESSION_STORED", name: "file.bin" });
        return graph500();
      }
      if (c.url === SESSION_URL && c.method === "DELETE") return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 418 });
    });
  }
  const small = () => new Uint8Array([1, 2, 3]);
  const twoChunks = () => new Uint8Array(3_932_160 + 10);
  const INLINE_MAX = 3072 * 1024;
  const writes = () => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.split("/").pop()}`);

  it("inline 500 with nothing stored: retries through an upload session", async () => {
    fakeTask({ inline: "500-lost", finalPut: "201" });
    const r = await attachFile(graph, "tok", args(small(), INLINE_MAX));
    expect(r).toMatchObject({ via: "session", attachment_id: "SESSION1", size: 3 });
    expect(writes()).toEqual(["POST attachments", "POST createUploadSession", "PUT content"]);
  });

  it("inline 500 that stored the file: returns the stored attachment, no session", async () => {
    fakeTask({ inline: "500-stored" });
    const r = await attachFile(graph, "tok", args(small(), INLINE_MAX));
    expect(r).toMatchObject({ via: "inline", attachment_id: "INLINE_STORED", name: "file.bin", size: 3 });
    expect(writes()).toEqual(["POST attachments"]);
  });

  it("a same-named attachment from before the upload is not mistaken for the new one", async () => {
    fakeTask({ initial: [{ id: "OLD", name: "file.bin" }], inline: "500-lost", finalPut: "201" });
    const r = await attachFile(graph, "tok", args(small(), INLINE_MAX));
    expect(r.attachment_id).toBe("SESSION1");
  });

  it("session final PUT 500 that stored the file: succeeds and does not cancel the session", async () => {
    fakeTask({ inline: "ok", finalPut: "500-stored" });
    const r = await attachFile(graph, "tok", args(twoChunks(), INLINE_MAX));
    expect(r).toMatchObject({ via: "session", attachment_id: "SESSION_STORED", size: 3_932_170 });
    expect(writes()).toEqual(["POST createUploadSession", "PUT content", "PUT content"]);
  });

  it("session final PUT 500 with nothing stored: throws graph_500", async () => {
    fakeTask({ inline: "ok", finalPut: "500-lost" });
    await expect(attachFile(graph, "tok", args(twoChunks(), INLINE_MAX))).rejects.toMatchObject({
      status: 500,
      message: "graph_500",
    });
  });

  it("session 500 on a non-final range: cancels the session and throws", async () => {
    fakeTask({ inline: "ok", firstPutOf2: "500" });
    await expect(attachFile(graph, "tok", args(twoChunks(), INLINE_MAX))).rejects.toMatchObject({ status: 500 });
    expect(writes()).toEqual(["POST createUploadSession", "PUT content", "DELETE S1"]);
  });

  it("inline 500 and both 500s fail: throws after the session attempt", async () => {
    fakeTask({ inline: "500-lost", finalPut: "500-lost" });
    await expect(attachFile(graph, "tok", args(small(), INLINE_MAX))).rejects.toMatchObject({ status: 500 });
    expect(writes()).toEqual(["POST attachments", "POST createUploadSession", "PUT content"]);
  });

  it("without a readable snapshot, an inline 500 is returned as-is (no blind retry)", async () => {
    fakeTask({ listStatus: 404, inline: "500-lost", finalPut: "201" });
    await expect(attachFile(graph, "tok", args(small(), INLINE_MAX))).rejects.toMatchObject({ status: 500 });
    expect(writes()).toEqual(["POST attachments"]);
  });

  it("a 4xx is never retried or reconciled", async () => {
    install((c) => {
      if (c.method === "GET") return Response.json({ value: [] });
      return Response.json({ error: { code: "ErrorInvalidIdMalformed" } }, { status: 400 });
    });
    await expect(attachFile(graph, "tok", args(small(), INLINE_MAX))).rejects.toMatchObject({ status: 400 });
    expect(writes()).toEqual(["POST attachments"]);
  });
});
