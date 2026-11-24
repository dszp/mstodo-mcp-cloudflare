// Push over WebSocket on the Node host (docs/SYNC-API.md section 7.3), and
// IndexCore's announce rules, which both hosts share.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore, announcing } from "../src/core/index/index-core";
import { SocketHub, SOCKET_PATH, type SocketGrant } from "../src/hosts/node/ws-push";
import type { ChangeNotifier } from "../src/core/ports";

function core(notifier: ChangeNotifier) {
  const db = openDatabase(":memory:");
  const state = stateStore(db);
  const c = announcing(new IndexCore({ sql: sqlDb(db), transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never, notifier }));
  c.bootstrap();
  return c;
}
const task = (id: string, title: string, at = "2026-11-24T10:00:00Z") =>
  ({ id, title, status: "notStarted", lastModifiedDateTime: at }) as never;

describe("announce", () => {
  it("announces once per write that moved the log, with the new cursor", async () => {
    const sent: string[] = [];
    const c = core({ announce: (x) => sent.push(x), closeAll: () => {} });
    c.upsertList({ id: "L1", displayName: "One" } as never);
    c.upsertTask(task("T1", "a"), "L1");
    c.upsertTask(task("T1", "a"), "L1"); // identical: nothing logged
    c.getList("L1"); // read
    expect(sent.length).toBe(2);
    expect(sent[1]).toBe(c.syncCursor());
  });

  it("closes every socket on revoke", async () => {
    const closed: string[] = [];
    const c = core({ announce: () => {}, closeAll: (r) => closed.push(r) });
    await c.revokeAllGrants();
    expect(closed).toEqual(["revoked"]);
  });
});

describe("SocketHub", () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function start(hub: SocketHub, authorize: () => Promise<SocketGrant | null>) {
    server = createServer((_q, s) => s.end());
    hub.attach(server, { authorize, cursor: () => "e.7" });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  // Collects every message from the moment of connection, so none is missed.
  function connect(url: string) {
    const ws = new WebSocket(url);
    const msgs: string[] = [];
    ws.on("message", (d) => msgs.push(d.toString()));
    const next = async (n: number) => {
      for (let i = 0; i < 100 && msgs.length < n; i++) await new Promise((r) => setTimeout(r, 10));
      return msgs[n - 1];
    };
    return { ws, msgs, next };
  }

  it("says hello, answers ping, and relays changes", async () => {
    const hub = new SocketHub();
    const base = await start(hub, async () => ({ exp: Date.now() + 60_000 }));
    const c = connect(base + SOCKET_PATH);
    expect(JSON.parse((await c.next(1))!)).toEqual({ type: "hello", cursor: "e.7" });
    c.ws.send("ping");
    expect(await c.next(2)).toBe("pong");
    hub.announce("e.8");
    expect(JSON.parse((await c.next(3))!)).toEqual({ type: "changed", cursor: "e.8" });
    hub.closeAll();
    expect(JSON.parse((await c.next(4))!)).toEqual({ type: "reauth" });
  });

  it("refuses an unauthenticated upgrade and other paths", async () => {
    const hub = new SocketHub();
    const base = await start(hub, async () => null);
    const status = (url: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(url);
        ws.on("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
        ws.on("error", () => resolve(-1));
      });
    expect(await status(base + SOCKET_PATH)).toBe(401);
    expect(await status(base + "/elsewhere")).toBe(404);
    expect(hub.size).toBe(0);
  });

  it("ends the socket when the token expires", async () => {
    const hub = new SocketHub();
    const base = await start(hub, async () => ({ exp: Date.now() + 150 }));
    const c = connect(base + SOCKET_PATH);
    await c.next(1);
    expect(JSON.parse((await c.next(2))!)).toEqual({ type: "reauth" });
  });
});
