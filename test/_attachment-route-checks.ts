// GET /api/v1/attachments/{sid} through a host's whole OAuth front: a real
// /api/v1 token, the index behind ownerIndex, and Graph's `$value` endpoint
// scripted per check. Run by test/attachment-route.test.ts and
// test-node/attachment-route.test.ts.
import { expect } from "vitest";
import { ownerIndex } from "../src/core/owner-index";
import type { AppEnv } from "../src/core/ports";
import { contentDisposition } from "../src/core/upload/handler";
import { ORIGIN, oauthClient } from "../test-node/_oauth-client";

const task = (id: string, title: string) =>
  ({ id, title, status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" }) as never;
const file = (id: string, name: string | undefined, contentType?: string) =>
  ({ "@odata.type": "#microsoft.graph.taskFileAttachment", id, name, size: 5, contentType }) as never;

// What the stubbed Graph answers for a `$value` request. Set per check.
export type GraphReply = (url: string, init?: RequestInit) => Response;
export const graph: { reply: GraphReply; calls: Array<{ url: string; auth: string | null; encoding?: string | null }> } = {
  reply: () => new Response("unscripted", { status: 404 }),
  calls: [],
};

// The `extra` hook for stubMicrosoft: answers attachment `$value` requests.
export function graphAttachments(url: string, init?: RequestInit): Response | undefined {
  if (!url.startsWith("https://graph.microsoft.com/v1.0/me/todo/lists/") || !url.endsWith("/$value")) return undefined;
  const h = new Headers(init?.headers);
  graph.calls.push({ url, auth: h.get("authorization"), encoding: h.get("accept-encoding") });
  return graph.reply(url, init);
}

const bytes = (s: string) => new TextEncoder().encode(s);
const streamOf = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(bytes(x));
      c.close();
    },
  });

