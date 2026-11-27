// POST /api/v1/sync/mutations, minus the HTTP layer and the Graph calls
// (docs/SYNC-API.md sections 5 and 6). This module validates a batch, applies
// idempotency, drops fields a newer edit already set, and hands each mutation
// to an executor that does the write-through. The executor is the ops layer
// (packages/core/ops/), the same code the MCP tools use.

import { SMART_LISTS } from "../index/change-feed";

export const MAX_BATCH = 25;
// Mutations still waiting when this runs out come back `skipped`, so a batch
// finishes well inside client timeouts (section 5.1).
export const BATCH_TIME_BUDGET_MS = 20_000;
// A `pending` row older than this is treated as abandoned (a crashed or timed
// out request), so a retry may re-run it (section 18.4).
export const MUTATION_LEASE_MS = 60_000;

export const OPS = [
  "list.create", "list.update", "list.delete", "list.reorder",
  "list_group.create", "list_group.update", "list_group.delete", "list_group.reorder",
  "task.create", "task.update", "task.delete", "task.move", "task.reorder",
  "myday.add", "myday.remove", "myday.reorder",
  "step.create", "step.update", "step.delete", "step.reorder",
  "link.create", "link.update", "link.delete",
  "attachment.delete",
  // App-owned, kept by this server only (section 4.8).
  "theme_image.delete", "settings.update",
] as const;
export type MutationOp = (typeof OPS)[number];
export type EntityKind = "list" | "task" | "step" | "link" | "list_group" | "attachment" | "theme_image" | "app_settings";
// What a mutation can name.
export type RefKind = EntityKind;

export type Position = { before: string } | { after: string } | { top: true } | { bottom: true };

export interface MutationIn {
  id: string;
  at: string;
  op: MutationOp;
  sid: string;
  fields?: Record<string, unknown>;
  position?: Position;
}

export type MutationResult =
  | { id: string; status: "applied"; sid: string; superseded_fields?: string[] }
  | { id: string; status: "duplicate"; result: unknown }
  | { id: string; status: "rejected"; error: string }
  | { id: string; status: "failed"; error: string; retry: boolean }
  | { id: string; status: "skipped" };

// Fields of each update op that carry a per-field clock (section 6). A create
// stamps every field it sets.
export const UPDATABLE: Record<string, readonly string[]> = {
  "task.update": ["title", "body", "status", "completed_at", "importance", "due", "start", "reminder", "categories", "recurrence"],
  // `sync` is the list's sync setting (section 1.2), kept by this server
  // rather than in Microsoft To Do.
  // `theme` and `group_id` are the list's sidebar appearance (section 10.4),
  // written to Substrate.
  // `image_id` is the app's background image (section 4.8), kept here.
  // `image_style`: how the app shows it on this list.
  "list.update": ["name", "sync", "theme", "group_id", "image_id", "image_style"],
  // A sidebar list group (section 10.4), written to Substrate.
  "list_group.update": ["name"],
  "step.update": ["title", "checked"],
  "link.update": ["url", "title"],
  // One field per smart list, each its whole theme (section 4.8).
  "settings.update": SMART_LISTS,
};

// Fields every other op accepts. A create takes the update fields plus the
// sid of its parent; reorders take only `position`.
const TASK_FIELDS = UPDATABLE["task.update"];
export const ALLOWED_FIELDS: Record<MutationOp, readonly string[]> = {
  "list.update": UPDATABLE["list.update"],
  "task.update": TASK_FIELDS,
  "step.update": UPDATABLE["step.update"],
  "link.update": UPDATABLE["link.update"],
  "list.create": ["name"],
  "list.delete": [],
  "list.reorder": [],
  "list_group.create": ["name"],
  "list_group.update": UPDATABLE["list_group.update"],
  "list_group.delete": [],
  "list_group.reorder": [],
  "task.create": ["list_id", ...TASK_FIELDS],
  "task.delete": [],
  "task.move": ["list_id"],
  "task.reorder": [],
  "myday.add": [],
  "myday.remove": [],
  "myday.reorder": [],
  "step.create": ["task_id", "title", "checked"],
  "step.delete": [],
  "step.reorder": [],
  "link.create": ["task_id", "url", "title"],
  "link.delete": [],
  "attachment.delete": [],
  "theme_image.delete": [],
  "settings.update": UPDATABLE["settings.update"],
};
// A parent reference, not a field of the entity: it gets no field clock.
const PARENT_REFS = new Set(["list_id", "task_id"]);

export const kindOf = (op: MutationOp): EntityKind => {
  const k = op.slice(0, op.indexOf("."));
  return (k === "myday" ? "task" : k === "settings" ? "app_settings" : k) as EntityKind;
};
const isCreate = (op: MutationOp) => op.endsWith(".create");

