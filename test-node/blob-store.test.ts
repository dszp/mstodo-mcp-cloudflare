// The blob store's index and API half (docs/SYNC-API.md sections 4.6, 4.8,
// 4.9 and 5.2): theme images, a list's image_id, smart-list themes, the
// attachment.delete op and the sweep. A real IndexCore on node SQLite, the
// real mutation pipeline and executor, and an in-memory blob store.
import { afterEach, describe, it, expect, vi } from "vitest";
import { IndexCore } from "../src/core/index/index-core";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { applyBatch } from "../src/core/sync/mutations";
import { syncExecutor } from "../src/core/sync/executor";
import { sweepBlobs, themeImageId, THEME_IMAGE_IDLE_MS } from "../src/core/blobs";
import { themeImageBytes, uploadAttachment, uploadThemeImage } from "../src/core/api/uploads";
import { attachmentBySid } from "../src/core/api/attachments";
import type { AppEnv, BlobStore } from "../src/core/ports";
import type { OpsContext } from "../src/core/ops/context";
import type { FeedChange } from "../src/core/index/change-feed";

function memoryBlobs() {
  const objects = new Map<string, { bytes: Uint8Array; type?: string; uploaded: Date }>();
  const store: BlobStore = {
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return { body: new Blob([o.bytes]).stream(), size: o.bytes.byteLength, httpMetadata: { contentType: o.type } };
    },
    async put(key, value, options) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      objects.set(key, { bytes: new Uint8Array(bytes), type: options?.httpMetadata?.contentType, uploaded: new Date(0) });
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list({ prefix }) {
      return {
        objects: [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, uploaded: o.uploaded })),
        truncated: false,
      };
    },
  };
  return { store, objects };
}

