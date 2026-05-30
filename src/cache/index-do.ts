import { DurableObject } from "cloudflare:workers";
import {
  TodoTaskListSchema,
  type ChecklistItem,
  type TodoTask,
  type TodoTaskList,
} from "../graph/types";
import {
  loadTokens,
  refreshTokensForScope,
  storeTokens,
  tokensFromResponse,
  REFRESH_SKEW_MS,
  SCOPES,
  SUBSTRATE_SCOPES,
  TokenExchangeError,
  loadIdentity,
  myDayEnabled,
  type StoredTokens,
} from "../auth/microsoft";
import { SubstrateClient, SubstrateError } from "../graph/substrate-client";
import { GraphClient, GraphError, type TokenProvider } from "../graph/client";
import { followToTerminal, type DeltaRow } from "../graph/delta";
import { encodeCursor, decodeCursor } from "../util/cursor";
import { log } from "../log";
import {
  SCHEMA_DDL,
  TASK_COLUMNS,
  CHECKLIST_COLUMNS,
  taskToRow,
  listToRow,
  checklistItemToRow,
  type TaskRow,
  type ListRow,
  type ChecklistItemRow,
  type ChecklistSearchRow,
  type SubscriptionRow,
  type QueryFilter,
  type SyncStatusReport,
} from "./sql";
import { applyMigrations } from "./migrations";
import { loadListsConfig } from "../config/loader";
import { shouldSkipSync } from "../config/sync-policy";
import {
  taskSubscriptionsEnabled,
  webhookUrl,
  SUBSCRIPTION_RENEW_MARGIN_MS,
  maxSubscriptionOpsPerCycle,
} from "../subscriptions/gate";
import { checklistCacheEnabled, checklistScanMaxTasksPerCycle } from "../checklist/gate";
import { listChecklistItems } from "../graph/todo-resources";
import {
  createSubscription,
  renewSubscription,
  deleteSubscription,
  newClientState,
  desiredExpiration,
} from "../subscriptions/manager";

// Phase 5 — TodoIndex: singleton Durable Object, the single source of truth for
// Microsoft To Do state. SQLite `tasks` (+ `tasks_fts` FTS5 mirror) + `lists`
// roster + `sync_state`. Addressed via idFromName(OWNER_DO_NAME) from the agent
// and the Worker scheduled() heartbeat.
//
// Token refresh (Task 4) + resumable alarm-driven delta sync (Task 5) are in
// place; the full query()/search() filter surface + keyset pagination land in
// Task 6.

// Age-based scan gate. True iff we've never scanned, or the last scan completed
// at least `windowMs` ago. Persistent per-list state (the sync_state
// "myday:{listId}" rows) drives this, so a DO eviction doesn't trigger an
// immediate re-scan — only true staleness does.
export function isScanDue(
  lastScanMs: number | null,
  windowMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (lastScanMs === null) return true;
  return nowMs - lastScanMs >= windowMs;
}

// Budgeted, fair selection for the per-cycle My Day scan. From the roster's
// per-list last-scan times, pick the lists due for a rescan (never scanned, or
// older than the window), oldest-first, capped at `max` per cycle. The
// oldest-first rotation guarantees every list reaches the front within
// ⌈roster / max⌉ scan cycles — the same fairness the task-delta loop uses — so
// a small `max` keeps each cycle's Substrate subrequests well under the Workers
// free-tier ceiling without ever starving a list. Never-scanned lists (null)
// sort oldest, so a fresh roster is covered first.
export function selectDueScanLists(
  entries: Array<{ list_id: string; last: number | null }>,
  windowMs: number,
  max: number,
  nowMs: number = Date.now(),
): string[] {
  return entries
    .filter((e) => isScanDue(e.last, windowMs, nowMs))
    .sort((a, b) => (a.last ?? 0) - (b.last ?? 0))
    .slice(0, Math.max(0, Math.floor(max)))
    .map((e) => e.list_id);
}

// Precomputed UPSERT statement (all columns; update every non-key column on
// task_id conflict). The AFTER INSERT/UPDATE triggers keep tasks_fts in sync.
const UPSERT_TASK_SQL = (() => {
  const cols = TASK_COLUMNS.join(", ");
  const placeholders = TASK_COLUMNS.map(() => "?").join(", ");
  const updates = TASK_COLUMNS.filter((c) => c !== "task_id")
    .map((c) => `${c}=excluded.${c}`)
    .join(", ");
  return `INSERT INTO tasks (${cols}) VALUES (${placeholders}) ON CONFLICT(task_id) DO UPDATE SET ${updates}`;
})();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Delta sync budget (free-tier ceiling is 50 subrequests/request). The roster
// is tiny so it gets its own small cap; task pages share MAX_PAGES_PER_CYCLE.
// Worst case per cycle ≈ ROSTER_MAX_PAGES + MAX_PAGES_PER_CYCLE + 1 refresh = 41
// subrequests. The My Day scan only runs on calm (non-mid-cycle) cycles and is
// itself capped at MY_DAY_SCAN_MAX_FOLDERS_PER_CYCLE (default 6) + 1 substrate
// mint, so even a calm cycle that fully drained its task pages stays ≈ 48 — still
// under the ceiling with headroom.
const ROSTER_MAX_PAGES = 10;
const MAX_PAGES_PER_CYCLE = 30;
// While a baseline is still draining, re-arm quickly; otherwise wait the cron
// cadence (DELTA_SYNC_INTERVAL_MIN).
const MID_CYCLE_REARM_MS = 2_000;

const LISTS_DELTA_URL = "https://graph.microsoft.com/v1.0/me/todo/lists/delta";
const tasksDeltaUrl = (listId: string) =>
  `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks/delta`;

interface SyncStateRow {
  resource: string;
  delta_link: string | null;
  next_link: string | null;
  last_synced_at: number | null;
  status: string | null;
  last_error: string | null;
}

