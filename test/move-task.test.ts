import { describe, it, expect } from "vitest";
import type { TodoTask } from "../src/graph/types";
import {
  buildMoveCopyBody,
  isReparentConfirmed,
  decideAfterReparentFailure,
} from "../src/mcp/move-task";

describe("buildMoveCopyBody (fallback create-in-destination body)", () => {
  it("copies only the writable scalar fields that are present", () => {
    const src: TodoTask = {
      id: "old-id",
      title: "Pay invoice",
      status: "notStarted",
      importance: "high",
      body: { content: "<p>do it</p>", contentType: "html" },
      dueDateTime: { dateTime: "2026-06-01T00:00:00.0000000", timeZone: "UTC" },
      isReminderOn: false,
      categories: ["Finance"],
    };
    expect(buildMoveCopyBody(src)).toEqual({
      title: "Pay invoice",
      status: "notStarted",
      importance: "high",
      body: { content: "<p>do it</p>", contentType: "html" },
      dueDateTime: { dateTime: "2026-06-01T00:00:00.0000000", timeZone: "UTC" },
      isReminderOn: false,
      categories: ["Finance"],
    });
  });

  it("omits absent fields, empty categories, and never copies id or sub-resources", () => {
    const src = {
      id: "old-id",
      title: "Bare task",
      status: "notStarted",
      categories: [],
      checklistItems: [{ id: "c1", displayName: "x" }],
      linkedResources: [{ id: "lr1", applicationName: "App" }],
      hasAttachments: true,
    } as unknown as TodoTask;
    const body = buildMoveCopyBody(src);
    expect(body).toEqual({ title: "Bare task", status: "notStarted" });
    expect(body).not.toHaveProperty("id");
    expect(body).not.toHaveProperty("categories");
    expect(body).not.toHaveProperty("checklistItems");
  });

  it("preserves isReminderOn:true and copies recurrence when present", () => {
    const src = {
      id: "x",
      title: "Recurring",
      isReminderOn: true,
      recurrence: { pattern: { type: "daily", interval: 1 } },
    } as unknown as TodoTask;
    const body = buildMoveCopyBody(src);
    expect(body.isReminderOn).toBe(true);
    expect(body.recurrence).toEqual({ pattern: { type: "daily", interval: 1 } });
  });
});

describe("isReparentConfirmed (did the Substrate move actually take?)", () => {
  it("is true only when the response ParentFolderId equals the destination list", () => {
    expect(isReparentConfirmed({ ParentFolderId: "DEST" }, "DEST")).toBe(true);
  });
  it("is false when ParentFolderId is the source / missing / mismatched (silent no-op PATCH)", () => {
    expect(isReparentConfirmed({ ParentFolderId: "SRC" }, "DEST")).toBe(false);
    expect(isReparentConfirmed({}, "DEST")).toBe(false);
    expect(isReparentConfirmed({ ParentFolderId: null }, "DEST")).toBe(false);
  });
});

describe("decideAfterReparentFailure (duplicate-creation guard)", () => {
  it("falls back to copy ONLY when the source is confirmed still present", () => {
    expect(decideAfterReparentFailure({ sourcePresent: true })).toBe("fallback_copy");
  });
  it("treats the move as already done when the source is gone (EWS committed but PATCH response lost)", () => {
    expect(decideAfterReparentFailure({ sourcePresent: false })).toBe("treat_as_moved");
  });
  it("does NOT create a duplicate when source presence is unknown (re-check itself failed)", () => {
    expect(decideAfterReparentFailure({ sourcePresent: "unknown" })).toBe("treat_as_moved");
  });
});
