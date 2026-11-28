import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary, Failure, signOutAndReload } from "./views/ErrorBoundary.tsx";

describe("ErrorBoundary", () => {
  it("switches to the failure view when a child throws", () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error("boom"))).toEqual({ failed: true });
  });

  it("renders its children while nothing has failed", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorBoundary, { onSignOut: async () => {}, onReload: () => {}, children: createElement("p", null, "fine") }),
    );
    expect(html).toBe("<p>fine</p>");
  });
});

describe("Failure", () => {
  it("says something went wrong and offers Reload and Sign out", () => {
    const html = renderToStaticMarkup(createElement(Failure, { onSignOut: async () => {}, onReload: () => {} }));
    expect(html).toContain("Something went wrong");
    expect(html).toContain(">Reload</button>");
    expect(html).toContain(">Sign out</button>");
  });
});

describe("signOutAndReload", () => {
  it("reloads after a sign-out that finished", async () => {
    const reload = vi.fn();
    expect(await signOutAndReload(async () => {}, reload)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("doesn't reload, and answers false, when the sign-out failed", async () => {
    const reload = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await signOutAndReload(async () => {
        throw new Error("403");
      }, reload),
    ).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
