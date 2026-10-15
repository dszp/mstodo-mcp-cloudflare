import { describe, it, expect } from "vitest";
import { parseDateInput, toGraphDateTime, zonedWallTimeToUtc } from "../src/util/dates";

const NY = "America/New_York";

describe("zonedWallTimeToUtc", () => {
  it("converts an EDT wall time", () => {
    expect(zonedWallTimeToUtc("2026-10-20T00:00:00", NY)).toBe(Date.parse("2026-10-20T04:00:00Z"));
  });

  it("converts an EST wall time", () => {
    expect(zonedWallTimeToUtc("2026-12-01T09:30:00", NY)).toBe(Date.parse("2026-12-01T14:30:00Z"));
  });

  it("handles the day DST ends", () => {
    // 2026-11-01: clocks fall back at 02:00 EDT. Noon that day is EST.
    expect(zonedWallTimeToUtc("2026-11-01T12:00:00", NY)).toBe(Date.parse("2026-11-01T17:00:00Z"));
  });

  it("moves a wall time in the spring-forward gap to after the jump", () => {
    // 2026-03-08 02:30 doesn't exist in New York; it reads as 03:30 EDT.
    expect(zonedWallTimeToUtc("2026-03-08T02:30:00", NY)).toBe(Date.parse("2026-03-08T07:30:00Z"));
  });

  it("takes the first occurrence of a repeated fall-back wall time", () => {
    // 2026-11-01 01:30 happens twice; the first is 01:30 EDT.
    expect(zonedWallTimeToUtc("2026-11-01T01:30:00", NY)).toBe(Date.parse("2026-11-01T05:30:00Z"));
  });

  it("treats UTC as identity", () => {
    expect(zonedWallTimeToUtc("2026-10-20T09:00:00", "UTC")).toBe(Date.parse("2026-10-20T09:00:00Z"));
  });

  it("returns null for a malformed wall time", () => {
    expect(zonedWallTimeToUtc("2026-13-40T00:00:00", NY)).toBeNull();
  });
});

describe("toGraphDateTime", () => {
  it("puts a date-only due date at local midnight, like the To Do app", () => {
    expect(toGraphDateTime("2026-10-20", NY)).toEqual({
      dateTime: "2026-10-20T04:00:00.000",
      timeZone: "UTC",
    });
  });

  it("reads a naive datetime as local time", () => {
    expect(toGraphDateTime("2026-10-20T09:00", NY)).toEqual({
      dateTime: "2026-10-20T13:00:00.000",
      timeZone: "UTC",
    });
  });

  it("honors an explicit offset", () => {
    expect(toGraphDateTime("2026-10-20T09:00:00-07:00", NY)).toEqual({
      dateTime: "2026-10-20T16:00:00.000",
      timeZone: "UTC",
    });
  });

  it("honors an explicit Z", () => {
    expect(toGraphDateTime("2026-10-20T09:00:00Z", NY)).toEqual({
      dateTime: "2026-10-20T09:00:00.000",
      timeZone: "UTC",
    });
  });

  it("returns null for garbage", () => {
    expect(toGraphDateTime("next tuesday", NY)).toBeNull();
  });
});

describe("parseDateInput with a time zone", () => {
  it("starts a date-only lower bound at local midnight", () => {
    expect(parseDateInput("2026-10-20", NY, "start")).toBe(Date.parse("2026-10-20T04:00:00Z"));
  });

  it("ends a date-only upper bound at the last ms of the local day", () => {
    // A task due on the 20th is stored as 2026-10-20T04:00Z; due_before the 20th must include it.
    expect(parseDateInput("2026-10-20", NY, "end")).toBe(Date.parse("2026-10-21T04:00:00Z") - 1);
  });

  it("reads a naive datetime as local time", () => {
    expect(parseDateInput("2026-10-20T09:00", NY)).toBe(Date.parse("2026-10-20T13:00:00Z"));
  });

  it("leaves an explicit offset alone", () => {
    expect(parseDateInput("2026-10-20T09:00:00Z", NY, "end")).toBe(Date.parse("2026-10-20T09:00:00Z"));
  });
});
