import { z } from "zod";
import type { GraphClient } from "./client";
import { TodoTaskSchema, type TodoTask } from "./types";

// Phase 5 — Microsoft Graph `/delta` follower.
//
// A delta collection page (`/me/todo/lists/delta` or
// `/me/todo/lists/{id}/tasks/delta`) is `{ value: [...], @odata.nextLink? ,
// @odata.deltaLink? }`. Each `value` row is EITHER a full resource object OR a
// removed marker `{ id, "@removed": { reason? } }`. Findings invariants
// (notes/phase-0.5b-findings.md): deltas always paginate — follow `nextLink`
// until `deltaLink`; do NOT inherit the smoke probe's 10-page cap. The only
// bound here is the caller's explicit `maxPages` budget so the DO can fit a
// cycle under the free-tier subrequest ceiling and resume from `nextLink`.

// A delta page row: a full task OR a removed marker. Branch 1 (removed) is tried
// first; a full task lacks `@removed` and falls through to TodoTaskSchema. Both
// branches `.passthrough()`, so `@removed` survives either way and the
// presence-based classification below is robust to schema drift.
export const DeltaRowSchema = z.union([
  z
    .object({
      id: z.string(),
      "@removed": z.object({ reason: z.string().optional() }).passthrough(),
    })
    .passthrough(),
  TodoTaskSchema,
]);
export type DeltaRowRaw = z.infer<typeof DeltaRowSchema>;

export type DeltaRow =
  | { kind: "removed"; id: string }
  | { kind: "task"; task: TodoTask };

export interface DeltaResult {
  rows: DeltaRow[];
  // Set when the chain reached `@odata.deltaLink` within budget. Store it as the
  // resume point for the next incremental cycle.
  deltaLink?: string;
  // Set when `maxPages` was hit mid-chain. Resume by calling again with this URL.
  nextLink?: string;
  pagesFetched: number;
}

const DeltaPageSchema = z
  .object({
    "@odata.context": z.string().optional(),
    "@odata.nextLink": z.string().optional(),
    "@odata.deltaLink": z.string().optional(),
    value: z.array(DeltaRowSchema),
  })
  .passthrough();

function classify(raw: DeltaRowRaw): DeltaRow {
  if (raw && typeof raw === "object" && "@removed" in raw) {
    return { kind: "removed", id: (raw as { id: string }).id };
  }
  return { kind: "task", task: raw as TodoTask };
}

// Follows `@odata.nextLink` from `startUrl` until `@odata.deltaLink` OR until
// `maxPages` pages have been fetched. `startUrl` is a fresh `/delta` URL (no
// token → baseline), a stored `deltaLink` (incremental), or a mid-cycle
// `nextLink` (resume). A `GraphError(410)` from `getJson` propagates so the
// caller can purge + re-baseline.
export async function followToTerminal(
  graph: GraphClient,
  startUrl: string,
  maxPages: number,
): Promise<DeltaResult> {
  const rows: DeltaRow[] = [];
  let url = startUrl;
  let pagesFetched = 0;

  while (true) {
    const page = await graph.getJson(url, DeltaPageSchema);
    pagesFetched += 1;
    for (const item of page.value) rows.push(classify(item));

    const deltaLink = page["@odata.deltaLink"];
    if (deltaLink) return { rows, deltaLink, pagesFetched };

    const nextLink = page["@odata.nextLink"];
    // A delta response carries either nextLink or deltaLink; neither means the
    // chain is exhausted with no resume point — treat as terminal.
    if (!nextLink) return { rows, pagesFetched };

    if (pagesFetched >= maxPages) return { rows, nextLink, pagesFetched };
    url = nextLink;
  }
}
