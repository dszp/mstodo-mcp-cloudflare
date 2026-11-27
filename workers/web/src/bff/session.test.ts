import { describe, expect, it } from "vitest";
import { clearCookie, cookieHeader, readCookie } from "./cookies.ts";
import { type Device, type Session, deviceFor, sessionState } from "./session.ts";

const limits = { maxHours: 12, idleMinutes: 60 };
const NOW = 1_000_000;
const base: Session = {
  access_token: "a",
  access_exp: NOW + 3600,
  refresh_token: "r",
  data_key: "k",
  created_at: NOW - 100,
  last_seen: NOW - 100,
};

describe("sessionState", () => {
  it("is valid when nothing is near a limit", () => {
    expect(sessionState(base, NOW, limits)).toBe("valid");
  });

  it("expires exactly at the idle limit, not one second before", () => {
    const s = { ...base, last_seen: NOW - 3600 };
    expect(sessionState(s, NOW, limits)).toBe("expired");
    expect(sessionState({ ...s, last_seen: NOW - 3599 }, NOW, limits)).toBe("valid");
  });

  it("expires exactly at the absolute limit, not one second before", () => {
    const s = { ...base, created_at: NOW - 12 * 3600, last_seen: NOW };
    expect(sessionState(s, NOW, limits)).toBe("expired");
    expect(sessionState({ ...s, created_at: NOW - 12 * 3600 + 1 }, NOW, limits)).toBe("valid");
  });

  it("expires when cf_access_exp has passed, exactly at it", () => {
    expect(sessionState({ ...base, cf_access_exp: NOW }, NOW, limits)).toBe("expired");
    expect(sessionState({ ...base, cf_access_exp: NOW + 1 }, NOW, limits)).toBe("valid");
  });

  it("asks for a refresh 59 s before access_exp but not 60 s before", () => {
    expect(sessionState({ ...base, access_exp: NOW + 59 }, NOW, limits)).toBe("refresh");
    expect(sessionState({ ...base, access_exp: NOW + 60 }, NOW, limits)).toBe("valid");
    expect(sessionState({ ...base, access_exp: NOW - 5 }, NOW, limits)).toBe("refresh");
  });

  it("expired wins over refresh", () => {
    const s = { ...base, access_exp: NOW - 5, last_seen: NOW - 3600 };
    expect(sessionState(s, NOW, limits)).toBe("expired");
  });
});

describe("cookieHeader", () => {
  it("carries every required attribute", () => {
    const h = cookieHeader("__Host-potem-session", "abc", 600);
    expect(h).toContain("__Host-potem-session=abc");
    for (const a of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=600"]) {
      expect(h.split("; "), a).toContain(a);
    }
    expect(h).not.toMatch(/Domain=/i);
  });

  it("throws when the value would exceed 4000 bytes", () => {
    expect(() => cookieHeader("__Host-a", "x".repeat(4000), 60)).not.toThrow();
    expect(() => cookieHeader("__Host-a", "x".repeat(4001), 60)).toThrow(/4000/);
  });
});

describe("clearCookie", () => {
  it("empties the value with Max-Age=0 and the same attributes", () => {
    const h = clearCookie("__Host-a");
    expect(h).toContain("__Host-a=;");
    for (const a of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=0"]) {
      expect(h.split("; "), a).toContain(a);
    }
  });
});

describe("readCookie", () => {
  const req = (cookie?: string) => new Request("https://example.com/", cookie ? { headers: { cookie } } : {});

  it("returns null without a Cookie header or a match", () => {
    expect(readCookie(req(), "a")).toBeNull();
    expect(readCookie(req("b=1"), "a")).toBeNull();
  });

  it("finds a cookie among several, tolerating whitespace", () => {
    expect(readCookie(req("x=1;  a=two ; y=3"), "a")).toBe("two");
    expect(readCookie(req("a=first"), "a")).toBe("first");
  });

  it("does not match a cookie whose name only has the wanted name as a prefix or suffix", () => {
    expect(readCookie(req("ab=1; a=2"), "a")).toBe("2");
    expect(readCookie(req("ba=1; a=2"), "a")).toBe("2");
    expect(readCookie(req("ab=1"), "a")).toBeNull();
  });

  it("keeps '=' characters inside the value", () => {
    expect(readCookie(req("a=x=y=="), "a")).toBe("x=y==");
  });
});

describe("deviceFor", () => {
  const d: Device = { client_id: "c", client_secret: "s", server_origin: "https://a.example.com" };
  it("returns the device for its own server and null otherwise", () => {
    expect(deviceFor(d, "https://a.example.com")).toBe(d);
    expect(deviceFor(d, "https://b.example.com")).toBeNull();
    expect(deviceFor(null, "https://a.example.com")).toBeNull();
  });
});
