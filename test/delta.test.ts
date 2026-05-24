import { describe, it, expect, vi } from "vitest";
import type { z } from "zod";
import { GraphClient, GraphError } from "../src/graph/client";
import { followToTerminal } from "../src/graph/delta";

// A minimal GraphClient stub: followToTerminal only ever calls getJson(url, schema).
// Scripted pages are keyed by request URL; an unscripted URL is a test bug.
function mockGraph(pages: Record<string, unknown>): {
  graph: GraphClient;
  getJson: ReturnType<typeof vi.fn>;
} {
  const getJson = vi.fn(async (url: string, schema: z.ZodType) => {
    if (!(url in pages)) throw new Error(`unscripted url: ${url}`);
    return schema.parse(pages[url]);
  });
  const graph = { getJson } as unknown as GraphClient;
  return { graph, getJson };
}

const task = (id: string, title = `title ${id}`) => ({
  id,
  title,
  status: "notStarted",
});
const removed = (id: string) => ({ id, "@removed": { reason: "deleted" } });

describe("followToTerminal", () => {
  it("follows the nextLink chain to the deltaLink and flattens all rows", async () => {
    const { graph, getJson } = mockGraph({
      "https://graph/delta": {
        value: [task("a"), task("b")],
        "@odata.nextLink": "https://graph/delta?page=2",
      },
      "https://graph/delta?page=2": {
        value: [task("c")],
        "@odata.deltaLink": "https://graph/delta?token=DL",
      },
    });

    const res = await followToTerminal(graph, "https://graph/delta", 100);

    expect(res.pagesFetched).toBe(2);
    expect(res.deltaLink).toBe("https://graph/delta?token=DL");
    expect(res.nextLink).toBeUndefined();
    expect(res.rows.map((r) => (r.kind === "task" ? r.task.id : r.id))).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(getJson).toHaveBeenCalledTimes(2);
  });

  it("classifies @removed markers and full tasks, mixed within one page", async () => {
    const { graph } = mockGraph({
      "https://graph/delta": {
        value: [task("a"), removed("b"), task("c")],
        "@odata.deltaLink": "https://graph/delta?token=DL",
      },
    });

    const res = await followToTerminal(graph, "https://graph/delta", 100);

    expect(res.rows).toEqual([
      { kind: "task", task: expect.objectContaining({ id: "a" }) },
      { kind: "removed", id: "b" },
      { kind: "task", task: expect.objectContaining({ id: "c" }) },
    ]);
  });

  it("stops at maxPages and surfaces nextLink for resume (no deltaLink)", async () => {
    const { graph, getJson } = mockGraph({
      "https://graph/delta": {
        value: [task("a")],
        "@odata.nextLink": "https://graph/delta?page=2",
      },
      "https://graph/delta?page=2": {
        value: [task("b")],
        "@odata.deltaLink": "https://graph/delta?token=DL",
      },
    });

    const res = await followToTerminal(graph, "https://graph/delta", 1);

    expect(res.pagesFetched).toBe(1);
    expect(res.nextLink).toBe("https://graph/delta?page=2");
    expect(res.deltaLink).toBeUndefined();
    expect(res.rows.map((r) => (r.kind === "task" ? r.task.id : r.id))).toEqual([
      "a",
    ]);
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it("propagates a GraphError(410) for the caller to re-baseline", async () => {
    const getJson = vi.fn(async () => {
      throw new GraphError(410, "graph_410");
    });
    const graph = { getJson } as unknown as GraphClient;

    await expect(
      followToTerminal(graph, "https://graph/delta", 100),
    ).rejects.toBeInstanceOf(GraphError);
  });
});