export class TodoIndex extends DurableObject<Env> implements TokenProvider {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema bootstrap is idempotent (IF NOT EXISTS) and runs once per instance
    // before any request is delivered. blockConcurrencyWhile is the documented
    // place for schema setup.
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(SCHEMA_DDL);
      // Versioned migrations: ALTER existing/new DBs up to the latest schema.
      // Idempotent across boots (gated by the stored schema_meta version).
      applyMigrations(this.ctx.storage.sql);
    });
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  // -- Token refresh (sole refresher; global single-flight) -----------------
  // The singleton DO is the one place that POSTs /token, so two concurrent
  // callers (an MCP tool + the sync loop) can't both spend the rotating
  // refresh_token and invalidate each other. Single instance ⇒ in-process
  // coordination is sufficient; no DO storage lock needed.
  //
  // Two resources now share ONE refresh token: Microsoft Graph (aud=graph) and,
  // when My Day is enabled, Office 365 Exchange Online (aud=outlook.office.com,
  // the Substrate endpoint). Each /token call rotates the refresh token, so a
  // Graph refresh and a substrate refresh must NOT run concurrently — the second
  // would spend a refresh token the first just invalidated. We serialize all
  // refreshes on #refreshChain (one /token in flight at a time) while coalescing
  // concurrent same-resource callers via #refreshInFlight.
  #refreshInFlight: { graph?: Promise<string>; substrate?: Promise<string> } = {};
  #refreshChain: Promise<void> = Promise.resolve();

  // Substrate (My Day) access token — cached in DO memory only, never persisted
  // (the refresh token in tokens:owner is the source of truth; this is re-minted
  // on demand). `#substrateUnavailable` latches when AAD reports the EXO scope
  // isn't consented/granted, so we stop hammering /token; cleared on a successful
  // mint or an identity switch.
  #substrateToken: { access_token: string; expires_at: number } | null = null;
  #substrateUnavailable = false;

  // Bumped by resetIdentity() on an owner switch. Captured at the start of each
  // refresh so a refresh that resolves AFTER the switch can detect it and refuse
  // to persist the prior account's tokens over the new identity's (H4).
  #identityGeneration = 0;

  // Returns a valid access token, refreshing only if the stored one is within
  // REFRESH_SKEW_MS of expiry. The agent already gates on freshness before
  // delegating, but the DO re-checks so its own sync loop shares the same path.
  async getAccessToken(): Promise<string> {
    const stored = await loadTokens(this.env);
    if (!stored) throw new Error("not_authenticated");
    if (stored.expires_at > Date.now() + REFRESH_SKEW_MS) return stored.access_token;
    return this.#refreshResource("graph");
  }

  // Forces a refresh regardless of current freshness (GraphClient 401 path).
  async refreshToken(): Promise<string> {
    const stored = await loadTokens(this.env);
    if (!stored) throw new Error("not_authenticated");
    return this.#refreshResource("graph");
  }

  // TokenProvider for the DO's own GraphClient (sync loop). forceRefresh() is
  // the 401 hook; it routes through the same single-flight as refreshToken().
  forceRefresh(): Promise<string> {
    return this.refreshToken();
  }

  // -- Substrate (My Day) access token ---------------------------------------
  // Returns a valid EXO-audience access token from the in-memory cache, minting
  // one (serialized with Graph refreshes) when stale. Throws "my_day_unavailable"
  // if AAD has reported the EXO scope is not consented for this owner.
  async getSubstrateAccessToken(): Promise<string> {
    if (this.#substrateUnavailable) throw new Error("my_day_unavailable");
    const cached = this.#substrateToken;
    if (cached && cached.expires_at > Date.now() + REFRESH_SKEW_MS) return cached.access_token;
    return this.#refreshResource("substrate");
  }

  // Forces a substrate re-mint (SubstrateClient 401 path).
  forceSubstrateRefresh(): Promise<string> {
    this.#substrateToken = null;
    return this.#refreshResource("substrate");
  }

  // Latch My Day as unavailable for this identity (e.g. a 403 ErrorAccessDenied
  // on a substrate PATCH — the scope minted but the resource rejected it).
  // Cleared by a later successful mint or an identity switch.
  markMyDayUnavailable(): void {
    this.#substrateUnavailable = true;
    this.#substrateToken = null;
  }

  // Mint/refresh an access token for one resource. Coalesces concurrent callers
  // for the same resource, and serializes across resources on #refreshChain so
  // only one /token spends the rotating refresh token at a time. The serialized
  // body re-loads tokens:owner AFTER awaiting the chain, so it always spends the
  // refresh token the prior refresh just rotated in.
  #refreshResource(resource: "graph" | "substrate"): Promise<string> {
    const existing = this.#refreshInFlight[resource];
    if (existing) return existing;

    const gen = this.#identityGeneration;
    const prevChain = this.#refreshChain;
    const p = (async (): Promise<string> => {
      // Wait for any in-flight refresh (either resource) to finish rotating the
      // refresh token before we read + spend it.
      await prevChain.catch(() => undefined);
      if (gen !== this.#identityGeneration) throw new Error("identity_changed_during_refresh");

      const stored = await loadTokens(this.env);
      if (!stored) throw new Error("not_authenticated");

      const scope = resource === "graph" ? SCOPES : SUBSTRATE_SCOPES;
      let res;
      try {
        res = await refreshTokensForScope(this.env, stored.refresh_token, scope);
      } catch (e) {
        // AADSTS65001 = the owner consented to Graph but not the EXO resource.
        // Latch unavailable so My Day tools degrade cleanly instead of retrying.
        if (
          resource === "substrate" &&
          e instanceof TokenExchangeError &&
          e.detail.includes("AADSTS65001")
        ) {
          this.#substrateUnavailable = true;
          throw new Error("my_day_unavailable");
        }
        throw e;
      }
      if (gen !== this.#identityGeneration) {
        // Owner switched mid-refresh; these tokens belong to the prior account.
        // Discard (H4) — caller errors and retries under the new identity.
        throw new Error("identity_changed_during_refresh");
      }

      if (resource === "graph") {
        const next = tokensFromResponse(res, stored.refresh_token);
        await storeTokens(this.env, next);
        return next.access_token;
      }

      // Substrate: persist ONLY the rotated refresh token (if any) back to
      // tokens:owner — never clobber the Graph access_token/scope/expires_at,
      // which a Graph caller still reads. Cache the EXO access token in memory.
      const newRefresh = res.refresh_token ?? stored.refresh_token;
      if (newRefresh !== stored.refresh_token) {
        await storeTokens(this.env, { ...stored, refresh_token: newRefresh });
      }
      this.#substrateToken = {
        access_token: res.access_token,
        expires_at: Date.now() + res.expires_in * 1000,
      };
      this.#substrateUnavailable = false;
      return res.access_token;
    })();

    // Advance the serial chain (swallow errors so a failed refresh doesn't poison
    // the next one) and record the per-resource coalescing slot.
    this.#refreshChain = p.then(
      () => undefined,
      () => undefined,
    );
    this.#refreshInFlight[resource] = p;
    void p
      .catch(() => undefined)
      .finally(() => {
        if (this.#refreshInFlight[resource] === p) this.#refreshInFlight[resource] = undefined;
      });
    return p;
  }

  // -- Task CRUD ------------------------------------------------------------
  upsertTask(task: TodoTask, listId: string): void {
    const row = taskToRow(task, listId);
    this.sql.exec(UPSERT_TASK_SQL, ...TASK_COLUMNS.map((c) => row[c]));
  }

  deleteTask(taskId: string): void {
    this.sql.exec("DELETE FROM tasks WHERE task_id = ?", taskId);
    // Cascade: no FK, so drop the task's checklist rows explicitly (FTS follows
    // via the AFTER DELETE trigger). Cheap no-op when the cache is unused.
    this.sql.exec("DELETE FROM checklist_items WHERE task_id = ?", taskId);
  }

  // Best-effort flag bump from a sub-resource mutation result (e.g. a checklist
  // item was just added → has_checklist=1). No-op if the task isn't indexed yet
  // (a later sync fills it in). Note: delta sync carries no expansions, so a
  // mutation is the ONLY way has_checklist becomes 1 — see agent propagation.
  setTaskFlags(
    taskId: string,
    patch: { has_checklist?: boolean; has_attachments?: boolean },
  ): void {
    const sets: string[] = [];
    const params: number[] = [];
    if (patch.has_checklist !== undefined) {
      sets.push("has_checklist = ?");
      params.push(patch.has_checklist ? 1 : 0);
    }
    if (patch.has_attachments !== undefined) {
      sets.push("has_attachments = ?");
      params.push(patch.has_attachments ? 1 : 0);
    }
    if (sets.length === 0) return;
    this.sql.exec(`UPDATE tasks SET ${sets.join(", ")} WHERE task_id = ?`, ...params, taskId);
  }

  // Write-through for Substrate-only fields the cache holds. The patch shape
  // lets callers update one or all fields independently (e.g. add_to_my_day
  // sets committed_day; the background scan sets all four from the Substrate
  // response). No-op if the task isn't indexed — the next Graph delta creates
  // the row and the scan fills the fields in. Only the four Substrate columns
  // are ever touched; Graph-side columns are left alone.
  updateMyDayFields(
    taskId: string,
    patch: {
      committed_day?: string | null;
      committed_order?: string | null;
      order_datetime?: string | null;
      postponed_day?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const bind: unknown[] = [];
    const keys = ["committed_day", "committed_order", "order_datetime", "postponed_day"] as const;
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) {
        sets.push(`${k} = ?`);
        bind.push(patch[k] ?? null);
      }
    }
    if (sets.length === 0) return;
    bind.push(taskId);
    this.sql.exec(`UPDATE tasks SET ${sets.join(", ")} WHERE task_id = ?`, ...bind);
  }

  // Clear My Day membership fields when a task leaves My Day. Leaves
  // order_datetime alone — source-list manual order is independent of My Day.
  clearMyDayFields(taskId: string): void {
    this.updateMyDayFields(taskId, {
      committed_day: null,
      committed_order: null,
      postponed_day: null,
    });
  }

  // -- Checklist cache (migration v3) ---------------------------------------
  // Authoritative replace of a task's cached checklist from a fresh Graph fetch
  // (the backfill scan + targeted near-live refresh). DELETE-then-insert so
  // removed items disappear; stamps checklist_synced_at = now (clears the
  // "needs fetch" marker) and syncs has_checklist. No-op-safe on a task whose
  // row isn't indexed yet — the items still land and the next delta creates the
  // task row. Synchronous (atomic) like the other write-throughs.
  replaceChecklistItems(taskId: string, listId: string, items: ChecklistItem[]): void {
    this.sql.exec("DELETE FROM checklist_items WHERE task_id = ?", taskId);
    for (const item of items) {
      const row = checklistItemToRow(item, taskId, listId);
      this.sql.exec(
        `INSERT INTO checklist_items (${CHECKLIST_COLUMNS.join(", ")})
           VALUES (${CHECKLIST_COLUMNS.map(() => "?").join(", ")})`,
        ...CHECKLIST_COLUMNS.map((c) => row[c]),
      );
    }
    this.sql.exec(
      "UPDATE tasks SET checklist_synced_at = ?, has_checklist = ? WHERE task_id = ?",
      Date.now(),
      items.length > 0 ? 1 : 0,
      taskId,
    );
  }

  // Mark a task's checklist stale so the next budgeted scan re-fetches it. The
  // incremental engine: the delta-apply path nulls this whenever a task changes
  // (checklist edits bump the task's lastModifiedDateTime → ride $delta).
  markChecklistDirty(taskId: string): void {
    this.sql.exec("UPDATE tasks SET checklist_synced_at = NULL WHERE task_id = ?", taskId);
  }

  // Drop a task's cached checklist rows (task deletion already cascades via
  // deleteTask; exposed for explicit clears).
  clearChecklistItems(taskId: string): void {
    this.sql.exec("DELETE FROM checklist_items WHERE task_id = ?", taskId);
  }

  // Write-through for a single checklist mutation (create/update MCP tools):
  // upsert one item for instant cross-task visibility without a re-list. Bumps
  // has_checklist=1 but deliberately leaves checklist_synced_at UNTOUCHED — the
  // cached set may be incomplete (task not yet backfilled), so the marker still
  // governs whether a full fetch is owed. Latency optimization, not correctness:
  // the self-induced edit also rides delta → markChecklistDirty → authoritative
  // re-fetch next scan.
  upsertChecklistItem(taskId: string, listId: string, item: ChecklistItem): void {
    const row = checklistItemToRow(item, taskId, listId);
    this.sql.exec(
      `INSERT INTO checklist_items (${CHECKLIST_COLUMNS.join(", ")})
         VALUES (${CHECKLIST_COLUMNS.map(() => "?").join(", ")})
       ON CONFLICT(item_id) DO UPDATE SET
         display_name=excluded.display_name, is_checked=excluded.is_checked,
         created_at=excluded.created_at, checked_at=excluded.checked_at`,
      ...CHECKLIST_COLUMNS.map((c) => row[c]),
    );
    this.sql.exec("UPDATE tasks SET has_checklist = 1 WHERE task_id = ?", taskId);
  }

  // Write-through for delete_checklist_item: drop one row. has_checklist is left
  // alone (can't tell if it was the last item without an authoritative set; the
  // next delta-driven re-fetch reconciles it). taskId is accepted for symmetry
  // and to scope the delete defensively.
  deleteChecklistItem(taskId: string, itemId: string): void {
    this.sql.exec(
      "DELETE FROM checklist_items WHERE item_id = ? AND task_id = ?",
      itemId,
      taskId,
    );
  }

  // A task's cached checklist rows, open items first then by creation order — the
  // "what am I waiting on" reading. Powers cross-task checklist enrichment.
  getChecklistItems(taskId: string): ChecklistItemRow[] {
    return this.sql
      .exec(
        `SELECT * FROM checklist_items WHERE task_id = ?
          ORDER BY is_checked ASC, created_at ASC NULLS LAST, item_id ASC`,
        taskId,
      )
      .toArray() as unknown as ChecklistItemRow[];
  }

  // The backfill/refresh work set: OPEN tasks whose checklist marker is NULL
  // ("needs fetch"), excluding skipped lists, newest-changed first (recently
  // touched tasks are the likeliest to be queried), capped per cycle. Completed
  // tasks are deliberately left out — they lazy-fill only if a query touches them.
  selectDueChecklistTasks(
    max: number,
    skipListIds: string[],
  ): Array<{ task_id: string; list_id: string }> {
    const skipClause =
      skipListIds.length > 0
        ? `AND list_id NOT IN (${skipListIds.map(() => "?").join(", ")})`
        : "";
    return this.sql
      .exec(
        `SELECT task_id, list_id FROM tasks
          WHERE checklist_synced_at IS NULL
            AND status <> 'completed'
            ${skipClause}
          ORDER BY modified_at DESC
          LIMIT ?`,
        ...skipListIds,
        max,
      )
      .toArray() as unknown as Array<{ task_id: string; list_id: string }>;
  }

  findListForTask(
    taskId: string,
  ): { list_id: string; display_name: string | null } | null {
    const rows = this.sql
      .exec<{ list_id: string; display_name: string | null }>(
        `SELECT t.list_id, l.display_name
           FROM tasks t LEFT JOIN lists l ON l.list_id = t.list_id
          WHERE t.task_id = ?`,
        taskId,
      )
      .toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  // Human-readable task title + owning list name for a task id, or null if the
  // task isn't indexed. Used to label the web upload page (create_upload_link)
  // so it shows the task name instead of the opaque Graph id.
  getTaskMeta(
    taskId: string,
  ): { title: string | null; list_id: string; list_display_name: string | null } | null {
    const rows = this.sql
      .exec<{ title: string | null; list_id: string; list_display_name: string | null }>(
        `SELECT t.title AS title, t.list_id AS list_id, l.display_name AS list_display_name
           FROM tasks t LEFT JOIN lists l ON l.list_id = t.list_id
          WHERE t.task_id = ?`,
        taskId,
      )
      .toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  // My Day fields for a single task, for get_task's opt-in include_my_day —
  // a cache read, no Substrate round-trip. `null` means the task isn't in the
  // cache (unknown). A row with both fields null means "indexed but not on My
  // Day". Keyed by Graph task id (the same id Graph delta and write-through use).
  getMyDayFields(
    taskId: string,
  ): { committed_day: string | null; committed_order: string | null } | null {
    const rows = this.sql
      .exec<{ committed_day: string | null; committed_order: string | null }>(
        "SELECT committed_day, committed_order FROM tasks WHERE task_id = ?",
        taskId,
      )
      .toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  // -- List roster ----------------------------------------------------------
  upsertList(list: TodoTaskList): void {
    const r = listToRow(list);
    this.sql.exec(
      `INSERT INTO lists (list_id, display_name, wellknown, is_owner, is_shared)
         VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(list_id) DO UPDATE SET
         display_name=excluded.display_name, wellknown=excluded.wellknown,
         is_owner=excluded.is_owner, is_shared=excluded.is_shared`,
      r.list_id,
      r.display_name,
      r.wellknown,
      r.is_owner,
      r.is_shared,
    );
  }

  deleteList(listId: string): void {
    // Drop the list and its tasks (FTS rows cascade via the AFTER DELETE
    // trigger as each task row is removed).
    this.sql.exec("DELETE FROM tasks WHERE list_id = ?", listId);
    this.sql.exec("DELETE FROM lists WHERE list_id = ?", listId);
    this.sql.exec("DELETE FROM sync_state WHERE resource = ?", `tasks:${listId}`);
    this.sql.exec("DELETE FROM sync_state WHERE resource = ?", `myday:${listId}`);
  }

  // Roster reads — the `lists` table is the authoritative roster.
  listLists(): ListRow[] {
    return this.sql
      .exec("SELECT * FROM lists ORDER BY display_name")
      .toArray() as unknown as ListRow[];
  }

  getList(listId: string): ListRow | null {
    const rows = this.sql
      .exec("SELECT * FROM lists WHERE list_id = ?", listId)
      .toArray() as unknown as ListRow[];
    return rows.length > 0 ? rows[0] : null;
  }

  // -- Subscription store (ROADMAP §4) --------------------------------------
  getSubscriptions(): SubscriptionRow[] {
    return this.sql
      .exec("SELECT * FROM subscriptions")
      .toArray() as unknown as SubscriptionRow[];
  }

  findSubscription(subscriptionId: string): SubscriptionRow | null {
    const rows = this.sql
      .exec("SELECT * FROM subscriptions WHERE subscription_id = ?", subscriptionId)
      .toArray() as unknown as SubscriptionRow[];
    return rows.length > 0 ? rows[0] : null;
  }

  putSubscription(rec: SubscriptionRow): void {
    this.sql.exec(
      `INSERT INTO subscriptions
         (subscription_id, list_id, client_state, expiration_ms, created_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(subscription_id) DO UPDATE SET
         list_id=excluded.list_id, client_state=excluded.client_state,
         expiration_ms=excluded.expiration_ms, created_at_ms=excluded.created_at_ms`,
      rec.subscription_id,
      rec.list_id,
      rec.client_state,
      rec.expiration_ms,
      rec.created_at_ms,
    );
  }

  deleteSubscriptionRecord(subscriptionId: string): void {
    this.sql.exec("DELETE FROM subscriptions WHERE subscription_id = ?", subscriptionId);
  }

  // -- Subscription reconciliation (ROADMAP §4) -----------------------------
  // Bring Graph's subscriptions in line with the live, non-skipped roster, one
  // bounded batch per cycle (free-tier safety). Tolerates per-op Graph failures
  // (logged, retried next cycle). `opts` overrides are for tests only.
  async reconcileSubscriptions(opts: { enabled?: boolean; now?: number } = {}): Promise<void> {
    const enabled = opts.enabled ?? taskSubscriptionsEnabled(this.env);
    const now = opts.now ?? Date.now();
    const url = webhookUrl(this.env);

    const records = this.getSubscriptions();

    // Gate OFF (or no reachable webhook URL): tear our subscriptions down,
    // budgeted, and create none.
    if (!enabled || !url) {
      const graph = new GraphClient(this);
      let budget = maxSubscriptionOpsPerCycle(this.env);
      for (const rec of records) {
        if (budget <= 0) break;
        budget -= 1;
        await this.#tearDownSubscription(graph, rec.subscription_id);
      }
      return;
    }

    // Which lists SHOULD have a subscription: the non-skipped roster.
    const cfg = await loadListsConfig(this.env);
    const rosterRows = this.listLists();
    const wanted = new Set(
      rosterRows
        .filter((l) => !shouldSkipSync({ list_id: l.list_id, wellknown: l.wellknown }, cfg))
        .map((l) => l.list_id),
    );
    const haveByList = new Map(records.map((r) => [r.list_id, r]));

    const graph = new GraphClient(this);
    let budget = maxSubscriptionOpsPerCycle(this.env);

    // 1. Delete records whose list is gone or now skipped.
    for (const rec of records) {
      if (budget <= 0) return;
      if (!wanted.has(rec.list_id)) {
        budget -= 1;
        await this.#tearDownSubscription(graph, rec.subscription_id);
      }
    }

    // 2. Create for wanted lists with no record. The per-cycle cap rotates
    //    coverage over a few cycles for a large roster (free-tier safety).
    for (const listId of wanted) {
      if (budget <= 0) return;
      if (haveByList.has(listId)) continue;
      budget -= 1;
      await this.#createSubscriptionFor(graph, listId, url, now);
    }
  }

  // Renew records nearing expiry, budgeted. Called from the cycle alongside
  // reconcile.
  async renewSubscriptions(opts: { now?: number } = {}): Promise<void> {
    if (!taskSubscriptionsEnabled(this.env)) return;
    const now = opts.now ?? Date.now();
    const graph = new GraphClient(this);
    let budget = maxSubscriptionOpsPerCycle(this.env);
    const due = this.getSubscriptions()
      .filter((r) => r.expiration_ms - now < SUBSCRIPTION_RENEW_MARGIN_MS)
      .sort((a, b) => a.expiration_ms - b.expiration_ms);
    for (const rec of due) {
      if (budget <= 0) break;
      budget -= 1;
      try {
        const next = desiredExpiration(now);
        const { expirationDateTime } = await renewSubscription(graph, rec.subscription_id, next);
        this.putSubscription({ ...rec, expiration_ms: Date.parse(expirationDateTime) });
      } catch (e) {
        // 404 → subscription already expired/gone on Graph's side; drop the
        // record so reconcile recreates it. Other errors: leave for next cycle.
        if (e instanceof GraphError && e.status === 404) {
          this.deleteSubscriptionRecord(rec.subscription_id);
        }
        log.warn("subscription_renew_failed", {
          subscription_id: rec.subscription_id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  async #createSubscriptionFor(
    graph: GraphClient,
    listId: string,
    notificationUrl: string,
    now: number,
  ): Promise<void> {
    try {
      const clientState = newClientState();
      const { id, expirationDateTime } = await createSubscription(graph, {
        listId,
        notificationUrl,
        clientState,
        expirationDateTime: desiredExpiration(now),
      });
      this.putSubscription({
        subscription_id: id,
        list_id: listId,
        client_state: clientState,
        expiration_ms: Date.parse(expirationDateTime),
        created_at_ms: now,
      });
      log.info("subscription_created", { list_id: listId, subscription_id: id });
    } catch (e) {
      // 403 = per-tenant subscription budget exhausted; 400/validation = webhook
      // unreachable (e.g. local dev). Log and move on — the timer-driven cycle
      // still keeps the cache fresh; reconcile retries next cycle.
      log.warn("subscription_create_failed", {
        list_id: listId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async #tearDownSubscription(graph: GraphClient, subscriptionId: string): Promise<void> {
    try {
      await deleteSubscription(graph, subscriptionId);
    } catch (e) {
      // 404 → already gone on Graph's side; still drop our record.
      if (!(e instanceof GraphError && e.status === 404)) {
        log.warn("subscription_delete_failed", {
          subscription_id: subscriptionId,
          error: e instanceof Error ? e.message : String(e),
        });
        return; // leave the record so we retry the delete next cycle
      }
    }
    this.deleteSubscriptionRecord(subscriptionId);
  }

  // True once at least one full baseline of this list's tasks reached a
  // deltaLink — i.e. the DO holds the authoritative tail and reads can be served
  // from it. A mid-cycle (next_link set, delta_link still null) baseline is NOT
  // yet authoritative, so callers fall back to live Graph.
  isListSynced(listId: string): boolean {
    return !!this.#getSyncState(`tasks:${listId}`)?.delta_link;
  }

  // -- query / search -------------------------------------------------------
  // Filtered task query with keyset pagination over (modified_at DESC,
  // task_id DESC). All values are bound parameters (no interpolation). Date
  // bounds naturally exclude rows where that date is NULL (e.g. a task with no
  // due date never matches a due range). has_checklist=false means "no checklist
  // OR unknown" since delta-sourced rows carry NULL (no expansion).
  query(f: QueryFilter): { rows: TaskRow[]; next_cursor?: string } {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (f.lists && f.lists.length > 0) {
      where.push(`list_id IN (${f.lists.map(() => "?").join(", ")})`);
      params.push(...f.lists);
    }
    if (f.status && f.status.length > 0) {
      where.push(`status IN (${f.status.map(() => "?").join(", ")})`);
      params.push(...f.status);
    }
    if (f.due_after !== undefined) {
      where.push("due_at >= ?");
      params.push(f.due_after);
    }
    if (f.due_before !== undefined) {
      where.push("due_at <= ?");
      params.push(f.due_before);
    }
    if (f.completed_after !== undefined) {
      where.push("completed_at >= ?");
      params.push(f.completed_after);
    }
    if (f.completed_before !== undefined) {
      where.push("completed_at <= ?");
      params.push(f.completed_before);
    }
    if (f.created_after !== undefined) {
      where.push("created_at >= ?");
      params.push(f.created_after);
    }
    if (f.importance !== undefined) {
      where.push("importance = ?");
      params.push(f.importance);
    }
    if (f.has_checklist !== undefined) {
      where.push(
        f.has_checklist ? "has_checklist = 1" : "(has_checklist = 0 OR has_checklist IS NULL)",
      );
    }
    if (f.has_open_checklist_item !== undefined) {
      const exists =
        "EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.task_id = tasks.task_id AND ci.is_checked = 0)";
      where.push(f.has_open_checklist_item ? exists : `NOT ${exists}`);
    }

    // Keyset cursor: rows strictly after the last returned row in the ordering.
    // NULLs sort last (DESC), so the predicate branches on the cursor's
    // modified_at — when non-NULL we must also pull in the whole NULL tail.
    if (f.cursor) {
      const c = decodeCursor(f.cursor);
      if (c && c.modified_at === null) {
        where.push("(modified_at IS NULL AND task_id < ?)");
        params.push(c.task_id);
      } else if (c) {
        where.push(
          "(modified_at < ? OR (modified_at = ? AND task_id < ?) OR modified_at IS NULL)",
        );
        params.push(c.modified_at as number, c.modified_at as number, c.task_id);
      }
      // Unparseable cursor: ignore (start from the top); the tool layer validates.
    }

    const limit = Math.min(f.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const sql = `SELECT * FROM tasks${
      where.length ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY modified_at DESC, task_id DESC LIMIT ?`;
    // Cast: SqlStorageCursor rows are Record<string, SqlStorageValue>; our
    // columns are exactly TaskRow's string|number|null fields.
    const rows = this.sql.exec(sql, ...params, limit).toArray() as unknown as TaskRow[];

    // A full page implies there may be more — hand back a resume cursor.
    let next_cursor: string | undefined;
    if (rows.length === limit && rows.length > 0) {
      const last = rows[rows.length - 1];
      next_cursor = encodeCursor({ modified_at: last.modified_at, task_id: last.task_id });
    }
    return { rows, next_cursor };
  }

  search(opts: {
    query: string;
    lists?: string[];
    status?: string[];
    limit?: number;
  }): { rows: TaskRow[] } {
    const where: string[] = ["tasks_fts MATCH ?"];
    const params: (string | number)[] = [opts.query];
    if (opts.lists && opts.lists.length > 0) {
      where.push(`t.list_id IN (${opts.lists.map(() => "?").join(", ")})`);
      params.push(...opts.lists);
    }
    if (opts.status && opts.status.length > 0) {
      where.push(`t.status IN (${opts.status.map(() => "?").join(", ")})`);
      params.push(...opts.status);
    }
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const sql = `SELECT t.* FROM tasks_fts f JOIN tasks t ON t.rowid = f.rowid
                  WHERE ${where.join(" AND ")} ORDER BY rank LIMIT ?`;
    const rows = this.sql.exec(sql, ...params, limit).toArray() as unknown as TaskRow[];
    return { rows };
  }

  // Cross-task checklist search — the feature's new capability. Two modes,
  // selected by whether `query` is given:
  //   • with query  → FTS5 over checklist item text, ordered by relevance (rank);
  //   • without     → every (pending) item, ordered oldest-first by created_at —
  //                   the "what am I waiting on longest" follow-up view.
  // pending_only (default true) restricts to unchecked items. Each row carries
  // the parent task's title/status (JOIN tasks) so the agent can group + render
  // without a second round trip. Throws on malformed FTS syntax (the tool maps it).
  searchChecklistItems(opts: {
    query?: string;
    pending_only?: boolean;
    lists?: string[];
    limit?: number;
  }): { rows: ChecklistSearchRow[] } {
    const hasQuery = !!opts.query && opts.query.trim().length > 0;
    const pendingOnly = opts.pending_only ?? true;
    const where: string[] = [];
    const params: (string | number)[] = [];

    const from = hasQuery
      ? `checklist_fts f
           JOIN checklist_items ci ON ci.rowid = f.rowid
           JOIN tasks t ON t.task_id = ci.task_id`
      : `checklist_items ci JOIN tasks t ON t.task_id = ci.task_id`;
    if (hasQuery) {
      where.push("checklist_fts MATCH ?");
      params.push(opts.query as string);
    }
    if (pendingOnly) where.push("ci.is_checked = 0");
    if (opts.lists && opts.lists.length > 0) {
      where.push(`ci.list_id IN (${opts.lists.map(() => "?").join(", ")})`);
      params.push(...opts.lists);
    }

    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const order = hasQuery ? "rank" : "ci.created_at ASC NULLS LAST, ci.item_id ASC";
    const sql = `SELECT ci.*, t.title AS task_title, t.status AS task_status
                   FROM ${from}
                  WHERE ${where.join(" AND ")}
                  ORDER BY ${order} LIMIT ?`;
    const rows = this.sql.exec(sql, ...params, limit).toArray() as unknown as ChecklistSearchRow[];
    return { rows };
  }

  // Read path for list_my_day_tasks. Single DO query, zero Substrate round
  // trips. Filter = committed_day equals the target day AND not postponed to
  // that same day (faithful to the official client's My Day projection).
  // Sort = committed_order DESC (nulls last), then order_datetime DESC (nulls
  // last) for tasks not yet assigned a My Day order, then task_id DESC for a
  // stable tie-break. Backed by the tasks_committed_day index.
  queryMyDayForDate(day: string): { rows: TaskRow[] } {
    const rows = this.sql
      .exec(
        `SELECT * FROM tasks
         WHERE committed_day = ?
           AND (postponed_day IS NULL OR postponed_day <> ?)
         ORDER BY committed_order IS NULL,
                  committed_order DESC,
                  order_datetime IS NULL,
                  order_datetime DESC,
                  task_id DESC`,
        day,
        day,
      )
      .toArray() as unknown as TaskRow[];
    return { rows };
  }

  // Aggregate freshness of the budgeted per-list My Day scan, for
  // list_my_day_tasks to advertise staleness. The scan rotates through lists a
  // few per cycle (see #runMyDayScanBatch), recording one "myday:{listId}" row
  // each. `last_scan_at_ms` is the OLDEST per-list scan time — worst-case
  // freshness across the roster — so a single lagging list keeps the advisory
  // honest. `status` is "partial" if any list last errored, else "idle"; both
  // null when nothing has been scanned yet.
  getMyDayScanState(): {
    last_scan_at_ms: number | null;
    status: string | null;
    last_error: string | null;
  } {
    const rows = this.sql
      .exec<{ last_synced_at: number | null; status: string | null; last_error: string | null }>(
        "SELECT last_synced_at, status, last_error FROM sync_state WHERE resource LIKE 'myday:%'",
      )
      .toArray();
    if (rows.length === 0) return { last_scan_at_ms: null, status: null, last_error: null };
    let oldest: number | null = null;
    let anyError = false;
    let firstError: string | null = null;
    for (const r of rows) {
      if (r.last_synced_at != null) {
        oldest = oldest == null ? r.last_synced_at : Math.min(oldest, r.last_synced_at);
      }
      if (r.status && r.status !== "idle") {
        anyError = true;
        if (firstError == null) firstError = r.last_error ?? null;
      }
    }
    return {
      last_scan_at_ms: oldest,
      status: anyError ? "partial" : "idle",
      last_error: firstError,
    };
  }

  // -- Ops ------------------------------------------------------------------
  // Read-only health probe (sync_status tool). Reports one row per resource —
  // the roster ("lists") plus one per roster list ("tasks:{listId}") — built
  // from the UNION of the `lists` table and `sync_state`, so a list that's in
  // the roster but never task-synced still shows up as "baseline_pending"
  // (exactly the state an operator watches drain during a fresh baseline).
  // `mid_cycle` is the operational "has a resume cursor right now" flag, i.e.
  // next_link != null (what the sync loop persists). `totals.all_idle` is the
  // smoke discriminator: every resource idle AND no resume cursor outstanding.
  async syncStatus(): Promise<{
    resources: SyncStatusReport[];
    totals: { tasks: number; lists: number; all_idle: boolean };
  }> {
    const cfg = await loadListsConfig(this.env);

    const stateRows = this.sql
      .exec("SELECT * FROM sync_state")
      .toArray() as unknown as SyncStateRow[];
    const stateByResource = new Map(stateRows.map((s) => [s.resource, s]));

    const listRows = this.sql
      .exec<{ list_id: string; wellknown: string | null }>("SELECT list_id, wellknown FROM lists")
      .toArray();
    const wellknownById = new Map(listRows.map((l) => [l.list_id, l.wellknown]));
    const countRows = this.sql
      .exec<{ list_id: string; n: number }>(
        "SELECT list_id, COUNT(*) AS n FROM tasks GROUP BY list_id",
      )
      .toArray();
    const countByList = new Map(countRows.map((c) => [c.list_id, Number(c.n)]));

    const report = (resource: string, row_count: number): SyncStatusReport => {
      // tasks:{listId} resources for skipped lists report sync_disabled so they
      // don't sit at baseline_pending forever (which would break all_idle).
      if (resource.startsWith("tasks:")) {
        const listId = resource.slice("tasks:".length);
        if (shouldSkipSync({ list_id: listId, wellknown: wellknownById.get(listId) ?? null }, cfg)) {
          return {
            resource,
            status: "sync_disabled",
            last_synced_at: null,
            mid_cycle: false,
            last_error: null,
            row_count: 0,
          };
        }
      }
      const st = stateByResource.get(resource);
      return {
        resource,
        status: st?.status ?? "baseline_pending",
        last_synced_at: st?.last_synced_at ?? null,
        mid_cycle: !!st?.next_link,
        last_error: st?.last_error ?? null,
        row_count,
      };
    };

    const resources: SyncStatusReport[] = [report("lists", listRows.length)];

    // Union of roster lists and any tasks:* state rows (defensive — a stale
    // state row without a roster entry still surfaces).
    const listIds = new Set<string>(listRows.map((l) => l.list_id));
    for (const s of stateRows) {
      if (s.resource.startsWith("tasks:")) listIds.add(s.resource.slice("tasks:".length));
    }
    for (const listId of [...listIds].sort()) {
      resources.push(report(`tasks:${listId}`, countByList.get(listId) ?? 0));
    }

    const tasks = [...countByList.values()].reduce((a, b) => a + b, 0);
    // Exclude sync_disabled resources from the drain discriminator: a skipped
    // list is intentionally never idle-with-a-deltaLink, so counting it would
    // keep all_idle false forever.
    const all_idle = resources
      .filter((r) => r.status !== "sync_disabled")
      .every((r) => r.status === "idle" && !r.mid_cycle);
    return { resources, totals: { tasks, lists: listRows.length, all_idle } };
  }

  // -- Sync (alarm-driven, resumable, budget-bounded) -----------------------

  // Arm the alarm ~now if none is pending. Called by the cron heartbeat and on
  // cold reads so a fresh index warms without waiting for the next cron tick.
  async ensureSyncing(): Promise<void> {
    const pending = await this.ctx.storage.getAlarm();
    if (pending === null) await this.ctx.storage.setAlarm(Date.now() + 1);
  }

  // Read-only notification entrypoint (ROADMAP §4). The webhook defers here.
  // For each item: validate clientState against the stored subscription record,
  // resolve the list, and arm the alarm once (the incremental Graph delta then
  // refreshes the changed task's Graph fields + creates/removes its row). For
  // My Day, refresh JUST the changed task via a targeted Substrate getTask
  // (cost ∝ edits, not list size). Issues NO mutating Graph/Substrate calls
  // (getTask is a GET), so it can never emit a change notification → no loop.
  async onChangeNotification(
    items: Array<{
      subscriptionId?: string;
      clientState?: string;
      changeType?: string;
      resourceId?: string;
    }>,
  ): Promise<{ accepted: number; rejected: number }> {
    let accepted = 0;
    let rejected = 0;
    const work: Array<{ listId: string; taskId?: string; changeType?: string }> = [];
    for (const item of items) {
      const rec = item.subscriptionId ? this.findSubscription(item.subscriptionId) : null;
      if (!rec || rec.client_state !== item.clientState) {
        rejected += 1;
        continue;
      }
      accepted += 1;
      work.push({ listId: rec.list_id, taskId: item.resourceId, changeType: item.changeType });
    }

    // Arm the alarm once for the Graph delta refresh (idempotent; coalesces).
    if (accepted > 0) await this.ctx.storage.setAlarm(Date.now() + 1);

    // Targeted My Day refresh of each changed task. Sequential (EXO forbids
    // parallel Substrate calls). Skipped entirely when My Day is off.
    if (myDayEnabled(this.env)) {
      let sub: SubstrateClient | null = null;
      for (const w of work) {
        if (!w.taskId || w.changeType === "deleted") continue;
        try {
          if (!sub) {
            const ident = await loadIdentity(this.env);
            sub = new SubstrateClient(
              {
                getSubstrateAccessToken: () => this.getSubstrateAccessToken(),
                forceSubstrateRefresh: () => this.forceSubstrateRefresh(),
              },
              ident?.anchorMailbox ?? null,
            );
          }
          // Row must exist for updateMyDayFields to land (it no-ops otherwise).
          // A brand-new task's notification can beat the delta that creates the
          // row → fall back to mark-scan-due so the periodic scan fills it.
          if (this.getMyDayFields(w.taskId) === null) {
            this.#setSyncState(`myday:${w.listId}`, { last_synced_at: null });
            continue;
          }
          const t = await sub.getTask(w.listId, w.taskId);
          this.updateMyDayFields(w.taskId, {
            committed_day: t.CommittedDay ? t.CommittedDay.slice(0, 10) : null,
            committed_order: t.CommittedOrder ?? null,
            order_datetime: t.OrderDateTime ?? null,
            postponed_day: t.PostponedDay ? t.PostponedDay.slice(0, 10) : null,
          });
        } catch (e) {
          if (e instanceof Error && e.message.includes("my_day_unavailable")) {
            log.warn("notif_my_day_unavailable", { error: e.message });
            break; // latched — stop trying this batch
          }
          if (e instanceof SubstrateError && e.status === 403) {
            this.markMyDayUnavailable();
            log.warn("notif_my_day_unavailable", { error: e.detail ?? "403" });
            break;
          }
          // Transient (404 not-yet-propagated, throttle, etc.): mark scan-due so
          // the next budgeted scan reconciles this list.
          this.#setSyncState(`myday:${w.listId}`, { last_synced_at: null });
          log.warn("notif_my_day_refresh_failed", {
            list_id: w.listId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    return { accepted, rejected };
  }

  // One sync cycle per alarm, then re-arm: soon if anything is still mid-cycle
  // (baseline draining), else at the configured interval.
  async alarm(): Promise<void> {
    // Cold / never-authorized: nothing to sync. Don't re-arm — ensureSyncing()
    // (cron heartbeat or a post-/authorize read) restarts the loop.
    if (!(await loadTokens(this.env))) return;
    const midCycle = await this.runSyncCycle();
    const intervalMs = this.#intervalMs();
    await this.ctx.storage.setAlarm(
      Date.now() + (midCycle ? MID_CYCLE_REARM_MS : intervalMs),
    );
  }

  // Force a re-baseline: drop rows + delta tokens (one list or everything) and
  // arm the alarm now. Manual twin of the 410 path. Note: if the target list is
  // skipped (no_sync / built-in flaggedEmails), the next cycle won't re-baseline
  // it, so resync on a skipped list is effectively just a purge.
  async resync(listId?: string): Promise<void> {
    if (listId) {
      this.sql.exec("DELETE FROM tasks WHERE list_id = ?", listId);
      this.sql.exec("DELETE FROM sync_state WHERE resource = ?", `tasks:${listId}`);
    } else {
      this.sql.exec("DELETE FROM tasks");
      this.sql.exec("DELETE FROM sync_state"); // roster + every list re-baseline
    }
    await this.ctx.storage.setAlarm(Date.now() + 1);
  }

  // Hard identity reset: wipe ALL indexed state because the owning Microsoft
  // account changed (auth handler detected a different /me.id). Drops every
  // task (FTS mirror cascades via the AFTER DELETE trigger), the full `lists`
  // roster, and every `sync_state` cursor, then cancels any pending alarm so a
  // stale baseline for the previous identity can't run against the new account's
  // tokens. The KV twin (tokens/identity) is cleared by
  // auth/microsoft.ts wipeIdentityScopedState(), which also calls this.
  //
  // Does NOT re-arm: the new identity's tokens are stored right after the wipe,
  // and the next cron heartbeat (or first cold read via the agent's warm path)
  // calls ensureSyncing() to baseline fresh — exactly like a brand-new index.
  // REVIEW (post-Phase 5): once more pieces land, revisit whether to kick an
  // immediate ensureSyncing() after token storage for a prompter re-baseline,
  // and whether multi-account keying changes this single-instance assumption.
  async resetIdentity(): Promise<void> {
    this.#identityGeneration++; // H4: invalidate any in-flight token refresh (first)
    this.#refreshInFlight = {};
    this.#refreshChain = Promise.resolve();
    // Best-effort: delete THIS identity's Graph subscriptions before we drop the
    // records (which would lose their ids). The outgoing owner's token is still
    // in KV at this point — the caller wipes it AFTER this DO reset — so the
    // deletes can authenticate. After the generation bump getAccessToken still
    // serves a fresh token but refuses to refresh a stale one, so teardown
    // cleans up when it safely can and otherwise leaves the orphans to lapse
    // (≤2.94d). It never blocks or fails the wipe below.
    await this.#teardownAllSubscriptions();
    this.#substrateToken = null;
    this.#substrateUnavailable = false;
    this.sql.exec("DELETE FROM tasks"); // tasks_fts cascades via AFTER DELETE trigger
    this.sql.exec("DELETE FROM lists");
    this.sql.exec("DELETE FROM sync_state");
    this.sql.exec("DELETE FROM subscriptions");
    await this.ctx.storage.deleteAlarm();
  }

  // Delete every stored Graph subscription for the current identity (best effort).
  // Used by resetIdentity on an owner change so we don't strand orphans pointing
  // at our /webhook that we can no longer address by id. Bounded: per-subscription
  // deletes swallow their own errors, and the loop stops the moment auth is no
  // longer usable (so a dead outgoing token isn't hammered N times).
  async #teardownAllSubscriptions(): Promise<void> {
    const records = this.getSubscriptions();
    if (records.length === 0) return;
    const graph = new GraphClient(this);
    let deleted = 0;
    for (const rec of records) {
      try {
        await deleteSubscription(graph, rec.subscription_id);
        deleted += 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn("subscription_teardown_failed", {
          subscription_id: rec.subscription_id,
          error: msg,
        });
        // Auth no longer usable (revoked/expired outgoing token, or the
        // generation bump blocked a refresh) → stop; the rest lapse on their own.
        // A 404 (already gone) is not auth, so keep going.
        if (
          msg.includes("identity_changed") ||
          msg.includes("not_authenticated") ||
          (e instanceof GraphError && (e.status === 401 || e.status === 403))
        ) {
          break;
        }
      }
    }
    if (deleted > 0) log.info("subscription_teardown", { deleted, total: records.length });
  }

  // Run one budget-bounded cycle: roster first (drives which lists to sync),
  // then per-list task delta. `maxTaskPages` bounds task pages only (the roster
  // is small and gets ROSTER_MAX_PAGES). Returns true iff a resource is still
  // genuinely *draining* (a baseline / page-chain left an outstanding nextLink)
  // so the caller re-arms on the fast cadence. Crucially, merely running out of
  // the per-cycle page budget mid-rotation does NOT count: when the roster is
  // larger than the budget, every cycle ends with budget spent, but the lists
  // it touched are caught up — that's steady state, not a drain. Conflating the
  // two (the original bug) pinned the alarm at the 2s fast cadence forever on a
  // roster > MAX_PAGES_PER_CYCLE and starved the calm-cycle-gated My Day scan.
  // Public so tests can drive it with a small budget; alarm() uses the default.
  async runSyncCycle(maxTaskPages: number = MAX_PAGES_PER_CYCLE): Promise<boolean> {
    let anyOutstanding = false;

    // 1. Roster — upserts/deletes `lists`; a removed list purges its tasks too.
    const roster = await this.#syncResource("lists", LISTS_DELTA_URL, ROSTER_MAX_PAGES);
    anyOutstanding ||= roster.midCycle;

    // Load the per-list sync policy once per cycle (a cheap KV read alongside the
    // existing network I/O). Drives both the skip set and self-heal purge below.
    const cfg = await loadListsConfig(this.env);
    const rosterRows = this.listLists();
    const skip = (listId: string): boolean =>
      shouldSkipSync(
        { list_id: listId, wellknown: rosterRows.find((l) => l.list_id === listId)?.wellknown ?? null },
        cfg,
      );

    // 2. Self-heal: purge any indexed rows / sync_state left behind for a list
    //    that is now skipped (added to no_sync, or flaggedEmails before this
    //    deploy). Idempotent — guarded so steady-state cycles write nothing.
    for (const l of rosterRows) {
      if (skip(l.list_id)) this.#purgeSkippedList(l.list_id);
    }

    // 3. Per-list task delta, prioritizing unfinished work, skipping no_sync
    //    lists. Stop when the per-cycle page budget is spent; the oldest-first
    //    priority rotation guarantees the unvisited tail is covered on following
    //    cycles. Running out of budget is NOT "outstanding" work — only a
    //    resource that returned an outstanding nextLink is (set via r.midCycle).
    let remaining = maxTaskPages;
    for (const listId of this.#listIdsByPriority()) {
      if (skip(listId)) continue;
      if (remaining <= 0) break;
      const r = await this.#syncResource(`tasks:${listId}`, tasksDeltaUrl(listId), remaining);
      remaining -= r.pagesFetched;
      anyOutstanding ||= r.midCycle;
    }

    // 4. Background My Day Substrate scan — only when nothing is still draining
    //    (no outstanding nextLink), so its subrequests never stack with a
    //    baseline/page-chain burst. A budget-exhausted-but-caught-up cycle is
    //    calm and DOES run the scan. Budgeted to a few folders per cycle with
    //    oldest-first rotation, keeping each request well under the Workers
    //    free-tier subrequest ceiling regardless of roster size. Runs last so
    //    the gate sees the cycle's final draining state.
    if (!anyOutstanding) {
      // Keep Graph subscriptions tracking the live roster, and renew any nearing
      // expiry. Budgeted (MAX_SUBSCRIPTION_OPS_PER_CYCLE) + gated; failures are
      // swallowed so a Graph hiccup never stalls the delta cycle. Runs on calm
      // cycles only so its Graph calls don't stack on a baseline page-burst.
      await this.reconcileSubscriptions().catch((e) =>
        log.warn("subscription_reconcile_failed", { error: String(e) }),
      );
      await this.renewSubscriptions().catch((e) =>
        log.warn("subscription_renew_batch_failed", { error: String(e) }),
      );
      await this.#runMyDayScanBatch(skip).catch((e) =>
        log.warn("my_day_scan_failed", { error: String(e) }),
      );
      // Drain the checklist backfill/refresh set (gated + budgeted). Same calm-
      // cycle placement so its Graph GETs don't stack on a baseline page-burst.
      await this.#runChecklistScanBatch(skip).catch((e) =>
        log.warn("checklist_scan_failed", { error: String(e) }),
      );
    }
    return anyOutstanding;
  }

  // Drop a skipped list's indexed rows + task sync_state (FTS cascades via the
  // AFTER DELETE trigger). The roster row is intentionally LEFT so the list
  // still appears in list_lists and stays readable via the live-Graph cold
  // fallback. Guarded so a steady-state skipped list costs zero row-writes.
  #purgeSkippedList(listId: string): void {
    const hasRows =
      this.sql.exec("SELECT 1 FROM tasks WHERE list_id = ? LIMIT 1", listId).toArray().length > 0;
    const hasState =
      !!this.#getSyncState(`tasks:${listId}`) || !!this.#getSyncState(`myday:${listId}`);
    if (!hasRows && !hasState) return;
    this.sql.exec("DELETE FROM tasks WHERE list_id = ?", listId);
    this.sql.exec("DELETE FROM checklist_items WHERE list_id = ?", listId);
    this.sql.exec("DELETE FROM sync_state WHERE resource = ?", `tasks:${listId}`);
    this.sql.exec("DELETE FROM sync_state WHERE resource = ?", `myday:${listId}`);
  }

  // Sync one resource ('lists' or 'tasks:{listId}'): resume from next_link, else
  // incremental from delta_link, else baseline. Apply all rows then advance
  // sync_state in one synchronous (atomic) block so a crash mid-fetch replays
  // idempotently from the unchanged cursor.
  async #syncResource(
    resource: string,
    baselineUrl: string,
    maxPages: number,
  ): Promise<{ pagesFetched: number; midCycle: boolean }> {
    const st = this.#getSyncState(resource);
    const startUrl = st?.next_link ?? st?.delta_link ?? baselineUrl;
    const isBaseline = !st?.next_link && !st?.delta_link;
    const graph = new GraphClient(this);

    try {
      const res = await followToTerminal(graph, startUrl, Math.max(1, maxPages));
      this.#applyRows(resource, res.rows);
      if (res.deltaLink) {
        this.#setSyncState(resource, {
          delta_link: res.deltaLink,
          next_link: null,
          last_synced_at: Date.now(),
          status: "idle",
          last_error: null,
        });
      } else if (res.nextLink) {
        this.#setSyncState(resource, {
          next_link: res.nextLink,
          status: isBaseline ? "baseline" : "syncing",
        });
      } else {
        // Terminal with neither link (defensive): treat as caught up.
        this.#setSyncState(resource, {
          next_link: null,
          status: "idle",
          last_synced_at: Date.now(),
        });
      }
      return { pagesFetched: res.pagesFetched, midCycle: !!res.nextLink };
    } catch (e) {
      if (e instanceof GraphError && e.status === 410) {
        // Delta token expired (~30d). Purge the resource's rows and reset to
        // baseline; the next cycle repopulates from the full collection.
        log.warn("sync_410_rebaseline", { resource });
        this.#purgeResource(resource);
        this.#setSyncState(resource, {
          delta_link: null,
          next_link: null,
          status: "baseline",
          last_error: "410_gone",
        });
        return { pagesFetched: 1, midCycle: true };
      }
      if (e instanceof GraphError && (e.status === 429 || e.status === 503)) {
        // Transient throttle / unavailable. GraphClient already honored
        // Retry-After once; leave the cursor intact (NOT a hard error) and
        // report mid-cycle so the alarm re-arms on the fast cadence and resumes
        // promptly — effective backoff stays Retry-After-paced via GraphClient,
        // instead of stalling a full DELTA_SYNC_INTERVAL_MIN. Common on the
        // initial baseline of a large account.
        log.warn("sync_throttled", { resource, status: e.status });
        this.#setSyncState(resource, {
          status: isBaseline ? "baseline" : "syncing",
          last_error: `throttled_${e.status}`,
        });
        return { pagesFetched: 1, midCycle: true };
      }
      const msg = e instanceof Error ? e.message : String(e);
      log.warn("sync_resource_error", { resource, error: msg });
      this.#setSyncState(resource, { status: "error", last_error: msg });
      return { pagesFetched: 1, midCycle: false }; // isolated; retried next cycle
    }
  }

  #applyRows(resource: string, rows: DeltaRow[]): void {
    if (resource === "lists") {
      for (const row of rows) {
        if (row.kind === "removed") this.deleteList(row.id);
        else this.upsertList(TodoTaskListSchema.parse(row.task));
      }
      return;
    }
    const listId = resource.slice("tasks:".length);
    const checklist = checklistCacheEnabled(this.env);
    for (const row of rows) {
      if (row.kind === "removed") {
        this.deleteTask(row.id); // cascades checklist_items
      } else {
        this.upsertTask(row.task, listId);
        // Incremental engine: a task that rode delta CHANGED (checklist edits bump
        // its lastModifiedDateTime), so its cached checklist may be stale — mark it
        // for re-fetch by the next budgeted scan. Delta carries no expansions, so
        // we can't diff the checklist here; the marker + scan does it cheaply.
        if (checklist) this.markChecklistDirty(row.task.id);
      }
    }
  }

  #purgeResource(resource: string): void {
    if (resource === "lists") {
      this.sql.exec("DELETE FROM tasks");
      this.sql.exec("DELETE FROM checklist_items");
      this.sql.exec("DELETE FROM lists");
      this.sql.exec("DELETE FROM sync_state WHERE resource LIKE 'tasks:%'");
      return;
    }
    const listId = resource.slice("tasks:".length);
    this.sql.exec("DELETE FROM tasks WHERE list_id = ?", listId);
    this.sql.exec("DELETE FROM checklist_items WHERE list_id = ?", listId);
  }

  #getSyncState(resource: string): SyncStateRow | null {
    const rows = this.sql
      .exec("SELECT * FROM sync_state WHERE resource = ?", resource)
      .toArray() as unknown as SyncStateRow[];
    return rows.length > 0 ? rows[0] : null;
  }

  #setSyncState(resource: string, patch: Partial<Omit<SyncStateRow, "resource">>): void {
    const cur = this.#getSyncState(resource);
    const next: SyncStateRow = {
      resource,
      delta_link: patch.delta_link !== undefined ? patch.delta_link : (cur?.delta_link ?? null),
      next_link: patch.next_link !== undefined ? patch.next_link : (cur?.next_link ?? null),
      last_synced_at:
        patch.last_synced_at !== undefined ? patch.last_synced_at : (cur?.last_synced_at ?? null),
      status: patch.status !== undefined ? patch.status : (cur?.status ?? null),
      last_error: patch.last_error !== undefined ? patch.last_error : (cur?.last_error ?? null),
    };
    this.sql.exec(
      `INSERT INTO sync_state (resource, delta_link, next_link, last_synced_at, status, last_error)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(resource) DO UPDATE SET
         delta_link=excluded.delta_link, next_link=excluded.next_link,
         last_synced_at=excluded.last_synced_at, status=excluded.status,
         last_error=excluded.last_error`,
      next.resource,
      next.delta_link,
      next.next_link,
      next.last_synced_at,
      next.status,
      next.last_error,
    );
  }

  // List ids ordered so the cycle spends its bounded page budget fairly:
  // unfinished work first (mid-cycle resumes, then never-baselined lists), then
  // a single "maintenance" tier (idle AND errored) rotated OLDEST-synced first.
  //
  // The oldest-first rotation is load-bearing when the roster exceeds
  // MAX_PAGES_PER_CYCLE: each idle list costs ≥1 page even with no changes, so a
  // fixed order would re-sync the same head every cycle and permanently starve
  // the tail (and never retry errored lists, which a rank-by-state scheme parks
  // last). Sorting by last_synced_at ASC guarantees every list — fresh, stale,
  // or errored — reaches the front within ⌈roster / budget⌉ cycles. Errored
  // lists keep their last successful timestamp (the error path doesn't advance
  // it), so a transient failure is retried promptly while a list that just
  // synced waits its turn.
  #listIdsByPriority(): string[] {
    const lists = this.sql
      .exec<{ list_id: string }>("SELECT list_id FROM lists")
      .toArray();
    const keyed = lists.map((l) => {
      const st = this.#getSyncState(`tasks:${l.list_id}`);
      let tier: number;
      if (st?.next_link) tier = 0; // resume an in-flight baseline/page chain
      else if (!st || !st.delta_link) tier = 1; // never baselined
      else tier = 2; // idle or errored — rotate by staleness
      // Oldest first within a tier; never-synced (null) sorts oldest.
      return { list_id: l.list_id, tier, age: st?.last_synced_at ?? 0 };
    });
    return keyed
      .sort((a, b) => a.tier - b.tier || a.age - b.age)
      .map((k) => k.list_id);
  }

  // Budgeted background My Day Substrate scan. Substrate has no delta, so each
  // list is a full per-folder enumeration; running the whole roster in one cycle
  // would stack N Substrate GETs onto the task-delta page burst and can blow the
  // Workers free-tier subrequest ceiling. Instead we scan at most
  // MY_DAY_SCAN_MAX_FOLDERS_PER_CYCLE lists per call, oldest-scanned first
  // (selectDueScanLists), recording a per-list "myday:{listId}" sync_state row.
  // Over ⌈roster / cap⌉ calm cycles every list is refreshed within its window;
  // raising the cap (paid plans) scans more — or the whole roster — per cycle.
  //
  // Sequential GETs (EXO MailboxConcurrency forbids parallel). Tasks not yet in
  // the cache are ignored (updateMyDayFields no-ops on a missing task_id; the
  // next Graph delta creates the row, a later scan fills the fields). A
  // my_day_unavailable / SubstrateError 403 (denied/latched scope) aborts the
  // batch cleanly. Per-folder errors leave that list's last-scan time untouched
  // so it stays due and is retried on the next calm cycle (no starvation,
  // mirroring the task-delta error path).
  async #runMyDayScanBatch(skip: (listId: string) => boolean = () => false): Promise<void> {
    if (!myDayEnabled(this.env)) return;

    const windowMs = this.#myDayScanWindowMs();
    const max = this.#myDayScanMaxFoldersPerCycle();
    // Exclude no_sync / built-in skipped lists exactly like the task-delta loop —
    // scanning them would waste scan slots (their tasks aren't cached, so the
    // upsert is a no-op) and could starve real lists out of the per-cycle budget.
    const entries = this.listLists()
      .filter((l) => !skip(l.list_id))
      .map((l) => ({
        list_id: l.list_id,
        last: this.#getSyncState(`myday:${l.list_id}`)?.last_synced_at ?? null,
      }));
    const due = selectDueScanLists(entries, windowMs, max);
    if (due.length === 0) return;

    const ident = await loadIdentity(this.env);
    const sub = new SubstrateClient(
      {
        getSubstrateAccessToken: () => this.getSubstrateAccessToken(),
        forceSubstrateRefresh: () => this.forceSubstrateRefresh(),
      },
      ident?.anchorMailbox ?? null,
    );

    let folders_scanned = 0;
    let folders_errored = 0;

    for (const listId of due) {
      try {
        const folderTasks = await sub.listFolderTasks(listId);
        for (const t of folderTasks) {
          if (!t.Id) continue;
          this.updateMyDayFields(t.Id, {
            committed_day: t.CommittedDay ? t.CommittedDay.slice(0, 10) : null,
            committed_order: t.CommittedOrder ?? null,
            order_datetime: t.OrderDateTime ?? null,
            postponed_day: t.PostponedDay ? t.PostponedDay.slice(0, 10) : null,
          });
        }
        // Success: stamp last_synced_at = now so this list drops to the back of
        // the rotation until its window lapses again.
        this.#setSyncState(`myday:${listId}`, {
          last_synced_at: Date.now(),
          status: "idle",
          last_error: null,
        });
        folders_scanned += 1;
      } catch (e) {
        if (e instanceof Error && e.message.includes("my_day_unavailable")) {
          log.warn("my_day_scan_unavailable", { error: e.message });
          return;
        }
        if (e instanceof SubstrateError && e.status === 403) {
          this.markMyDayUnavailable();
          log.warn("my_day_scan_unavailable", { error: e.detail ?? "403" });
          return;
        }
        folders_errored += 1;
        const msg = e instanceof Error ? e.message : String(e);
        // Record the error WITHOUT advancing last_synced_at, so the list stays
        // due and is retried on the next calm cycle (transient failures recover
        // promptly; a never-successful list keeps logging rather than silently
        // dropping out).
        this.#setSyncState(`myday:${listId}`, { status: "error", last_error: msg });
        log.warn("my_day_scan_folder_failed", { list_id: listId, error: msg });
      }
    }

    log.info("my_day_scan_batch", {
      folders_scanned,
      folders_errored,
      due: due.length,
      roster: entries.length,
    });
  }

  // Budgeted background checklist backfill/refresh scan. Graph has no
  // hasChecklist boolean and delta carries no expansions, so each task's
  // checklist is a per-task GET; running the whole NULL-marker set in one cycle
  // could blow the Workers free-tier subrequest ceiling. Instead we drain at most
  // CHECKLIST_SCAN_MAX_TASKS_PER_CYCLE tasks per calm cycle (newest-changed
  // first). The marker is self-tracking: a drained task gets checklist_synced_at
  // stamped and drops out; the delta-apply path re-nulls it when the task changes
  // again (the incremental engine). Over ⌈backlog / cap⌉ calm cycles a cold cache
  // backfills; steady state is ~one GET per changed task.
  //
  // Per-task errors leave the marker NULL so the task stays due and retries next
  // cycle (mirrors the My Day / task-delta error paths) — never mutating the task
  // row, so an unreachable checklist can't corrupt cached task state. A persistent
  // error keeps a task at the head of the rotation; the dominant terminal case
  // (task deleted upstream → 404) is resolved by the next delta removal.
  async #runChecklistScanBatch(skip: (listId: string) => boolean = () => false): Promise<void> {
    if (!checklistCacheEnabled(this.env)) return;

    const max = checklistScanMaxTasksPerCycle(this.env);
    const skipIds = this.listLists()
      .filter((l) => skip(l.list_id))
      .map((l) => l.list_id);
    const due = this.selectDueChecklistTasks(max, skipIds);
    if (due.length === 0) return;

    const graph = new GraphClient(this);
    let scanned = 0;
    let errored = 0;
    for (const { task_id, list_id } of due) {
      try {
        const items = await listChecklistItems(graph, list_id, task_id);
        this.replaceChecklistItems(task_id, list_id, items);
        scanned += 1;
      } catch (e) {
        errored += 1;
        const msg = e instanceof Error ? e.message : String(e);
        // Leave the marker NULL (retried next cycle); do NOT touch the task row.
        log.warn("checklist_scan_task_failed", { task_id, list_id, error: msg });
      }
    }
    log.info("checklist_scan_batch", { scanned, errored, due: due.length });
  }

  #intervalMs(): number {
    const min = Number(this.env.DELTA_SYNC_INTERVAL_MIN);
    return (Number.isFinite(min) && min > 0 ? min : 15) * 60_000;
  }

  #myDayScanEveryNCycles(): number {
    const n = Number(this.env.MY_DAY_SCAN_EVERY_N_CYCLES);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
  }

  #myDayScanWindowMs(): number {
    return this.#intervalMs() * this.#myDayScanEveryNCycles();
  }

  // Max lists scanned per cycle. Small by default so the scan's Substrate GETs
  // stay well under the Workers free-tier subrequest ceiling even on a large
  // roster; raise it on paid plans to scan more (or the whole roster) per cycle.
  #myDayScanMaxFoldersPerCycle(): number {
    const n = Number(this.env.MY_DAY_SCAN_MAX_FOLDERS_PER_CYCLE);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 6;
  }
}
