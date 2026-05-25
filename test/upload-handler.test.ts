import { env as rawEnv } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The test pool types env as Cloudflare.Env (no runtime-injected OAUTH_PROVIDER);
// handleUpload takes the global Env. Cast once for the file (see index-do.test.ts).
const env = rawEnv as unknown as Env;
import { handleUpload } from "../src/upload/handler";
import { createUploadCapability } from "../src/upload/tokens";

const TOKENS_KEY = "tokens:owner";
const SCOPE = { list_id: "L1", task_id: "T1" } as const;
const realFetch = globalThis.fetch;

type Call = { url: string; method: string; body: unknown };
let calls: Call[];

function installFetch(handler: (c: Call) => Response): void {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = { url: String(input), method: init?.method ?? "GET", body: init?.body };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
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

function multipartPost(url: string, file: File, token?: string): Request {
  const fd = new FormData();
  fd.append("file", file);
  if (token) fd.append("t", token);
  return new Request(url, { method: "POST", body: fd });
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  await env.TODO_CACHE.delete(TOKENS_KEY);
});

describe("handleUpload routing & auth", () => {
  it("returns null for any non-/upload path", async () => {
    expect(await handleUpload(new Request("https://x/other"), env)).toBeNull();
  });

  it("GET without a token renders the disabled notice (no form)", async () => {
    const res = await handleUpload(new Request("https://x/upload"), env);
    expect(res).not.toBeNull();
    const body = await res!.text();
    expect(body).toContain("one-time upload link");
    expect(body).not.toContain("<form");
  });

  it("GET with a valid token renders the form with the task name, not the id", async () => {
    const { token } = await createUploadCapability(env, {
      ...SCOPE,
      task_title: "Buy milk",
      list_name: "Groceries",
    });
    const res = await handleUpload(
      new Request(`https://x/upload?t=${encodeURIComponent(token)}`),
      env,
    );
    const body = await res!.text();
    expect(body).toContain("<form");
    expect(body).toContain("Buy milk");
    expect(body).toContain("Groceries");
    expect(body).not.toContain("T1"); // the opaque task id must not be shown
  });

  it("POST without a token is unauthorized", async () => {
    const res = await handleUpload(
      multipartPost("https://x/upload", new File(["hi"], "a.txt")),
      env,
    );
    expect(res!.status).toBe(401);
    expect((await res!.json() as { reason: string }).reason).toBe("unauthorized");
  });

  it("POST with a non-multipart body is rejected (415)", async () => {
    const res = await handleUpload(
      new Request("https://x/upload", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=b",
      }),
      env,
    );
    expect(res!.status).toBe(415);
  });

  it("POST with an invalid token is rejected (401)", async () => {
    const res = await handleUpload(
      multipartPost("https://x/upload", new File(["hi"], "a.txt"), "unknown-capability-id"),
      env,
    );
    expect(res!.status).toBe(401);
    expect((await res!.json() as { reason: string }).reason).toBe("link_invalid");
  });
});

describe("handleUpload attach flow", () => {
  beforeEach(signIn);

  it("attaches a new file and reports it", async () => {
    installFetch((c) => {
      if (c.url.endsWith("/attachments") && c.method === "GET") {
        return Response.json({ value: [] }, { status: 200 });
      }
      if (c.url.endsWith("/attachments") && c.method === "POST") {
        return Response.json(
          { "@odata.type": "#microsoft.graph.taskFileAttachment", id: "NEW1", name: "a.txt", size: 2 },
          { status: 201 },
        );
      }
      return new Response("unexpected", { status: 500 });
    });

    const { token } = await createUploadCapability(env, SCOPE);
    const res = await handleUpload(
      multipartPost("https://x/upload", new File(["hi"], "a.txt", { type: "text/plain" }), token),
      env,
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { ok: boolean; files: Array<{ status: string; attachment_id?: string }> };
    expect(body.ok).toBe(true);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].status).toBe("attached");
    expect(body.files[0].attachment_id).toBe("NEW1");
  });

  it("skips a content-duplicate even when Graph's size differs from the raw length", async () => {
    // Regression: Graph reports `size` as the Exchange *storage* size, not the
    // raw byte length, so the list `size` (here 99) does NOT equal the uploaded
    // file's byte length (2). Dedup must still match by content hash.
    const existingBytes = "hi"; // 2 raw bytes
    installFetch((c) => {
      if (c.url.endsWith("/attachments") && c.method === "GET") {
        return Response.json(
          {
            value: [
              { "@odata.type": "#microsoft.graph.taskFileAttachment", id: "E1", name: "a.txt", size: 99 },
            ],
          },
          { status: 200 },
        );
      }
      if (c.url.endsWith("/attachments/E1") && c.method === "GET") {
        return Response.json(
          {
            "@odata.type": "#microsoft.graph.taskFileAttachment",
            id: "E1",
            name: "a.txt",
            size: 99,
            contentBytes: btoa(existingBytes),
          },
          { status: 200 },
        );
      }
      return new Response("unexpected", { status: 500 });
    });

    const { token } = await createUploadCapability(env, SCOPE);
    const res = await handleUpload(
      multipartPost("https://x/upload", new File([existingBytes], "a.txt", { type: "text/plain" }), token),
      env,
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { ok: boolean; files: Array<{ status: string; attachment_id?: string }> };
    expect(body.ok).toBe(true);
    expect(body.files[0].status).toBe("duplicate");
    expect(body.files[0].attachment_id).toBe("E1");
    // No inline POST should have been issued for a duplicate.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});