// What the server stores and the executor needs, per entity a mutation names.
export interface SidRef {
  kind: RefKind;
  sid: string;
}
export interface Resolved {
  graph_id: string | null;
  // The entity's row exists in the mirror now. A sid can be known (it was
  // issued) and not live (the entity was deleted): "delete wins".
  live: boolean;
  // The entity is an excluded list or belongs to one (section 1.2).
  excluded?: boolean;
}

// The server-side half, run inside the index (one SQLite each call). On
// Cloudflare these are Durable Object RPCs.
export interface MutationStore {
  // `prior_at_ms` is set when an earlier attempt of this id may have written
  // to Graph (it was released as ambiguous, or its lease ran out): the time it
  // first began.
  mutationBegin(id: string, principal: string, nowMs: number, leaseMs: number): Promise<
    | { state: "new"; prior_at_ms?: number }
    | { state: "done"; result: unknown }
    | { state: "leased" }
  >;
  mutationFinish(
    id: string,
    result: unknown,
    clocks: Array<{ kind: EntityKind; sid: string; field: string; at_ms: number }>,
  ): Promise<void>;
  mutationAbandon(id: string): Promise<void>;
  // Keeps the row (and its first at_ms) but frees the lease: the write may
  // have reached Graph, so the retry looks for it before writing again.
  mutationRelease(id: string): Promise<void>;
  fieldClocks(kind: EntityKind, sid: string): Promise<Record<string, number>>;
  resolveSids(refs: SidRef[]): Promise<Record<string, Resolved>>;
  adoptSid(kind: EntityKind, sid: string, graphId: string): Promise<boolean>;
  syncCursor(): Promise<string>;
}

// The write-through. `ids` maps every sid the mutation names (its own, and
// fields.list_id / fields.task_id / position neighbours) to Graph IDs.
export interface ExecInput {
  op: MutationOp;
  // The app's sid for the entity. A create records it for the new Graph ID
  // before the mirror write, so the mirror never mints a sid of its own.
  sid: string;
  graphId: string | null;
  fields: Record<string, unknown>;
  position?: Position;
  ids: Record<string, string>;
  // A create retried after an attempt that may have reached Graph: find what
  // that attempt made (created at or after this time) before creating again.
  priorAttemptMs?: number;
}
// `ambiguous`: the failure came after the request may have reached Graph (a
// 5xx or a dropped connection on a create), so the retry must check first.
export type ExecOutcome =
  | { ok: true; graphId: string }
  | { ok: false; error: string; retry: boolean; rejected?: boolean; ambiguous?: boolean };
export type Executor = (input: ExecInput) => Promise<ExecOutcome>;

const SID_RE = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AT_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/i;
const ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;

export function normalizeSid(s: string): string {
  return s.toLowerCase();
}

// Parses the request body. Returns an error string for a malformed batch (the
// whole request is a 400); per-mutation problems become `rejected` results.
export function parseBatch(body: unknown): { client_id: string; mutations: unknown[] } | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.client_id !== "string" || b.client_id.length === 0 || b.client_id.length > 100) return "client_id required";
  if (!Array.isArray(b.mutations)) return "mutations must be an array";
  if (b.mutations.length > MAX_BATCH) return `at most ${MAX_BATCH} mutations per request`;
  return { client_id: b.client_id, mutations: b.mutations };
}

// Exactly one of { before: sid }, { after: sid }, { top: true }, { bottom: true }.
function isPosition(p: unknown): p is Position {
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  const entries = Object.entries(p);
  if (entries.length !== 1) return false;
  const [k, v] = entries[0];
  if (k === "before" || k === "after") return typeof v === "string" && SID_RE.test(v.toLowerCase());
  return (k === "top" || k === "bottom") && v === true;
}

function validate(raw: unknown): MutationIn | { id: string; error: string } {
  const m = (raw ?? {}) as Record<string, unknown>;
  const id = typeof m.id === "string" && ID_RE.test(m.id) ? m.id : "";
  if (!id) return { id: String(m.id ?? ""), error: "bad_id" };
  if (typeof m.op !== "string" || !(OPS as readonly string[]).includes(m.op)) return { id, error: "unknown_op" };
  if (typeof m.sid !== "string" || !SID_RE.test(m.sid.toLowerCase())) return { id, error: "bad_sid" };
  // An offset is required: without one Date.parse reads the time in the
  // server's zone.
  if (typeof m.at !== "string" || !AT_RE.test(m.at) || Number.isNaN(Date.parse(m.at))) return { id, error: "bad_at" };
  if (m.fields !== undefined && (typeof m.fields !== "object" || m.fields === null || Array.isArray(m.fields))) {
    return { id, error: "bad_fields" };
  }
  const allowed = ALLOWED_FIELDS[m.op as MutationOp];
  if (m.fields) {
    const extra = Object.keys(m.fields).filter((f) => !allowed.includes(f));
    if (extra.length) return { id, error: `unknown_fields:${extra.join(",")}` };
  }
  if (m.position !== undefined && !isPosition(m.position)) return { id, error: "bad_position" };
  return {
    id,
    at: m.at,
    op: m.op as MutationOp,
    sid: normalizeSid(m.sid),
    fields: (m.fields as Record<string, unknown>) ?? {},
    position: m.position as Position | undefined,
  };
}

