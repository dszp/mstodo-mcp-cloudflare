import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphClient, type TokenProvider } from "@potem/core/graph/client";
import { attachFile } from "@potem/core/upload/graph-upload";

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

describe("attachFile — Graph reports a failure after committing", () => {
  const total = 3_932_160 + 100;
  const SESSION = "https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/T1/attachmentSessions/S1";
  const att = (id: string) => ({ "@odata.type": "#microsoft.graph.taskFileAttachment", id, name: "file.bin", size: total + 50 });

  // `listings` is what each GET of the attachments collection returns, in order
  // (the last one repeats); the final PUT answers 500 like Graph did live.
  function graphCommitsThenErrors(listings: Array<Array<ReturnType<typeof att>>>): void {
    let puts = 0;
    let gets = 0;
    install((c) => {
      if (c.url.endsWith("/createUploadSession")) return Response.json({ uploadUrl: SESSION, nextExpectedRanges: ["0-"] });
      if (c.url.endsWith("/content") && c.method === "PUT") {
        puts += 1;
        return puts === 1
          ? Response.json({ nextExpectedRanges: ["3932160"] })
          : Response.json({ error: { code: "generalException" } }, { status: 500 });
      }
      if (c.method === "DELETE") return new Response(null, { status: 204 });
      if (c.url.includes("/attachments") && c.method === "GET") {
        const value = listings[Math.min(gets++, listings.length - 1)];
        return Response.json({ value });
      }
      return new Response("unexpected", { status: 500 });
    });
  }

  it("reports the attachment Graph made when the final chunk errors", async () => {
    graphCommitsThenErrors([[], [att("NEW1")]]);
    const r = await attachFile(graph, "tok", args(new Uint8Array(total), 3072 * 1024));
    expect(r).toMatchObject({ attachment_id: "NEW1", via: "session", size: total });
  });

  it("doesn't take a same-name attachment that was already there for the new one", async () => {
    vi.useFakeTimers();
    try {
      graphCommitsThenErrors([[att("OLD1")]]);
      const p = attachFile(graph, "tok", args(new Uint8Array(total), 3072 * 1024));
      const done = expect(p).rejects.toMatchObject({ status: 500 });
      await vi.advanceTimersByTimeAsync(5000);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fails when nothing was attached", async () => {
    vi.useFakeTimers();
    try {
      graphCommitsThenErrors([[]]);
      const p = attachFile(graph, "tok", args(new Uint8Array(total), 3072 * 1024));
      const done = expect(p).rejects.toMatchObject({ status: 500 });
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Graph answered 500 generalException to every inline POST on a live account
// (nothing stored) while upload sessions stored the file and still answered the
// final PUT with 500. An inline 5xx falls through to a session.
describe("attachFile — inline 5xx", () => {
  const SESSION_URL = "https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/T1/attachmentSessions/S1";
  const graph500 = () =>
    Response.json({ error: { code: "generalException", message: "Internal Server Error" } }, { status: 500 });
  const att = (id: string, name: string) => ({ "@odata.type": "#microsoft.graph.taskFileAttachment", id, name, size: 300 });

  // A fake task: `stored` is what a GET of the collection returns; each option
  // says what a write answers and whether the file lands.
  function fakeTask(opts: {
    initial?: { id: string; name: string }[];
    listStatus?: number;
    inline: "500-stored" | "500-lost";
    finalPut?: "201" | "500-stored";
  }) {
    const stored = [...(opts.initial ?? [])];
    install((c) => {
      if (c.url.endsWith("/attachments") && c.method === "GET") {
        if (opts.listStatus) return new Response("nope", { status: opts.listStatus });
        return Response.json({ value: stored.map((a) => att(a.id, a.name)) });
      }
      if (c.url.endsWith("/attachments") && c.method === "POST") {
        if (opts.inline === "500-stored") stored.push({ id: "INLINE_STORED", name: "file.bin" });
        return graph500();
      }
      if (c.url.endsWith("/createUploadSession")) {
        return Response.json({ uploadUrl: SESSION_URL, nextExpectedRanges: ["0-"] });
      }
      if (c.url === `${SESSION_URL}/content` && c.method === "PUT") {
        if (opts.finalPut === "500-stored") {
          stored.push({ id: "SESSION_STORED", name: "file.bin" });
          return graph500();
        }
        stored.push({ id: "SESSION1", name: "file.bin" });
        return new Response(null, {
          status: 201,
          headers: { Location: "https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/T1/attachments/SESSION1" },
        });
      }
      if (c.method === "DELETE") return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 418 });
    });
  }
  const small = () => new Uint8Array([1, 2, 3]);
  const INLINE_MAX = 3072 * 1024;
  const writes = () => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.split("/").pop()}`);

  it("with nothing stored, sends the file through an upload session", async () => {
    fakeTask({ inline: "500-lost", finalPut: "201" });
    const r = await attachFile(graph, "tok", args(small(), INLINE_MAX));
    expect(r).toMatchObject({ via: "session", attachment_id: "SESSION1", size: 3 });
    expect(writes()).toEqual(["POST attachments", "POST createUploadSession", "PUT content"]);
  });

  it("when the session's final PUT also answers 500 but stores the file, reports it attached", async () => {
    fakeTask({ inline: "500-lost", finalPut: "500-stored" });
    const r = await attachFile(graph, "tok", args(small(), INLINE_MAX));
    expect(r).toMatchObject({ via: "session", attachment_id: "SESSION_STORED", size: 3 });
    expect(writes()).toEqual(["POST attachments", "POST createUploadSession", "PUT content"]);
  });

  it("when the POST stored the file anyway, returns it without a session", async () => {
    fakeTask({ inline: "500-stored" });
    const r = await attachFile(graph, "tok", args(small(), INLINE_MAX));
    expect(r).toMatchObject({ via: "inline", attachment_id: "INLINE_STORED", name: "file.bin", size: 3 });
    expect(writes()).toEqual(["POST attachments"]);
  });

  it("doesn't take a same-name attachment that was already there for the new one", async () => {
    fakeTask({ initial: [{ id: "OLD", name: "file.bin" }], inline: "500-lost", finalPut: "201" });
    const r = await attachFile(graph, "tok", args(small(), INLINE_MAX));
    expect(r.attachment_id).toBe("SESSION1");
  });

  it("without a readable snapshot, the inline 500 stands (no blind retry)", async () => {
    fakeTask({ listStatus: 404, inline: "500-lost", finalPut: "201" });
    await expect(attachFile(graph, "tok", args(small(), INLINE_MAX))).rejects.toMatchObject({ status: 500 });
    expect(writes()).toEqual(["POST attachments"]);
  });

  it("a 4xx is neither checked nor retried", async () => {
    install((c) => {
      if (c.method === "GET") return Response.json({ value: [] });
      return Response.json({ error: { code: "ErrorInvalidIdMalformed" } }, { status: 400 });
    });
    await expect(attachFile(graph, "tok", args(small(), INLINE_MAX))).rejects.toMatchObject({ status: 400 });
    expect(writes()).toEqual(["POST attachments"]);
  });
});
