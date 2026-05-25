import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphClient, type TokenProvider } from "../src/graph/client";
import { attachFile } from "../src/upload/graph-upload";

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
