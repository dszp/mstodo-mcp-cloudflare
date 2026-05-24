import { describe, it, expect } from "vitest";
import { assertGraphUrl, redactUrl, GraphError } from "../src/graph/client";

describe("assertGraphUrl (H1 — Bearer-token host pin)", () => {
  it("accepts the canonical Graph base and resource URLs", () => {
    expect(() =>
      assertGraphUrl("https://graph.microsoft.com/v1.0/me/todo/lists"),
    ).not.toThrow();
    // Delta continuation links carry query strings — still Graph host, allowed.
    expect(() =>
      assertGraphUrl(
        "https://graph.microsoft.com/v1.0/me/todo/lists/delta?$skiptoken=ABC",
      ),
    ).not.toThrow();
  });

  it("rejects a non-Graph host (token-exfil attempt)", () => {
    expect(() => assertGraphUrl("https://evil.example.com/v1.0/me")).toThrow(
      GraphError,
    );
    try {
      assertGraphUrl("https://evil.example.com/v1.0/me");
    } catch (e) {
      expect((e as GraphError).message).toBe("graph_url_host_rejected");
    }
  });

  it("rejects a Graph look-alike subdomain/suffix host", () => {
    expect(() =>
      assertGraphUrl("https://graph.microsoft.com.evil.com/v1.0/me"),
    ).toThrow(GraphError);
    expect(() =>
      assertGraphUrl("https://notgraph.microsoft.com/v1.0/me"),
    ).toThrow(GraphError);
  });

  it("rejects non-https schemes even on the Graph host", () => {
    expect(() => assertGraphUrl("http://graph.microsoft.com/v1.0/me")).toThrow(
      GraphError,
    );
  });

  it("rejects an unparseable URL", () => {
    expect(() => assertGraphUrl("not a url")).toThrow(GraphError);
    try {
      assertGraphUrl("not a url");
    } catch (e) {
      expect((e as GraphError).message).toBe("graph_url_invalid");
    }
  });
});

describe("redactUrl (H2 — keep continuation tokens out of logs)", () => {
  it("drops the query string (skiptoken/deltatoken) and fragment", () => {
    expect(
      redactUrl(
        "https://graph.microsoft.com/v1.0/me/todo/lists/list-A/tasks/delta?$skiptoken=SECRET&$deltatoken=ALSO#frag",
      ),
    ).toBe("https://graph.microsoft.com/v1.0/me/todo/lists/list-A/tasks/delta");
  });

  it("preserves a URL that has no query string", () => {
    expect(redactUrl("https://graph.microsoft.com/v1.0/me/todo/lists")).toBe(
      "https://graph.microsoft.com/v1.0/me/todo/lists",
    );
  });

  it("returns a placeholder for an unparseable URL instead of throwing", () => {
    expect(redactUrl("not a url")).toBe("<unparseable-url>");
  });
});