export async function runAttachmentRouteChecks(env: AppEnv, fetchFn: (req: Request) => Promise<Response>) {
  const index = ownerIndex(env);
  await index.upsertList({ id: "L1", displayName: "One" } as never);
  await index.upsertTask(task("T1", "with files"), "L1");
  await index.replaceAttachments("T1", "L1", [
    file("A1", "invoice.pdf", "application/pdf"),
    file("A2", 'évil"\r\nX-Injected: 1 (final)\'s.txt'),
    { "@odata.type": "#microsoft.graph.taskReferenceAttachment", id: "A3", name: "a link" } as never,
    // A name whose 255-unit cut would split the emoji, with a content type a
    // Response can't carry; and a lone surrogate with a control character.
    file("A4", `${"a".repeat(254)}\u{1F600}.pdf`, "text/plain\u00e9"),
    file("A5", "half\uD83D.txt", "text/x\u0001y"),
  ]);
  await index.upsertList({ id: "L2", displayName: "Two" } as never);
  await index.upsertList({ id: "LX", displayName: "Soon excluded" } as never);
  await index.upsertTask(task("TX", "in the excluded list"), "LX");
  await index.replaceAttachments("TX", "LX", [file("AX", "secret.pdf", "application/pdf")]);

  const client = oauthClient(fetchFn);
  const get = (path: string, token?: string) =>
    client.send(path, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const err = async (label: string, res: Response, status: number, body: Record<string, unknown>) => {
    expect([label, res.status]).toEqual([label, status]);
    expect([label, res.headers.get("cache-control")]).toEqual([label, "no-store"]);
    expect([label, await res.json()]).toEqual([label, body]);
  };

  // Without a token, and with an /mcp token: the /api/v1 resource refuses both.
  const noToken = await get("/api/v1/attachments/x");
  expect(["no token", noToken.status]).toEqual(["no token", 401]);
  const { access_token: mcpToken } = await client.connect(`${ORIGIN}/mcp`);
  const mcp = await get("/api/v1/attachments/x", mcpToken);
  expect(["/mcp token", mcp.status]).toEqual(["/mcp token", 401]);

  const { access_token: token } = await client.connect(`${ORIGIN}/api/v1`);

  // The attachment sids, from the feed.
  const page = (await (await get("/api/v1/sync/changes?scope=all", token)).json()) as {
    changes: Array<{ kind: string; data?: { title?: string; attachments?: Array<{ id: string; name: string }> } }>;
  };
  const sidOf = (title: string, name: string) => {
    const t = page.changes.find((c) => c.kind === "task" && c.data?.title === title);
    const a = t?.data?.attachments?.find((x) => x.name === name);
    expect([`${name} in the feed`, Boolean(a)]).toEqual([`${name} in the feed`, true]);
    return a!.id;
  };
  const a1 = sidOf("with files", "invoice.pdf");
  const a2 = sidOf("with files", 'évil"\r\nX-Injected: 1 (final)\'s.txt');
  const a3 = sidOf("with files", "a link");
  const a4 = sidOf("with files", `${"a".repeat(254)}\u{1F600}.pdf`);
  // SQLite may store the lone surrogate as U+FFFD already (Node does), so
  // look it up by prefix.
  const a5 = page.changes
    .find((c) => c.kind === "task" && c.data?.title === "with files")!
    .data!.attachments!.find((x) => x.name.startsWith("half"))!.id;
  const ax = sidOf("in the excluded list", "secret.pdf");
  expect(graph.calls).toEqual([]); // nothing so far reached Graph's $value

  // Success: Graph's body streams through with the mirror's content type,
  // Graph's length, and headers that keep the file out of caches and sniffing.
  graph.reply = () =>
    new Response(streamOf(["%PDF", "-1.7"]), { headers: { "content-type": "application/pdf", "content-length": "8" } });
  const ok = await get(`/api/v1/attachments/${a1}`, token);
  expect(ok.status).toBe(200);
  expect(Object.fromEntries(ok.headers)).toMatchObject({
    "content-type": "application/pdf",
    "content-length": "8",
    "content-disposition": `attachment; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  expect(new TextDecoder().decode(await ok.arrayBuffer())).toBe("%PDF-1.7");
  expect(graph.calls.at(-1)).toEqual({
    url: "https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/T1/attachments/A1/$value",
    auth: "Bearer a.e30.s",
    encoding: "identity", // fetch() would decode a compressed body behind Content-Length
  });

  // A hostile name can't inject a header or end the RFC 5987 value early, and
  // no content type in the mirror falls back to octet-stream. No length from
  // Graph means none is sent.
  // An encoded upstream body: fetch() has decoded it, so Graph's length isn't
  // the length of what is forwarded and isn't sent.
  graph.reply = () =>
    new Response(streamOf(["%PDF-1.7"]), { headers: { "content-encoding": "gzip", "content-length": "3" } });
  const encoded = await get(`/api/v1/attachments/${a1}`, token);
  expect(["encoded: status", encoded.status]).toEqual(["encoded: status", 200]);
  expect(["encoded: length", encoded.headers.get("content-length")]).toEqual(["encoded: length", null]);
  expect(new TextDecoder().decode(await encoded.arrayBuffer())).toBe("%PDF-1.7");

  // A name cut at 255 code points keeps the emoji whole; a lone surrogate
  // becomes U+FFFD. A content type with non-ASCII or control characters
  // falls back to octet-stream. Neither throws.
  graph.reply = () => new Response(streamOf(["x"]));
  const long = await get(`/api/v1/attachments/${a4}`, token);
  expect(["long name: status", long.status]).toEqual(["long name: status", 200]);
  expect(long.headers.get("content-type")).toBe("application/octet-stream");
  expect(long.headers.get("content-disposition")).toBe(
    `attachment; filename="${"a".repeat(254)}_"; filename*=UTF-8''${"a".repeat(254)}%F0%9F%98%80`,
  );
  await long.arrayBuffer();
  graph.reply = () => new Response(streamOf(["x"]));
  const half = await get(`/api/v1/attachments/${a5}`, token);
  expect(["lone surrogate: status", half.status]).toEqual(["lone surrogate: status", 200]);
  expect(half.headers.get("content-type")).toBe("application/octet-stream");
  // Each store turns the lone surrogate into one or more U+FFFD on write.
  expect(half.headers.get("content-disposition")).toMatch(/^attachment; filename="half_+\.txt"; filename\*=UTF-8''half(%EF%BF%BD)+\.txt$/);
  // contentDisposition itself (also /download's) never throws on one.
  expect(contentDisposition("half\uD83D.txt")).toBe(`attachment; filename="half_.txt"; filename*=UTF-8''half%EF%BF%BD.txt`);
  expect(contentDisposition("\uDE00x")).toBe(`attachment; filename="_x"; filename*=UTF-8''%EF%BF%BDx`);
  await half.arrayBuffer();

  // A task moved to another list: the bytes are fetched from the task's
  // list now, before the sub-resource scan rewrites attachments.list_id.
  await index.upsertTask(task("T1", "with files"), "L2");
  graph.reply = () => new Response(streamOf(["moved"]));
  const moved = await get(`/api/v1/attachments/${a1}`, token);
  expect(["moved task: status", moved.status]).toEqual(["moved task: status", 200]);
  await moved.arrayBuffer();
  expect(graph.calls.at(-1)?.url).toBe("https://graph.microsoft.com/v1.0/me/todo/lists/L2/tasks/T1/attachments/A1/$value");

  graph.reply = () => new Response(streamOf(["hello"]));
  const named = await get(`/api/v1/attachments/${a2}`, token);
  expect(named.status).toBe(200);
  expect(named.headers.get("x-injected")).toBeNull();
  expect(named.headers.get("content-type")).toBe("application/octet-stream");
  expect(named.headers.get("content-length")).toBeNull();
  expect(named.headers.get("content-disposition")).toBe(
    `attachment; filename="_vil_X-Injected: 1 (final)'s.txt"; ` +
      `filename*=UTF-8''%C3%A9vil%22X-Injected%3A%201%20%28final%29%27s.txt`,
  );
  expect(new TextDecoder().decode(await named.arrayBuffer())).toBe("hello");

  // A reference attachment has no bytes; Graph isn't asked.
  const callsBefore = graph.calls.length;
  await err("reference attachment", await get(`/api/v1/attachments/${a3}`, token), 409, { error: "not_a_file" });
  expect(["reference: no Graph call", graph.calls.length]).toEqual(["reference: no Graph call", callsBefore]);

  // Unknown and malformed sids.
  await err("unknown sid", await get("/api/v1/attachments/00000000-0000-0000-0000-000000000000", token), 404, {
    error: "not_found",
  });
  await err("malformed sid", await get("/api/v1/attachments/%E0%A4%A", token), 404, { error: "not_found" });
  await err("not a sid", await get("/api/v1/attachments/a.b", token), 404, { error: "not_found" });

  // Graph errors: gone upstream, an outage, and throttling past the client's
  // one retry. Each answers JSON with a retry hint; none crashes the route.
  graph.reply = () => new Response(JSON.stringify({ error: { code: "ErrorItemNotFound" } }), { status: 404 });
  await err("gone upstream", await get(`/api/v1/attachments/${a1}`, token), 404, { error: "not_found" });
  graph.reply = () => new Response("down", { status: 503 });
  await err("graph 5xx", await get(`/api/v1/attachments/${a1}`, token), 502, { error: "graph_unavailable", retry: true });
  graph.reply = () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
  await err("graph 429", await get(`/api/v1/attachments/${a1}`, token), 503, { error: "graph_throttled", retry: true });
  graph.reply = () => new Response("no", { status: 403 });
  await err("graph 403", await get(`/api/v1/attachments/${a1}`, token), 502, { error: "graph_403", retry: false });

  // Deleted from the mirror: 404 without asking Graph.
  await index.replaceAttachments("T1", "L1", [file("A1", "invoice.pdf", "application/pdf")]);
  const afterDelete = graph.calls.length;
  await err("deleted attachment", await get(`/api/v1/attachments/${a2}`, token), 404, { error: "not_found" });

  // An excluded list's attachments aren't served, the same as its tasks.
  await index.updateListsConfig({ overrides: { LX: "excluded" } } as never);
  await err("excluded list", await get(`/api/v1/attachments/${ax}`, token), 404, { error: "not_found" });
  expect(["no Graph call for refused requests", graph.calls.length]).toEqual([
    "no Graph call for refused requests",
    afterDelete,
  ]);

  // Only GET.
  const post = await client.send(`/api/v1/attachments/${a1}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(["POST", post.status]).toEqual(["POST", 405]);
}
