import { describe, expect, it, vi } from "vitest";
import { visibleTimeout } from "./visible-timer.ts";

function fakeDoc(state: "visible" | "hidden") {
  const t = new EventTarget() as EventTarget & { visibilityState: "visible" | "hidden" };
  t.visibilityState = state;
  return {
    doc: t,
    set(s: "visible" | "hidden") {
      t.visibilityState = s;
      t.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

describe("visibleTimeout", () => {
  it("runs after the delay while the page is visible", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { doc } = fakeDoc("visible");
    visibleTimeout(doc, 6000, fn);
    vi.advanceTimersByTime(5999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("doesn't count time the page is hidden, and starts again in full once it's shown", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = fakeDoc("hidden");
    visibleTimeout(d.doc, 6000, fn);
    vi.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();
    d.set("visible");
    vi.advanceTimersByTime(5000);
    d.set("hidden");
    vi.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();
    d.set("visible");
    vi.advanceTimersByTime(6000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("cancel stops it and stops listening", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = fakeDoc("visible");
    const cancel = visibleTimeout(d.doc, 6000, fn);
    cancel();
    d.set("hidden");
    d.set("visible");
    vi.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
