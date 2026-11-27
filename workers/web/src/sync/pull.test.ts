import { describe, expect, it, vi } from "vitest";
import type { FeedChange, FeedPage } from "./feed";
import { type FetchPage, pullAll } from "./pull";
import { MirrorStore } from "./store";

const listChange = (id: string): FeedChange =>
  ({ kind: "list", id, deleted: true }) as unknown as FeedChange;

function page(cursor: string, has_more: boolean, changes: FeedChange[] = []): FeedPage {
  return { cursor, has_more, changes, backfill: { remaining: 0 } } as unknown as FeedPage;
}
const okPage = (p: FeedPage) => ({ ok: true as const, page: p });
const gone = (error: "cursor_reset" | "cursor_expired" = "cursor_reset") =>
  ({ ok: false as const, status: 410 as const, error });

function scripted(...responses: Awaited<ReturnType<FetchPage>>[]) {
  const calls: (string | null)[] = [];
  const fetchPage: FetchPage = async (cursor) => {
    calls.push(cursor);
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return next;
  };
  return { fetchPage, calls };
}

describe("pullAll", () => {
  it("follows has_more to the end and returns the last cursor", async () => {
    const { fetchPage, calls } = scripted(
      okPage(page("c1", true, [listChange("a")])),
      okPage(page("c2", true, [listChange("b"), listChange("c")])),
      okPage(page("c3", false)),
    );
    const seen: { pages: number; changes: number }[] = [];
    const res = await pullAll(fetchPage, new MirrorStore(), null, (n) => seen.push(n));
    expect(res).toEqual({ cursor: "c3", pages: 3, changes: 3 });
    expect(calls).toEqual([null, "c1", "c2"]);
    expect(seen).toEqual([
      { pages: 1, changes: 1 },
      { pages: 2, changes: 3 },
      { pages: 3, changes: 3 },
    ]);
  });

  it("applies each page as one batch", async () => {
    const p1 = [listChange("a")];
    const p2 = [listChange("b"), listChange("c")];
    const p3: FeedChange[] = [];
    const store = new MirrorStore();
    const spy = vi.spyOn(store, "applyPage");
    const { fetchPage } = scripted(
      okPage(page("c1", true, p1)),
      okPage(page("c2", true, p2)),
      okPage(page("c3", false, p3)),
    );
    await pullAll(fetchPage, store, null);
    expect(spy.mock.calls).toEqual([[p1], [p2], [p3]]);
  });

  it("on 410 restarts once from an empty store", async () => {
    const store = new MirrorStore();
    const clear = vi.spyOn(store, "clear");
    const { fetchPage, calls } = scripted(gone(), okPage(page("n1", true)), okPage(page("n2", false)));
    const res = await pullAll(fetchPage, store, "c1");
    expect(clear).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["c1", null, "n1"]);
    expect(res.cursor).toBe("n2");
  });

  it("a second 410 in the same pull throws", async () => {
    const { fetchPage } = scripted(gone("cursor_reset"), gone("cursor_reset"));
    await expect(pullAll(fetchPage, new MirrorStore(), "c1")).rejects.toThrow(/cursor_reset/);
  });

  it("a 410 on a pull that started from null throws without clearing", async () => {
    const store = new MirrorStore();
    const clear = vi.spyOn(store, "clear");
    const { fetchPage } = scripted(gone("cursor_expired"));
    await expect(pullAll(fetchPage, store, null)).rejects.toThrow(/cursor_expired/);
    expect(clear).not.toHaveBeenCalled();
  });

  it("a 410 after a restart and an applied page throws, clearing only once", async () => {
    const store = new MirrorStore();
    const clear = vi.spyOn(store, "clear");
    const { fetchPage } = scripted(gone(), okPage(page("n1", true)), gone("cursor_reset"));
    await expect(pullAll(fetchPage, store, "c1")).rejects.toThrow(/cursor_reset/);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("restart resets the counts to what the store now holds", async () => {
    const seen: { pages: number; changes: number }[] = [];
    const { fetchPage } = scripted(
      okPage(page("c2", true, [listChange("a")])),
      gone(),
      okPage(page("n1", false, [listChange("b"), listChange("c")])),
    );
    const res = await pullAll(fetchPage, new MirrorStore(), "c1", (n) => seen.push(n));
    expect(res).toEqual({ cursor: "n1", pages: 1, changes: 2 });
    expect(seen).toEqual([
      { pages: 1, changes: 1 },
      { pages: 1, changes: 2 },
    ]);
  });
});
