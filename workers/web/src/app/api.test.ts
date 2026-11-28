import { describe, expect, it, vi } from "vitest";
import { MirrorStore } from "../sync/store.ts";
import { SignedOutError, createBffFetch } from "./api.ts";
import { createSessionClient } from "./session.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refreshNeeded = () => json({ error: "session_refresh_needed" }, 401);

/**
 * A fake BFF: /bff/api answers from a queue (the last entry repeats), the
 * refresh answers 204. Records every request as "METHOD path [force]".
 */
function fakeBff(apiAnswers: Array<() => Response>) {
  const log: string[] = [];
  let i = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    log.push(`${method} ${url}${headers.get("x-potem-force") === "1" ? " force" : ""}`);
    if (url === "/bff/session/refresh") return new Response(null, { status: 204 });
    const answer = apiAnswers[Math.min(i++, apiAnswers.length - 1)];
    return answer();
  }) as unknown as typeof fetch;
  const store = new MirrorStore();
  store.applyPage([{ kind: "list", id: "l1", seq: 1, deleted: false, data: { name: "Example" } as never }]);
  const session = createSessionClient(fn, { store, locks: null, channel: null });
  const signedOut = vi.fn();
  session.onSignedOut(signedOut);
  return { log, store, session, signedOut, bffFetch: createBffFetch(fn, session) };
}

describe("bffFetch", () => {
  it("prefixes /bff/api/ and returns the response, whatever its status", async () => {
    const { bffFetch, log } = fakeBff([() => json({ error: "cursor_reset" }, 410)]);
    const res = await bffFetch("sync/changes?scope=active");
    expect(res.status).toBe(410);
    expect(log).toEqual(["GET /bff/api/sync/changes?scope=active"]);
  });

  it("passes a signal to the request, and an aborted request rejects", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const fn = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push(init.signal);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const session = createSessionClient(fn, { store: new MirrorStore(), locks: null, channel: null });
    const bffFetch = createBffFetch(fn, session);
    const ctl = new AbortController();
    const pending = bffFetch("search?q=a", { signal: ctl.signal });
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual([ctl.signal]);
  });

  it("on session_refresh_needed refreshes once and retries", async () => {
    const { bffFetch, log } = fakeBff([refreshNeeded, () => json({ ok: 1 })]);
    const res = await bffFetch("sync/info");
    expect(await res.json()).toEqual({ ok: 1 });
    expect(log).toEqual(["GET /bff/api/sync/info", "POST /bff/session/refresh", "GET /bff/api/sync/info"]);
  });

  it("ten parallel calls needing a refresh share one refresh", async () => {
    let n = 0;
    const { bffFetch, log } = fakeBff([() => (n++ < 10 ? refreshNeeded() : json({ ok: 1 }))]);
    const all = await Promise.all(Array.from({ length: 10 }, () => bffFetch("sync/info")));
    expect(all.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(log.filter((l) => l.startsWith("POST"))).toEqual(["POST /bff/session/refresh"]);
  });

  it("after session_refresh_needed twice, forces one refresh and retries", async () => {
    const { bffFetch, log, signedOut } = fakeBff([refreshNeeded, refreshNeeded, () => json({ ok: 1 })]);
    const res = await bffFetch("sync/info");
    expect(res.status).toBe(200);
    expect(log).toEqual([
      "GET /bff/api/sync/info",
      "POST /bff/session/refresh",
      "GET /bff/api/sync/info",
      "POST /bff/session/refresh force",
      "GET /bff/api/sync/info",
    ]);
    expect(signedOut).not.toHaveBeenCalled();
  });

  it("after session_refresh_needed three times, signs out and stops", async () => {
    const { bffFetch, log, signedOut, store } = fakeBff([refreshNeeded]);
    await expect(bffFetch("sync/info")).rejects.toBeInstanceOf(SignedOutError);
    expect(log).toEqual([
      "GET /bff/api/sync/info",
      "POST /bff/session/refresh",
      "GET /bff/api/sync/info",
      "POST /bff/session/refresh force",
      "GET /bff/api/sync/info",
    ]);
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(store.lists()).toHaveLength(0);
  });

  it("on signed_out clears the store, fires onSignedOut once and throws", async () => {
    const { bffFetch, log, signedOut, store } = fakeBff([() => json({ error: "signed_out" }, 401)]);
    await expect(bffFetch("sync/info")).rejects.toBeInstanceOf(SignedOutError);
    await expect(bffFetch("sync/info")).rejects.toBeInstanceOf(SignedOutError);
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(store.lists()).toHaveLength(0);
    // Once signed out, nothing more is sent.
    expect(log).toEqual(["GET /bff/api/sync/info"]);
  });

  it("drops a response that lands after the page signed out", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { session } = fakeBff([() => json({ ok: 1 })]);
    const slow = createBffFetch(
      (async () => {
        await gate;
        return json({ ok: 1 });
      }) as unknown as typeof fetch,
      session,
    );
    const pending = slow("sync/changes");
    session.markSignedOut();
    release();
    await expect(pending).rejects.toBeInstanceOf(SignedOutError);
  });

  it("a POST sends X-Potem, a JSON content type and the body", async () => {
    const seen: RequestInit[] = [];
    const fn = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push(init);
      return json({ ok: 1 });
    }) as unknown as typeof fetch;
    const session = createSessionClient(fn, { store: new MirrorStore(), locks: null, channel: null });
    const res = await createBffFetch(fn, session)("sync/mutations", { method: "POST", body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith("/bff/api/sync/mutations", expect.anything());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.body).toBe('{"a":1}');
    const headers = new Headers(seen[0]!.headers);
    expect(headers.get("x-potem")).toBe("1");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("a GET sends no X-Potem header, body or method", async () => {
    const seen: Array<RequestInit | undefined> = [];
    const fn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init);
      return json({ ok: 1 });
    }) as unknown as typeof fetch;
    const session = createSessionClient(fn, { store: new MirrorStore(), locks: null, channel: null });
    await createBffFetch(fn, session)("sync/info");
    expect(seen).toEqual([undefined]);
  });

  it("a POST that needs a refresh is sent again with the same body", async () => {
    const bodies: unknown[] = [];
    const log: string[] = [];
    let i = 0;
    const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      log.push(`${init.method ?? "GET"} ${url}`);
      if (url === "/bff/session/refresh") return new Response(null, { status: 204 });
      bodies.push(init.body);
      return i++ === 0 ? refreshNeeded() : json({ ok: 1 });
    }) as unknown as typeof fetch;
    const session = createSessionClient(fn, { store: new MirrorStore(), locks: null, channel: null });
    const res = await createBffFetch(fn, session)("sync/mutations", { method: "POST", body: "[1]" });
    expect(res.status).toBe(200);
    expect(log).toEqual(["POST /bff/api/sync/mutations", "POST /bff/session/refresh", "POST /bff/api/sync/mutations"]);
    expect(bodies).toEqual(["[1]", "[1]"]);
  });

  it("a POST answered signed_out signs out and throws", async () => {
    const { bffFetch, log, signedOut } = fakeBff([() => json({ error: "signed_out" }, 401)]);
    await expect(bffFetch("sync/mutations", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(SignedOutError);
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(log).toEqual(["POST /bff/api/sync/mutations"]);
  });

  it("passes a 401 with another error through", async () => {
    const { bffFetch, signedOut } = fakeBff([() => json({ error: "something_else" }, 401)]);
    expect((await bffFetch("sync/info")).status).toBe(401);
    expect(signedOut).not.toHaveBeenCalled();
  });
});