// Every sid a mutation names, with its kind.
export function refsOf(m: MutationIn): SidRef[] {
  const kind = kindOf(m.op);
  const refs: SidRef[] = [{ kind, sid: m.sid }];
  const f = m.fields ?? {};
  if (typeof f.list_id === "string") refs.push({ kind: "list", sid: normalizeSid(f.list_id) });
  if (typeof f.task_id === "string") refs.push({ kind: "task", sid: normalizeSid(f.task_id) });
  if (m.op === "list.update" && typeof f.group_id === "string") refs.push({ kind: "list_group", sid: normalizeSid(f.group_id) });
  // A theme image named by a list or smart list must exist: an unknown one
  // is rejected as unknown_theme_image (the app uploads before it names it).
  if (m.op === "list.update" && typeof f.image_id === "string") refs.push({ kind: "theme_image", sid: normalizeSid(f.image_id) });
  if (m.op === "settings.update") {
    for (const v of Object.values(f)) {
      const id = v && typeof v === "object" ? (v as Record<string, unknown>).image_id : undefined;
      if (typeof id === "string") refs.push({ kind: "theme_image", sid: normalizeSid(id) });
    }
  }
  // A top-level sidebar neighbour (list.reorder, and a group's position) can
  // be a list or a group; the executor resolves it against the sidebar itself.
  if (m.op === "list.reorder" || m.op.startsWith("list_group.")) return refs;
  const p = m.position as Record<string, unknown> | undefined;
  for (const k of ["before", "after"]) if (typeof p?.[k] === "string") refs.push({ kind, sid: normalizeSid(p[k] as string) });
  return refs;
}

const key = (r: SidRef) => `${r.kind}:${r.sid}`;

// The sidebar neighbours refsOf leaves to the executor (list.reorder and the
// list_group ops), under both kinds a neighbour can be, so applyBatch can skip
// a mutation whose neighbour's create in this batch didn't apply.
function sidebarNeighbourKeys(m: MutationIn): string[] {
  if (m.op !== "list.reorder" && !m.op.startsWith("list_group.")) return [];
  const p = m.position as Record<string, unknown> | undefined;
  return ["before", "after"].flatMap((k) => {
    const v = p?.[k];
    if (typeof v !== "string") return [];
    const sid = normalizeSid(v);
    return (["list", "list_group"] as const).map((kind) => key({ kind, sid }));
  });
}

export async function applyBatch(
  store: MutationStore,
  exec: Executor,
  body: { mutations: unknown[] },
  principal: string,
  opts: { now?: () => number; budgetMs?: number } = {},
): Promise<{ cursor: string; results: MutationResult[] }> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? BATCH_TIME_BUDGET_MS);
  const results: MutationResult[] = [];
  // An entity whose earlier mutation in this batch didn't apply: later ones
  // for it are skipped, so a create followed by edits never runs out of order.
  const blocked = new Set<string>();
  // An entity whose create in this batch didn't apply: a mutation that names
  // it (a step under the task, a neighbour) is skipped rather than rejected
  // for good as unknown_<kind>, since the retried batch creates it first. A
  // failed edit of an existing parent blocks nothing under it.
  const uncreated = new Set<string>();

  for (const raw of body.mutations) {
    const v = validate(raw);
    if ("error" in v) {
      results.push({ id: v.id, status: "rejected", error: v.error });
      continue;
    }
    const m = v;
    const self: SidRef = { kind: kindOf(m.op), sid: m.sid };
    const others = refsOf(m).slice(1);
    const waits = others.some((r) => uncreated.has(key(r))) || sidebarNeighbourKeys(m).some((k) => uncreated.has(k));
    if (blocked.has(key(self)) || waits || now() > deadline) {
      blocked.add(key(self));
      if (isCreate(m.op)) uncreated.add(key(self));
      results.push({ id: m.id, status: "skipped" });
      continue;
    }
    const r = await applyOne(store, exec, m, principal, now());
    if (r.status !== "applied" && r.status !== "duplicate") {
      blocked.add(key(self));
      if (isCreate(m.op)) uncreated.add(key(self));
    }
    results.push(r);
  }
  return { cursor: await store.syncCursor(), results };
}

