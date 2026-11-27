// Push socket on the Durable Object (docs/SYNC-API.md section 7.2): the
// upgrade, hello, auto-answered ping, and a changed message after a write.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("push socket (Durable Object)", () => {
  it("greets, answers ping, and announces a write", async () => {
    const stub = env.TODO_INDEX_DO.getByName("ws-push");
    const res = await stub.fetch("https://do/socket", {
      headers: { upgrade: "websocket", "x-sync-exp": String(Date.now() + 60_000) },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const msgs: string[] = [];
    ws.addEventListener("message", (e) => msgs.push(String(e.data)));
    ws.accept();
    const next = async (n: number) => {
      for (let i = 0; i < 200 && msgs.length < n; i++) await new Promise((r) => setTimeout(r, 10));
      return msgs[n - 1];
    };
    expect(JSON.parse((await next(1))!).type).toBe("hello");
    ws.send("ping");
    expect(await next(2)).toBe("pong");
    await stub.upsertList({ id: "L1", displayName: "One" } as never);
    const changed = JSON.parse((await next(3))!);
    expect(changed.type).toBe("changed");
    expect(changed.cursor).toBe(await stub.syncCursor());
    ws.close(1000, "done");
  });

  it("refuses an expired grant and a non-upgrade request", async () => {
    const stub = env.TODO_INDEX_DO.getByName("ws-push-2");
    const expired = await stub.fetch("https://do/socket", { headers: { upgrade: "websocket", "x-sync-exp": "1" } });
    expect(expired.status).toBe(401);
    expect((await stub.fetch("https://do/socket")).status).toBe(426);
  });
});
