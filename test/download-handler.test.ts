import { env as rawEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The test pool types env as Cloudflare.Env (no runtime-injected OAUTH_PROVIDER);
// handleDownload takes the global Env. Cast once for the file (see upload-handler).
const env = rawEnv as unknown as Env;
import { handleDownload } from "../src/upload/download-handler";
import { createDownloadCapability, lookupDownloadCapability } from "../src/upload/tokens";

const TOKENS_KEY = "tokens:owner";
const SCOPE = { list_id: "L1", task_id: "T1", attachment_id: "A1" } as const;
const realFetch = globalThis.fetch;

type Call = { url: string; method: string };
let calls: Call[];

// "hi" base64-encoded — what a taskFileAttachment $value GET returns inline.
const HI_B64 = "aGk=";

function installFetch(handler: (c: Call) => Response): void {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = { url: String(input), method: init?.method ?? "GET" };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
}

function attachmentOk(): (c: Call) => Response {
  return (c) => {
    if (c.url.includes("/attachments/") && c.method === "GET") {
      return Response.json(
        {
          "@odata.type": "#microsoft.graph.taskFileAttachment",
          id: "A1",
          name: "note.txt",
          contentType: "text/plain",
          size: 2,
          contentBytes: HI_B64,
        },
        { status: 200 },
      );
    }
    return new Response("unexpected", { status: 500 });
  };
}

async function signIn(): Promise<void> {
  await env.TODO_CACHE.put(
    TOKENS_KEY,
    JSON.stringify({
      access_token: "AT",
      refresh_token: "RT",
      expires_at: Date.now() + 3_600_000,
      scope: "Tasks.ReadWrite",
      obtained_at: Date.now(),
    }),
  );
}

function getReq(token: string, method = "GET"): Request {
  return new Request(`https://x/download?t=${encodeURIComponent(token)}`, { method });
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  await env.TODO_CACHE.delete(TOKENS_KEY);
});

describe("handleDownload routing & auth", () => {
  it("returns null for any non-/download path", async () => {
    expect(await handleDownload(new Request("https://x/other"), env)).toBeNull();
  });

  it("rejects a missing token as link_invalid (401)", async () => {
    const res = await handleDownload(new Request("https://x/download"), env);
    expect(res!.status).toBe(401);
    expect((await res!.json() as { reason: string }).reason).toBe("link_invalid");
  });

  it("rejects an unknown token as link_invalid (401)", async () => {
    const res = await handleDownload(getReq("no-such-capability"), env);
    expect(res!.status).toBe(401);
    expect((await res!.json() as { reason: string }).reason).toBe("link_invalid");
  });

  it("non-GET is 405 and does NOT burn the link", async () => {
    const { token } = await createDownloadCapability(env, SCOPE);
    const res = await handleDownload(getReq(token, "HEAD"), env);
    expect(res!.status).toBe(405);
    // The token is still redeemable afterwards.
    expect((await lookupDownloadCapability(env, token)).ok).toBe(true);
  });

  it("owner not signed in is 503 and does NOT burn the link", async () => {
    const { token } = await createDownloadCapability(env, SCOPE);
    const res = await handleDownload(getReq(token), env);
    expect(res!.status).toBe(503);
    expect((await res!.json() as { reason: string }).reason).toBe("not_authenticated");
    expect((await lookupDownloadCapability(env, token)).ok).toBe(true);
  });
});

describe("handleDownload serve flow", () => {
  beforeEach(signIn);

  it("serves the bytes with download headers and burns the link", async () => {
    installFetch(attachmentOk());
    const { token } = await createDownloadCapability(env, {
      ...SCOPE,
      filename: "note.txt",
      content_type: "text/plain",
      size: 2,
    });
    const res = await handleDownload(getReq(token), env);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toBe("text/plain");
    expect(res!.headers.get("cache-control")).toBe("no-store");
    expect(res!.headers.get("content-length")).toBe("2");
    expect(res!.headers.get("content-disposition")).toContain('filename="note.txt"');
    expect(await res!.text()).toBe("hi");

    // Burned: a second GET fails.
    const res2 = await handleDownload(getReq(token), env);
    expect(res2!.status).toBe(401);
    expect((await res2!.json() as { reason: string }).reason).toBe("link_invalid");
  });

  it("burns BEFORE the Graph fetch — a Graph failure still consumes the link", async () => {
    installFetch(() => new Response("boom", { status: 404 }));
    const { token } = await createDownloadCapability(env, SCOPE);
    const res = await handleDownload(getReq(token), env);
    expect(res!.status).not.toBe(200);
    // Token gone despite the failure.
    expect((await lookupDownloadCapability(env, token)).ok).toBe(false);
  });

  it("returns attachment_unreadable when no contentBytes come back", async () => {
    installFetch((c) => {
      if (c.url.includes("/attachments/") && c.method === "GET") {
        return Response.json(
          { "@odata.type": "#microsoft.graph.taskFileAttachment", id: "A1", name: "note.txt" },
          { status: 200 },
        );
      }
      return new Response("unexpected", { status: 500 });
    });
    const { token } = await createDownloadCapability(env, SCOPE);
    const res = await handleDownload(getReq(token), env);
    expect(res!.status).toBe(502);
    expect((await res!.json() as { reason: string }).reason).toBe("attachment_unreadable");
  });

  it("is gated off when ENABLE_DOWNLOAD_LINKS=false", async () => {
    const { token } = await createDownloadCapability(env, SCOPE);
    const gatedEnv = { ...(env as object), ENABLE_DOWNLOAD_LINKS: "false" } as unknown as Env;
    const res = await handleDownload(getReq(token), gatedEnv);
    expect(res!.status).toBe(404);
    expect((await res!.json() as { reason: string }).reason).toBe("download_disabled");
  });
});