function setup(opts: { blobs?: boolean } = {}) {
  const db = openDatabase(":memory:");
  const sql = sqlDb(db);
  const state = stateStore(db);
  const c = new IndexCore({ sql, transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
  c.bootstrap();
  c.upsertList({ id: "L1", displayName: "Groceries", wellknownListName: "none" } as never);
  c.upsertTask({ id: "T1", title: "milk", status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" } as never, "L1");
  c.replaceAttachments("T1", "L1", [
    { id: "A1", name: "receipt.pdf", size: 10, contentType: "application/pdf", "@odata.type": "#microsoft.graph.taskFileAttachment" },
  ] as never);
  const blobs = memoryBlobs();
  const graphDeletes: string[] = [];
  const env = {
    TIMEZONE: "UTC",
    ...(opts.blobs === false ? {} : { BLOBS: blobs.store }),
    ownerIndex: () => c,
  } as unknown as AppEnv;
  const ctx = {
    env,
    index: c,
    graph: { deleteResource: async (url: string) => void graphDeletes.push(url) },
    writes: { run: (fn: () => Promise<unknown>) => fn() },
  } as unknown as OpsContext;
  const sidOf = (kind: string, graphId: string) =>
    sql.exec<{ sid: string }>("SELECT sid FROM entity_map WHERE kind = ? AND graph_id = ?", kind, graphId).one().sid;
  const settingsSid = sql.exec<{ sid: string }>("SELECT sid FROM entity_map WHERE kind = 'app_settings'").one().sid;
  let n = 0;
  const send = async (op: string, sid: string, fields?: Record<string, unknown>) => {
    const out = await applyBatch(c as never, syncExecutor(ctx), {
      mutations: [{ id: `m${++n}`, at: new Date().toISOString(), op, sid, ...(fields ? { fields } : {}) }],
    }, "test");
    return out.results[0] as { status: string; error?: string };
  };
  const feed = (cursor?: string) => {
    const r = c.syncChanges({ cursor, limit: 1000 });
    if (!r.ok) throw new Error(r.error);
    return r.page;
  };
  return { c, sql, env, blobs, graphDeletes, send, sidOf, settingsSid, feed };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

function upload(env: AppEnv, bytes: Uint8Array, type = "image/jpeg", query = "width=3024&height=4032&brightness=0.42") {
  return uploadThemeImage(
    new Request(`https://x/api/v1/theme-images?${query}`, { method: "POST", headers: { "content-type": type }, body: bytes }),
    env,
  );
}

const ofKind = (changes: FeedChange[], kind: string) => changes.filter((x) => x.kind === kind);

describe("theme images", () => {
  it("uploads, derives the id from the bytes, and logs a theme_image", async () => {
    const t = setup();
    const res = await upload(t.env, JPEG);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; width: number; brightness: number };
    expect(body.id).toBe(await themeImageId(JPEG));
    expect(body).toMatchObject({ content_type: "image/jpeg", size: JPEG.byteLength, width: 3024, height: 4032, brightness: 0.42 });
    expect(t.blobs.objects.has(`theme-images/${body.id}`)).toBe(true);
    const img = ofKind(t.feed().changes, "theme_image");
    expect(img).toHaveLength(1);
    expect(img[0].id).toBe(body.id);
  });

  it("returns the stored image for the same bytes, keeping its dimensions", async () => {
    const t = setup();
    await upload(t.env, JPEG);
    const again = await upload(t.env, JPEG, "image/jpeg", "width=10&height=10");
    expect(again.status).toBe(200);
    expect(((await again.json()) as { width: number }).width).toBe(3024);
  });

  it("refuses bytes that aren't the named type, bad dimensions, and other types", async () => {
    const t = setup();
    expect((await upload(t.env, PNG, "image/jpeg")).status).toBe(415);
    expect((await upload(t.env, JPEG, "image/gif")).status).toBe(415);
    expect((await upload(t.env, JPEG, "image/jpeg", "width=0&height=5")).status).toBe(400);
    expect((await upload(t.env, JPEG, "image/jpeg", "width=5&height=5&brightness=1.5")).status).toBe(400);
  });

  it("accepts HEIC by its ftyp brand", async () => {
    const t = setup();
    const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypheic"), 0, 0, 0, 0]);
    expect((await upload(t.env, heic, "image/heic")).status).toBe(201);
  });

  it("answers 501 without a blob store", async () => {
    const t = setup({ blobs: false });
    expect((await upload(t.env, JPEG)).status).toBe(501);
  });

  it("serves the bytes with immutable caching, and 304 for a matching ETag", async () => {
    const t = setup();
    const { id } = (await (await upload(t.env, JPEG)).json()) as { id: string };
    const res = await themeImageBytes(id, new Request("https://x"), t.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBe(`"${id}"`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
    const cached = await themeImageBytes(id, new Request("https://x", { headers: { "if-none-match": `"${id}"` } }), t.env);
    expect(cached.status).toBe(304);
    expect((await themeImageBytes("0".repeat(32), new Request("https://x"), t.env)).status).toBe(404);
  });
});

describe("a list's image_id", () => {
  it("is set and cleared with list.update and logs the list", async () => {
    const t = setup();
    const { id } = (await (await upload(t.env, JPEG)).json()) as { id: string };
    const list = t.sidOf("list", "L1");
    const before = t.feed().cursor;
    expect(await t.send("list.update", list, { image_id: id })).toMatchObject({ status: "applied" });
    const after = t.feed(before);
    const l = ofKind(after.changes, "list")[0] as Extract<FeedChange, { kind: "list"; deleted: false }>;
    expect(l.data.image_id).toBe(id);
    expect(await t.send("list.update", list, { image_id: null })).toMatchObject({ status: "applied" });
    const cleared = ofKind(t.feed(after.cursor).changes, "list")[0] as Extract<FeedChange, { kind: "list"; deleted: false }>;
    expect(cleared.data.image_id).toBeNull();
  });

  it("rejects an image the server hasn't seen", async () => {
    const t = setup();
    const r = await t.send("list.update", t.sidOf("list", "L1"), { image_id: "a".repeat(32) });
    expect(r).toMatchObject({ status: "rejected", error: "unknown_theme_image" });
  });

  it("is rejected without a blob store", async () => {
    const t = setup({ blobs: false });
    t.c.putThemeImage({ image_id: "b".repeat(32), content_type: "image/jpeg", size: 1, width: 1, height: 1, brightness: null });
    const r = await t.send("list.update", t.sidOf("list", "L1"), { image_id: "b".repeat(32) });
    expect(r).toMatchObject({ status: "rejected", error: "theme_images_unavailable" });
  });
});

describe("smart-list themes", () => {
  it("are in every full sync, all keys null until set", () => {
    const t = setup();
    const s = ofKind(t.feed().changes, "app_settings") as Array<Extract<FeedChange, { kind: "app_settings"; deleted: false }>>;
    expect(s).toHaveLength(1);
    expect(s[0].id).toBe(t.settingsSid);
    expect(s[0].data.smart_lists).toEqual({ my_day: null, important: null, planned: null, all: null, completed: null });
  });

  it("are set per smart list, each with its own field clock", async () => {
    const t = setup();
    const { id } = (await (await upload(t.env, JPEG)).json()) as { id: string };
    expect(await t.send("settings.update", t.settingsSid, { my_day: { color: "dark_blue", image_id: id } })).toMatchObject({ status: "applied" });
    expect(await t.send("settings.update", t.settingsSid, { important: { color: "dark_rose", image_id: null } })).toMatchObject({ status: "applied" });
    const s = ofKind(t.feed().changes, "app_settings")[0] as Extract<FeedChange, { kind: "app_settings"; deleted: false }>;
    expect(s.data.smart_lists.my_day).toEqual({ color: "dark_blue", image_id: id, image_style: null });
    expect(s.data.smart_lists.important).toEqual({ color: "dark_rose", image_id: null, image_style: null });
    expect(Object.keys(await t.c.fieldClocks("app_settings", t.settingsSid)).sort()).toEqual(["important", "my_day"]);
    expect(await t.send("settings.update", t.settingsSid, { my_day: null })).toMatchObject({ status: "applied" });
    const s2 = ofKind(t.feed().changes, "app_settings")[0] as Extract<FeedChange, { kind: "app_settings"; deleted: false }>;
    expect(s2.data.smart_lists.my_day).toBeNull();
  });

  it("refuses a bad color, an unknown key and an unknown image", async () => {
    const t = setup();
    expect(await t.send("settings.update", t.settingsSid, { my_day: { color: "Dark Blue" } })).toMatchObject({ error: "invalid_field:my_day" });
    expect(await t.send("settings.update", t.settingsSid, { tasks: null })).toMatchObject({ error: "unknown_fields:tasks" });
    expect(await t.send("settings.update", t.settingsSid, { my_day: { color: null, image_id: "c".repeat(32) } })).toMatchObject({
      error: "unknown_theme_image",
    });
  });
});

const STYLE = { focus_x: 0.3, focus_y: 0.7, zoom: 1.5, shade: -0.2, blur: 0.1, shade_dark: 0.4 };

describe("image_style", () => {
  it("is set on a list beside its image, alone, and cleared with it", async () => {
    const t = setup();
    const { id } = (await (await upload(t.env, JPEG)).json()) as { id: string };
    const list = t.sidOf("list", "L1");
    const listData = () =>
      (ofKind(t.feed().changes, "list")[0] as Extract<FeedChange, { kind: "list"; deleted: false }>).data;
    expect(await t.send("list.update", list, { image_style: STYLE })).toMatchObject({ status: "applied" });
    expect(listData()).toMatchObject({ image_id: null, image_style: STYLE });
    expect(await t.send("list.update", list, { image_id: id })).toMatchObject({ status: "applied" });
    expect(listData()).toMatchObject({ image_id: id, image_style: STYLE });
    expect(Object.keys(await t.c.fieldClocks("list", list)).sort()).toEqual(["image_id", "image_style"]);
    await t.send("list.update", list, { image_id: null, image_style: null });
    expect(listData()).toMatchObject({ image_id: null, image_style: null });
    expect(t.c.themeImage(id)).not.toBeNull();
  });

  it("is kept in a smart list's theme", async () => {
    const t = setup();
    await t.send("settings.update", t.settingsSid, { planned: { color: null, image_id: null, image_style: STYLE } });
    const s = ofKind(t.feed().changes, "app_settings")[0] as Extract<FeedChange, { kind: "app_settings"; deleted: false }>;
    expect(s.data.smart_lists.planned).toEqual({
      color: null, image_id: null, image_style: { ...STYLE, card_opacity: null, card_opacity_dark: null },
    });
  });

  it("refuses values out of range, missing keys and extra keys", async () => {
    const t = setup();
    const list = t.sidOf("list", "L1");
    for (const bad of [
      { ...STYLE, zoom: 0.5 },
      { ...STYLE, focus_x: 1.1 },
      { ...STYLE, shade: -2 },
      { ...STYLE, blur: "0" },
      { focus_x: 0.5 },
      { ...STYLE, tint: 1 },
      { ...STYLE, shade_dark: 1.5 },
    ]) {
      expect(await t.send("list.update", list, { image_style: bad })).toMatchObject({ error: "invalid_field:image_style" });
    }
    expect(await t.send("settings.update", t.settingsSid, { all: { image_style: { ...STYLE, zoom: 9 } } })).toMatchObject({
      error: "invalid_field:all",
    });
  });
});

describe("image_style shade_dark", () => {
  it("is optional: missing or null is stored as null", async () => {
    const t = setup();
    const list = t.sidOf("list", "L1");
    const { shade_dark: _omit, ...five } = STYLE;
    const listData = () =>
      (ofKind(t.feed().changes, "list")[0] as Extract<FeedChange, { kind: "list"; deleted: false }>).data;
    expect(await t.send("list.update", list, { image_style: five })).toMatchObject({ status: "applied" });
    const unset = { shade_dark: null, card_opacity: null, card_opacity_dark: null };
    expect(listData().image_style).toEqual({ ...five, ...unset });
    expect(await t.send("list.update", list, { image_style: { ...five, shade_dark: null } })).toMatchObject({ status: "applied" });
    expect(listData().image_style).toEqual({ ...five, ...unset });
  });
});

describe("image_style card opacity", () => {
  const FIVE = { focus_x: 0.5, focus_y: 0.5, zoom: 1, shade: 0, blur: 0 };

  it("card_opacity and card_opacity_dark are optional and stored as null when missing", async () => {
    const t = setup();
    const list = t.sidOf("list", "L1");
    expect(await t.send("list.update", list, { image_style: FIVE })).toMatchObject({ status: "applied" });
    const data = (ofKind(t.feed().changes, "list")[0] as Extract<FeedChange, { kind: "list"; deleted: false }>).data;
    expect(data.image_style).toEqual({ ...FIVE, shade_dark: null, card_opacity: null, card_opacity_dark: null });
  });

  it("a colour theme carries a style with no image, on a list and a smart list", async () => {
    const t = setup();
    const list = t.sidOf("list", "L1");
    const style = { ...FIVE, shade_dark: null, card_opacity: 0.6, card_opacity_dark: 0.4 };
    expect(await t.send("list.update", list, { image_id: null, image_style: style })).toMatchObject({ status: "applied" });
    expect(await t.send("settings.update", t.settingsSid, { important: { color: "dark_rose", image_id: null, image_style: style } })).toMatchObject({
      status: "applied",
    });
    const changes = t.feed().changes;
    const l = (ofKind(changes, "list")[0] as Extract<FeedChange, { kind: "list"; deleted: false }>).data;
    expect(l).toMatchObject({ image_id: null, image_style: style });
    const s = (ofKind(changes, "app_settings")[0] as Extract<FeedChange, { kind: "app_settings"; deleted: false }>).data;
    expect(s.smart_lists.important).toEqual({ color: "dark_rose", image_id: null, image_style: style });
  });

  it("refuses card opacity outside 0.2..1", async () => {
    const t = setup();
    const list = t.sidOf("list", "L1");
    for (const bad of [{ card_opacity: 0.1 }, { card_opacity: 1.01 }, { card_opacity_dark: 0 }, { card_opacity: "1" }]) {
      expect(await t.send("list.update", list, { image_style: { ...FIVE, ...bad } })).toMatchObject({ error: "invalid_field:image_style" });
    }
  });
});

describe("theme_image.delete", () => {
  it("refuses an image in use, then deletes it and its bytes", async () => {
    const t = setup();
    const { id } = (await (await upload(t.env, JPEG)).json()) as { id: string };
    const list = t.sidOf("list", "L1");
    await t.send("list.update", list, { image_id: id });
    expect(await t.send("theme_image.delete", id)).toMatchObject({ status: "rejected", error: "theme_image_in_use" });
    await t.send("list.update", list, { image_id: null });
    expect(await t.send("theme_image.delete", id)).toMatchObject({ status: "applied" });
    expect(t.blobs.objects.has(`theme-images/${id}`)).toBe(false);
    const img = ofKind(t.feed().changes, "theme_image");
    expect(img).toEqual([]);
  });
});

describe("attachments", () => {
  it("attachment.delete removes it from Graph, the mirror and the blob store", async () => {
    const t = setup();
    const sid = t.sidOf("attachment", "A1");
    await t.blobs.store.put(`attachments/${sid}`, new Uint8Array([1]));
    expect(await t.send("attachment.delete", sid)).toMatchObject({ status: "applied" });
    expect(t.graphDeletes[0]).toContain("/lists/L1/tasks/T1/attachments/A1");
    expect(t.blobs.objects.has(`attachments/${sid}`)).toBe(false);
    const task = ofKind(t.feed().changes, "task")[0] as Extract<FeedChange, { kind: "task"; deleted: false }>;
    expect(task.data.attachments).toEqual([]);
  });

  it("a first download fetches from Graph and stores a copy for the next", async () => {
    const t = setup();
    const index = new Proxy(t.c, {
      get(target, key) {
        if (key === "getAccessToken") return async () => "token";
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const env = { ...t.env, ownerIndex: () => index } as unknown as AppEnv;
    const sid = t.sidOf("attachment", "A1");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(new Uint8Array([5, 6, 7, 8]));
    });
    try {
      const first = await attachmentBySid(sid, env);
      expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([5, 6, 7, 8]));
      expect(first.headers.get("content-length")).toBe("4");
      expect(t.blobs.objects.has(`attachments/${sid}`)).toBe(true);
      const second = await attachmentBySid(sid, env);
      expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array([5, 6, 7, 8]));
      expect(calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a download is served from the blob store's copy", async () => {
    const t = setup();
    const sid = t.sidOf("attachment", "A1");
    await t.blobs.store.put(`attachments/${sid}`, new Uint8Array([7, 7, 7]));
    const res = await attachmentBySid(sid, t.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("3");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7, 7, 7]));
  });
});

describe("the blob sweep", () => {
  it("deletes copies the mirror no longer has and images unused for 30 days", async () => {
    const t = setup();
    const { id } = (await (await upload(t.env, JPEG)).json()) as { id: string };
    const keep = t.sidOf("attachment", "A1");
    await t.blobs.store.put(`attachments/${keep}`, new Uint8Array([1]));
    await t.blobs.store.put(`attachments/${"d".repeat(32)}`, new Uint8Array([1]));
    await t.blobs.store.put(`theme-images/${"e".repeat(32)}`, new Uint8Array([1]));
    const now = Date.now();
    await sweepBlobs(t.blobs.store, t.c as never, now);
    expect([...t.blobs.objects.keys()].sort()).toEqual([`attachments/${keep}`, `theme-images/${id}`]);
    // Marked unused on that sweep; gone once 30 days have passed since.
    await sweepBlobs(t.blobs.store, t.c as never, now + THEME_IMAGE_IDLE_MS - 1);
    expect(t.blobs.objects.has(`theme-images/${id}`)).toBe(true);
    await sweepBlobs(t.blobs.store, t.c as never, now + THEME_IMAGE_IDLE_MS);
    expect(t.blobs.objects.has(`theme-images/${id}`)).toBe(false);
    expect(t.c.themeImage(id)).toBeNull();
  });

  it("never deletes an image a list uses", async () => {
    const t = setup();
    const { id } = (await (await upload(t.env, JPEG)).json()) as { id: string };
    await t.send("list.update", t.sidOf("list", "L1"), { image_id: id });
    const now = Date.now();
    await sweepBlobs(t.blobs.store, t.c as never, now);
    await sweepBlobs(t.blobs.store, t.c as never, now + 2 * THEME_IMAGE_IDLE_MS);
    expect(t.c.themeImage(id)).not.toBeNull();
  });
});

describe("POST /api/v1/attachments", () => {
  // The real index with a stand-in Microsoft token; Graph is a fetch stub.
  function uploadSetup() {
    const t = setup();
    const index = new Proxy(t.c, {
      get(target, key) {
        if (key === "getAccessToken") return async () => "token";
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const env = { ...t.env, TODO_CACHE: { get: async () => null }, ownerIndex: () => index } as unknown as AppEnv;
    const posts: string[] = [];
    let next = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(url);
        const body = JSON.parse(String(init.body)) as { name: string; contentType: string };
        return Response.json({ "@odata.type": "#microsoft.graph.taskFileAttachment", id: `A${++next + 1}`, name: body.name, size: 3, contentType: body.contentType }, { status: 201 });
      }
      return Response.json({ value: [] });
    });
    const send = (sid: string, opts: { task?: string; name?: string } = {}) =>
      uploadAttachment(
        new Request(
          `https://x/api/v1/attachments?task_id=${opts.task ?? t.sidOf("task", "T1")}&sid=${sid}&name=${encodeURIComponent(opts.name ?? "note.txt")}`,
          { method: "POST", headers: { "content-type": "text/plain" }, body: new Uint8Array([104, 105, 10]) },
        ),
        env,
        undefined,
      );
    return { ...t, env, posts, send };
  }
  const SID = "0190a1b2-c3d4-7e5f-8a9b-00000000aa01";
  afterEach(() => vi.unstubAllGlobals());

  it("attaches through Graph, records it under the app's sid, and keeps a copy", async () => {
    const t = uploadSetup();
    const res = await t.send(SID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "applied", sid: SID });
    expect(t.posts).toHaveLength(1);
    const task = ofKind(t.feed().changes, "task")[0] as Extract<FeedChange, { kind: "task"; deleted: false }>;
    expect(task.data.attachments.map((a) => [a.id, a.name, a.content_type])).toContainEqual([SID, "note.txt", "text/plain"]);
    expect(t.blobs.objects.has(`attachments/${SID}`)).toBe(true);
  });

  it("returns duplicate for the same sid without attaching again", async () => {
    const t = uploadSetup();
    await t.send(SID);
    const again = await t.send(SID);
    expect(await again.json()).toMatchObject({ status: "duplicate", sid: SID });
    expect(t.posts).toHaveLength(1);
  });

  it("refuses an unknown task and a missing name", async () => {
    const t = uploadSetup();
    expect((await t.send(SID, { task: "0190a1b2-c3d4-7e5f-8a9b-00000000ffff" })).status).toBe(404);
    expect((await t.send(SID, { name: " " })).status).toBe(400);
    expect(t.posts).toHaveLength(0);
  });
});

describe("capabilities", () => {
  async function capabilities(env: Record<string, unknown>) {
    const db = openDatabase(":memory:");
    const state = stateStore(db);
    const c = new IndexCore({ sql: sqlDb(db), transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC", ...env } as never });
    c.bootstrap();
    return (await c.syncInfo()).capabilities;
  }

  it("reports the blob store's features when BLOBS is bound", async () => {
    expect(await capabilities({ BLOBS: memoryBlobs().store })).toMatchObject({
      attachment_upload: true, attachment_cache: true, theme_images: true,
    });
  });

  it("reports them off without it, uploads still on", async () => {
    expect(await capabilities({})).toMatchObject({ attachment_upload: true, attachment_cache: false, theme_images: false });
  });
});
