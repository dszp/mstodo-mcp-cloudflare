import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canAddTask, keyActsOnOpenTask } from "./views/TaskList.tsx";
import { CompleteButton, StarButton } from "./views/TaskRow.tsx";

// Just enough of an element for keyActsOnOpenTask: its tag, and the row it sits in.
function el(tagName: string, row: string | null = null, extra: Partial<{ isContentEditable: boolean }> = {}) {
  return {
    tagName,
    isContentEditable: extra.isContentEditable ?? false,
    closest: (sel: string) => (row !== null && sel === `[data-task="${row}"]` ? {} : null),
  };
}

describe("keyActsOnOpenTask", () => {
  const body = el("BODY");
  const container = el("DIV");
  const ctx = { openTask: "t1", body, container };

  it("acts with focus on the body, the list container, or the open task's own row link", () => {
    expect(keyActsOnOpenTask(body, ctx)).toBe(true);
    expect(keyActsOnOpenTask(container, ctx)).toBe(true);
    expect(keyActsOnOpenTask(el("A", "t1"), ctx)).toBe(true);
    expect(keyActsOnOpenTask(null, ctx)).toBe(true);
  });

  it("leaves the key alone on another row's link, a sidebar link, or elsewhere", () => {
    expect(keyActsOnOpenTask(el("A", "t2"), ctx)).toBe(false);
    expect(keyActsOnOpenTask(el("A"), ctx)).toBe(false);
    expect(keyActsOnOpenTask(el("DIV"), ctx)).toBe(false);
  });

  it("leaves the key alone in a text field or on a control, even in the open row", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT", "BUTTON"]) expect(keyActsOnOpenTask(el(tag, "t1"), ctx)).toBe(false);
    expect(keyActsOnOpenTask(el("DIV", "t1", { isContentEditable: true }), ctx)).toBe(false);
  });

  it("never acts with no open task", () => {
    expect(keyActsOnOpenTask(body, { ...ctx, openTask: null })).toBe(false);
  });
});

describe("canAddTask", () => {
  it("is false on Completed, on a list that doesn't exist, and on My Day with My Day off", () => {
    expect(canAddTask({ view: "smart", list: "completed" }, true, true)).toBe(false);
    expect(canAddTask({ view: "list", id: "gone" }, false, true)).toBe(false);
    expect(canAddTask({ view: "smart", list: "my_day" }, true, false)).toBe(false);
  });

  it("is true otherwise", () => {
    expect(canAddTask({ view: "list", id: "l1" }, true, false)).toBe(true);
    expect(canAddTask({ view: "smart", list: "my_day" }, true, true)).toBe(true);
    expect(canAddTask({ view: "smart", list: "planned" }, true, false)).toBe(true);
  });
});

describe("row buttons", () => {
  it("name the task they act on", () => {
    const render = (e: ReturnType<typeof createElement>) => renderToStaticMarkup(e);
    expect(render(createElement(CompleteButton, { done: false, onToggle: () => {}, title: "Example" }))).toContain(
      'aria-label="Mark “Example” complete"',
    );
    expect(render(createElement(CompleteButton, { done: true, onToggle: () => {}, title: "Example" }))).toContain(
      'aria-label="Mark “Example” not complete"',
    );
    expect(render(createElement(StarButton, { on: false, onToggle: () => {}, title: "Example" }))).toContain(
      'aria-label="Add importance to “Example”"',
    );
    expect(render(createElement(StarButton, { on: true, onToggle: () => {}, title: "Example" }))).toContain(
      'aria-label="Remove importance from “Example”"',
    );
  });

  it("keep the short names without a title (the detail pane, where the task is plain)", () => {
    expect(renderToStaticMarkup(createElement(CompleteButton, { done: false, onToggle: () => {} }))).toContain('aria-label="Mark complete"');
    expect(renderToStaticMarkup(createElement(StarButton, { on: false, onToggle: () => {} }))).toContain('aria-label="Add importance"');
  });
});
