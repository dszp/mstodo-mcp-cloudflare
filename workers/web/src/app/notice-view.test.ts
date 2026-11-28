import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoticeItem } from "./views/Notice.tsx";

describe("NoticeItem", () => {
  it("offers Copy my text for a refused note", () => {
    const html = renderToStaticMarkup(
      createElement(NoticeItem, {
        notice: { id: 1, op: "task.update", sid: "t1", error: "too_large", recoverText: "My note" },
        onDismiss: () => {},
      }),
    );
    expect(html).toContain("Couldn&#x27;t save: the edit is too large to send.");
    expect(html).toContain(">Copy my text</button>");
    // The text itself is copied on demand, not written into the page twice.
    expect(html).not.toContain("My note");
  });

  it("has no copy button for any other notice", () => {
    const html = renderToStaticMarkup(
      createElement(NoticeItem, { notice: { id: 1, op: "task.update", sid: "t1", error: "deleted" }, onDismiss: () => {} }),
    );
    expect(html).not.toContain("Copy my text");
  });
});
