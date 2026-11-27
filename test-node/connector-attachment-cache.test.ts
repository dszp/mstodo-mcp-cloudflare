// get_attachment through the MCP tools with a blob store bound: the first
// call reads Graph and keeps a copy, the next is served from the copy in the
// same shape. Same harness shape as list-sync-tools.test.ts.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDatabase } from "../src/hosts/node/sqlite-db";
import { buildNodeEnv } from "../src/hosts/node/env";
import { SCOPES, storeTokens } from "../src/core/auth/microsoft";
import { createMcpServer } from "../src/core/mcp/server";
import { registerTools } from "../src/core/mcp/register-tools";
import { attachmentBlobKey } from "../src/core/blobs";
import { memoryBlobs } from "./_memory-blobs";

const ATT_URL = "https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/T1/attachments/";

async function harness(attachment: Record<string, unknown>) {
  const db = openDatabase(":memory:");
  const { env, core } = buildNodeEnv(db, {
    TIMEZONE: "UTC", MS_TENANT_ID: "t", MS_CLIENT_ID: "c", MS_CLIENT_SECRET: "s",
    OWNER_EMAIL: "test-owner@example.com", ENABLE_MY_DAY: "false",
  });
  const blobs = memoryBlobs();
  (env as { BLOBS?: unknown }).BLOBS = blobs.store;
  await storeTokens(env, { access_token: "a", refresh_token: "r", expires_at: Date.now() + 3_600_000, scope: SCOPES, obtained_at: Date.now() });
  core.upsertList({ id: "L1", displayName: "Groceries", wellknownListName: "none" } as never);
  core.upsertTask({ id: "T1", title: "milk", status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" } as never, "L1");
  const { contentBytes: _omit, ...meta } = attachment;
  core.replaceAttachments("T1", "L1", [meta] as never);
  const graphCalls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    graphCalls.push(url);
    if (url === ATT_URL + attachment.id) return new Response(JSON.stringify(attachment), { status: 200 });
    return new Response(JSON.stringify({ error: { code: "Unscripted", message: url } }), { status: 418 });
  }));
  const server = createMcpServer();
  registerTools(server, { env });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (args: Record<string, unknown>) =>
    (await client.callTool({ name: "get_attachment", arguments: args })) as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    };
  const sidOf = (id: string) => (core.attachmentBlobRef(id) as { sid: string }).sid;
  return { call, graphCalls, blobs, sidOf };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PDF = {
  "@odata.type": "#microsoft.graph.taskFileAttachment", id: "A1", name: "a.pdf",
  contentType: "application/pdf", size: 2, contentBytes: "aGk=",
};

describe("get_attachment with a blob store", () => {
  it("reads Graph once, keeps a copy, and serves the next call from it in the same shape", async () => {
    const h = await harness(PDF);
    const first = JSON.parse((await h.call({ list: "L1", task_id: "T1", attachment_id: "A1" })).content[0].text!);
    expect(first.attachment).toMatchObject({ id: "A1", name: "a.pdf", contentType: "application/pdf", size: 2, contentBytes: "aGk=" });
    expect(h.graphCalls).toHaveLength(1);
    expect(new TextDecoder().decode(h.blobs.objects.get(attachmentBlobKey(h.sidOf("A1")))!.bytes)).toBe("hi");

    const second = JSON.parse((await h.call({ list: "L1", task_id: "T1", attachment_id: "A1" })).content[0].text!);
    expect(h.graphCalls).toHaveLength(1);
    expect(second.attachment).toMatchObject({
      "@odata.type": "#microsoft.graph.taskFileAttachment", id: "A1", name: "a.pdf", contentType: "application/pdf", size: 2, contentBytes: "aGk=",
    });
  });

  it("returns an image from the copy as an image block", async () => {
    const h = await harness({ ...PDF, id: "I1", name: "p.png", contentType: "image/png" });
    await h.call({ list: "L1", task_id: "T1", attachment_id: "I1" });
    const res = await h.call({ list: "L1", task_id: "T1", attachment_id: "I1" });
    expect(h.graphCalls).toHaveLength(1);
    expect(res.content[1]).toEqual({ type: "image", data: "aGk=", mimeType: "image/png" });
    expect(JSON.parse(res.content[0].text!).attachment.contentBytes).toBeUndefined();
  });
});