async function applyOne(
  store: MutationStore,
  exec: Executor,
  m: MutationIn,
  principal: string,
  nowMs: number,
): Promise<MutationResult> {
  const begun = await store.mutationBegin(m.id, principal, nowMs, MUTATION_LEASE_MS);
  if (begun.state === "done") return { id: m.id, status: "duplicate", result: begun.result };
  if (begun.state === "leased") return { id: m.id, status: "failed", error: "in_progress", retry: true };

  const finish = async (res: MutationResult, clocks: Parameters<MutationStore["mutationFinish"]>[2] = [], ambiguous = false) => {
    if (res.status === "applied" || res.status === "rejected") await store.mutationFinish(m.id, res, clocks);
    else if (ambiguous) await store.mutationRelease(m.id);
    else await store.mutationAbandon(m.id);
    return res;
  };

  const kind = kindOf(m.op);
  const refs = refsOf(m);
  const resolved = await store.resolveSids(refs);
  const self = resolved[key({ kind, sid: m.sid })] ?? { graph_id: null, live: false };
  // An excluded list isn't mirrored, so nothing may be written into it from
  // here: the change would never reach the feed. The list itself can still be
  // renamed, deleted, or switched back on (list.update { sync }).
  if (kind !== "list" && refs.some((r) => resolved[key(r)]?.excluded)) {
    return finish({ id: m.id, status: "rejected", error: "list_excluded" });
  }
  const ids: Record<string, string> = {};
  for (const r of refs.slice(1)) {
    const x = resolved[key(r)];
    if (!x?.graph_id || !x.live) return finish({ id: m.id, status: "rejected", error: `unknown_${r.kind}` });
    ids[r.sid] = x.graph_id;
  }

  if (isCreate(m.op)) {
    // The app chose this sid. One that already names a live entity means this
    // create already ran (its result row was lost) or the sid collides; either
    // way nothing new is made.
    if (self.live) return finish({ id: m.id, status: "applied", sid: m.sid });
    // A sid with a Graph ID but no mirror row, on a retry of this same
    // mutation: the earlier attempt created the entity and reserved the sid,
    // then stopped before the mirror write. Graph has it; delta (or the
    // sub-resource scan, for a step or link) brings the row.
    if (self.graph_id && begun.prior_at_ms !== undefined) return finish({ id: m.id, status: "applied", sid: m.sid });
    if (self.graph_id) return finish({ id: m.id, status: "rejected", error: "sid_in_use" });
  } else if (!self.graph_id) {
    return finish({ id: m.id, status: "rejected", error: "unknown_sid" });
  } else if (!self.live) {
    return finish({ id: m.id, status: "rejected", error: "deleted" });
  }

  // Newest edit per field wins (section 6). The device's time is clamped to
  // the server's, so a fast clock can't win forever.
  const at = Math.min(Date.parse(m.at), nowMs);
  let fields = { ...(m.fields ?? {}) };
  let superseded: string[] = [];
  if (UPDATABLE[m.op]) {
    const clocks = await store.fieldClocks(kind, m.sid);
    superseded = Object.keys(fields).filter((f) => (clocks[f] ?? -Infinity) > at);
    for (const f of superseded) delete fields[f];
    if (Object.keys(fields).length === 0) {
      return finish({ id: m.id, status: "applied", sid: m.sid, superseded_fields: superseded });
    }
  }

  const out = await exec({
    op: m.op,
    sid: m.sid,
    graphId: self.graph_id,
    fields,
    position: m.position,
    ids,
    ...(isCreate(m.op) && begun.prior_at_ms !== undefined ? { priorAttemptMs: begun.prior_at_ms } : {}),
  });
  if (!out.ok) {
    if (out.rejected) return finish({ id: m.id, status: "rejected", error: out.error });
    return finish({ id: m.id, status: "failed", error: out.error, retry: out.retry }, [], out.ambiguous === true);
  }
  if (isCreate(m.op) && !(await store.adoptSid(kind, m.sid, out.graphId))) {
    // Graph has the entity but the sid couldn't be attached (a race with the
    // same sid); the entity stays under a server-minted sid and the app sees
    // it on its next pull.
    return finish({ id: m.id, status: "rejected", error: "sid_in_use" });
  }
  const res: MutationResult = superseded.length
    ? { id: m.id, status: "applied", sid: m.sid, superseded_fields: superseded }
    : { id: m.id, status: "applied", sid: m.sid };
  // Each field the app set now holds its edit, so its clock is the edit's
  // time, even below the stamp the write-through gave it. Graph moves status
  // and completion together, so setting either sets both.
  const stamped = new Set(Object.keys(fields).filter((field) => !(isCreate(m.op) && PARENT_REFS.has(field))));
  if (kind === "task" && (stamped.has("status") || stamped.has("completed_at"))) {
    stamped.add("status");
    stamped.add("completed_at");
  }
  return finish(
    res,
    [...stamped].map((field) => ({ kind, sid: m.sid, field, at_ms: at })),
  );
}
