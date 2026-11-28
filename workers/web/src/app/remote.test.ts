import { describe, expect, it, vi } from "vitest";
import { SignedOutError } from "./api.ts";
import { createLatest, loadRemote } from "./remote.ts";
import { debounce } from "./throttle.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const parseNumber = (v: unknown) => (typeof v === "number" ? v : null);
const never = () => new AbortController().signal;

describe("createLatest", () => {
  it("aborts the previous request when the next starts", () => {
    const latest = createLatest();
    const first = latest.next();
    expect(first.aborted).toBe(false);
    const second = latest.next();
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
  });

  it("cancel aborts the one in flight", () => {
    const latest = createLatest();
    const s = latest.next();
    latest.cancel();
    expect(s.aborted).toBe(true);
  });
});

describe("loadRemote", () => {
  it("returns the parsed body", async () => {
    const bff = vi.fn(async () => json(7));
    expect(await loadRemote(bff, "tasks/a", parseNumber, never())).toEqual({ ok: true, data: 7 });
    expect(bff).toHaveBeenCalledWith("tasks/a", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("reports the status of an error response", async () => {
    expect(await loadRemote(async () => json({ error: "not_found" }, 404), "tasks/a", parseNumber, never())).toEqual({ ok: false, status: 404 });
  });

  it("treats a body the parser rejects as a failure", async () => {
    expect(await loadRemote(async () => json("x"), "tasks/a", parseNumber, never())).toEqual({ ok: false, status: 200 });
    expect(await loadRemote(async () => new Response("not json"), "tasks/a", parseNumber, never())).toEqual({ ok: false, status: 200 });
  });

  it("reports a network failure with no status", async () => {
    const bff = async () => {
      throw new TypeError("network");
    };
    expect(await loadRemote(bff, "tasks/a", parseNumber, never())).toEqual({ ok: false, status: null });
  });

  it("answers null for a request aborted mid-flight", async () => {
    const ctl = new AbortController();
    const bff = (_p: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError"))));
    const pending = loadRemote(bff, "search?q=a", parseNumber, ctl.signal);
    ctl.abort();
    expect(await pending).toBeNull();
  });

  it("answers null when the abort lands after the response", async () => {
    const ctl = new AbortController();
    const bff = async () => {
      const res = json(1);
      ctl.abort();
      return res;
    };
    expect(await loadRemote(bff, "search?q=a", parseNumber, ctl.signal)).toBeNull();
  });

  it("answers null when the session ended", async () => {
    const bff = async () => {
      throw new SignedOutError();
    };
    expect(await loadRemote(bff, "search?q=a", parseNumber, never())).toBeNull();
  });

  it("a stale search never overwrites a newer one", async () => {
    const latest = createLatest();
    const resolvers: Array<(r: Response) => void> = [];
    const bff = (_p: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((res, rej) => {
        resolvers.push(res);
        init?.signal?.addEventListener("abort", () => rej(new DOMException("a", "AbortError")));
      });
    const first = loadRemote(bff, "search?q=a", parseNumber, latest.next());
    const second = loadRemote(bff, "search?q=ab", parseNumber, latest.next());
    resolvers[1]!(json(2));
    expect(await second).toEqual({ ok: true, data: 2 });
    expect(await first).toBeNull();
  });
});

describe("debounce", () => {
  it("runs once, with the last arguments, after the quiet period", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = debounce(fn, 150);
      d("a");
      vi.advanceTimersByTime(100);
      d("ab");
      expect(d.pending()).toBe(true);
      vi.advanceTimersByTime(149);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn.mock.calls).toEqual([["ab"]]);
      expect(d.pending()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush runs a pending call now; cancel drops it", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const d = debounce(fn, 150);
      d("a");
      d.flush();
      expect(fn.mock.calls).toEqual([["a"]]);
      d.flush();
      expect(fn).toHaveBeenCalledTimes(1);
      d("b");
      d.cancel();
      vi.advanceTimersByTime(500);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
