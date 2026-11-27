import { describe, expect, it } from "vitest";
import {
  SESSION_IDLE_MS,
  SESSION_TOUCH_EVERY_MS,
  sessionExpiry,
  shouldTouch,
} from "@potem/core/mcp/session-expiry";

const now = 1_800_000_000_000;

describe("sessionExpiry", () => {
  it("expires a session that never served a request", () => {
    expect(sessionExpiry(undefined, now)).toEqual({ expire: true });
  });
  it("expires a session idle for exactly the limit", () => {
    expect(sessionExpiry(now - SESSION_IDLE_MS, now)).toEqual({ expire: true });
  });
  it("keeps a recently used session and checks again when it would expire", () => {
    expect(sessionExpiry(now - 60_000, now)).toEqual({
      expire: false,
      checkInSeconds: (SESSION_IDLE_MS - 60_000) / 1000,
    });
  });
  it("never schedules a check sooner than one second", () => {
    expect(sessionExpiry(now - SESSION_IDLE_MS + 1, now)).toEqual({ expire: false, checkInSeconds: 1 });
  });
});

describe("shouldTouch", () => {
  it("writes on the first request after a wake", () => {
    expect(shouldTouch(0, now)).toBe(true);
  });
  it("skips the write within the touch interval", () => {
    expect(shouldTouch(now - SESSION_TOUCH_EVERY_MS + 1, now)).toBe(false);
  });
  it("keeps the touch interval well inside the idle limit", () => {
    expect(SESSION_TOUCH_EVERY_MS * 4).toBeLessThanOrEqual(SESSION_IDLE_MS);
  });
});
