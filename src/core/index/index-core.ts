import {
  TodoTaskListSchema,
  type Attachment,
  type ChecklistItem,
  type LinkedResource,
  type TodoTask,
  type TodoTaskList,
} from "../graph/types";
import { coalescing } from "../sync/coalesce";
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
  reauthReasonFromTokenError,
  type StoredTokens,
} from "../auth/microsoft";
import { ReauthRequiredError, type ReauthState } from "../auth/reauth";
import { SubstrateClient, SubstrateError, type SubstrateFolder, type SubstrateFolderGroup } from "../graph/substrate-client";
import { GraphClient, looksImmutable, GraphError, type TokenProvider } from "../graph/client";
import { followToTerminal, type DeltaRow } from "../graph/delta";
import { encodeCursor, decodeCursor } from "../util/cursor";
import { log } from "../log";
import type { AlarmScheduler, AppEnv, ChangeNotifier, SqlDb, SqlValue, StateStore, Transact } from "../ports";
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
import { applyMigrations, seedAppSettings } from "./migrations";
import {
  appSettingsData, changesSince, currentCursor, taskBySid, taskSids, themeImageData,
  type FeedResult, type FeedThemeImage, type ImageStyle, type SmartList, type SmartListTheme,
} from "./change-feed";
import { loadListsConfig, storeListsConfig } from "../config/loader";
import { ListsConfigSchema, type ListsConfig } from "../config/schemas";
import {
  applyListsConfigChange,
  listSync,
  shouldSkipSync,
  type ListsConfigChange,
  type ListSync,
} from "../config/sync-policy";
import {
  taskSubscriptionsEnabled,
  webhookUrl,
  SUBSCRIPTION_LIFETIME_MS,
  SUBSCRIPTION_RENEW_MARGIN_MS,
  maxSubscriptionOpsPerCycle,
} from "../subscriptions/gate";
import { checklistCacheEnabled, checklistScanMaxTasksPerCycle } from "../checklist/gate";
import { getTaskWithSubresources, listAttachments } from "../graph/todo-resources";
import {
  createSubscription,
  renewSubscription,
  deleteSubscription,
  listGraphSubscriptions,
  parseTodoListId,
  newClientState,
  desiredExpiration,
  type GraphSubscription,
} from "../subscriptions/manager";

// Phase 5 — IndexCore (hosted on Cloudflare by the TodoIndex singleton Durable
// Object, src/hosts/cloudflare/todo-index-do.ts): the single source of truth for
// Microsoft To Do state. SQLite `tasks` (+ `tasks_fts` FTS5 mirror) + `lists`
// roster + `sync_state`. Addressed via ownerIndex(env) from the agent
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
// A list-id set bound as one JSON array parameter. Durable Object SQLite
// allows 100 bound parameters per statement, and a roster can pass that.
const IN_JSON = "(SELECT value FROM json_each(?))";

const UPSERT_TASK_SQL = (() => {
  const cols = TASK_COLUMNS.join(", ");
  const placeholders = TASK_COLUMNS.map(() => "?").join(", ");
  // has_checklist comes from an expanded checklistItems; a delta row or a bare
  // write response has none, and must not erase what the scan found.
  const updates = TASK_COLUMNS.filter((c) => c !== "task_id")
    .map((c) => (c === "has_checklist" ? `${c}=COALESCE(excluded.${c}, tasks.${c})` : `${c}=excluded.${c}`))
    .join(", ");
  // The WHERE keeps an older copy from overwriting a newer one: a delta page
  // fetched before an MCP write-through landed must not revert it (the write's
  // own Graph response carries the newer lastModifiedDateTime). Rows without a
  // timestamp on either side update as before.
  return `INSERT INTO tasks (${cols}) VALUES (${placeholders}) ON CONFLICT(task_id) DO UPDATE SET ${updates}
    WHERE excluded.modified_at IS NULL OR tasks.modified_at IS NULL OR excluded.modified_at >= tasks.modified_at`;
})();

// Sub-resource backfill (section 1.1): a bigger batch and a short re-arm while
// a backlog remains, so a one-time fill of a few thousand tasks takes tens of
// minutes rather than days. Each task is one or two Graph GETs (plus one
// Substrate GET when it has steps), well inside the paid plan's subrequest cap.
const BACKFILL_TASKS_PER_CYCLE = 40;
const BACKFILL_REARM_MS = 20_000;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Delta sync budget (free-tier ceiling is 50 subrequests/request). The roster
// is tiny so it gets its own small cap; task pages share MAX_PAGES_PER_CYCLE.
// Worst case per cycle ≈ ROSTER_MAX_PAGES + MAX_PAGES_PER_CYCLE + 1 refresh = 41
// subrequests. The My Day scan only runs on calm (non-mid-cycle) cycles and is
// itself capped at MY_DAY_SCAN_MAX_FOLDERS_PER_CYCLE (default 6) + 1 substrate
// mint, so even a calm cycle that fully drained its task pages stays ≈ 48 — still
// under the ceiling with headroom. The sidebar appearance read
// (#refreshListAppearance) adds two Substrate GETs at most once per
// DELTA_SYNC_INTERVAL_MIN, plus once when a new list appears.
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

// Reserved sync_state row holding webhook-delivery telemetry (last_synced_at =
// last accepted notification's epoch ms; status = cumulative accepted count as
// a string). It is NOT a "lists"/"tasks:*"/"myday:*" resource, so syncStatus'
// generic report loop ignores it — it only surfaces via #webhookHealth().
const WEBHOOK_HEALTH_KEY = "meta:webhook";

// Reserved sync_state row for the sidebar appearance read (#refreshListAppearance):
// last_synced_at = the last successful read. Like meta:webhook, syncStatus
// doesn't report it.
const APPEARANCE_STATE_KEY = "meta:appearance";
// StateStore key for the read's backoff after failures, and its ceiling.
const APPEARANCE_BACKOFF_KEY = "appearance:backoff";
// When the first sidebar read succeeded (ms). Every group existing then got a
// row stamped with that time, so a retried group create can tell old groups
// from new only for an attempt made after it (ops/lists.ts).
const APPEARANCE_FIRST_READ_KEY = "appearance:first_read_at";
const APPEARANCE_BACKOFF_MAX_MS = 6 * 3_600_000;
interface AppearanceBackoff {
  failures: number;
  next_at: number;
}

// Delivery-health view of the Graph change-notification (webhook) path. The
// signal that distinguishes "subscriptions exist (coverage ok)" from
// "subscriptions are actually delivering": Graph can silently stop sending
// todoTask notifications with no lifecycle event, leaving full coverage but a
// stale `last_notification_at`. Only *accepted* (clientState-validated)
// notifications are recorded, so unauthenticated POSTs to the public /webhook
// can't forge a healthy signal.
export interface WebhookHealth {
  last_notification_at: number | null; // epoch ms of the last accepted notification
  notifications_total: number; // cumulative accepted notifications
  minutes_since: number | null; // age of last_notification_at, null if never
}

// Concrete (RPC-serializable) shapes for subscriptionStatus(). Avoid
// Record<string, unknown> here — Cloudflare's RPC type mapper collapses
// `unknown`-valued returns to `never` at the call site.
export interface SubscriptionConfig {
  subscriptions_enabled: boolean;
  webhook_url: string | null;
  service_base_url: string | null;
  my_day_enabled: boolean;
  subscription_lifetime_min: number;
  subscription_renew_margin_min: number;
  max_subscription_ops_per_cycle: number;
  delta_sync_interval_min: number;
  my_day_scan_every_n_cycles: number;
  my_day_scan_window_min: number;
}
export interface SubscriptionStatus {
  ok: true;
  config: SubscriptionConfig;
  summary: {
    wanted: number;
    local_records: number;
    graph_subs_ours: number;
    dark: number;
    dead: number;
    orphan: number;
  };
  dark: string[];
  dead: Array<{ list_id: string; subscription_id: string; expiration_ms: number }>;
  orphan: Array<{ subscription_id: string; list_id: string | null; resource?: string }>;
  // How many of our live Graph subs carry a lifecycleNotificationUrl (delivery
  // prerequisite). `lists_with` names the lists already on a lifecycle-enabled
  // sub. Absent when Graph was unreachable (graph_error set).
  lifecycle?: { with: number; without: number; lists_with: string[] };
  // Raw Graph subscription objects for our subs (clientState omitted) — diagnostic,
  // OPT-IN: only populated when subscriptionStatus is called with { includeRaw: true }
  // (the subscription_status tool's `include_raw` flag); omitted from the response otherwise.
  graph_raw?: Array<{
    subscription_id: string;
    resource?: string;
    notification_url?: string;
    lifecycle_url: string | null;
    change_type: string | null;
    application_id: string | null;
    creator_id: string | null;
    content_type: string | null;
    expiration?: string;
  }>;
  graph_error?: string;
}

// DO-storage keys for the MCP grant epoch and the re-auth flag (see authState).
const AUTH_EPOCH_KEY = "auth:epoch";
const REAUTH_KEY = "auth:reauth";
// The pending lists config (refreshListSync) and how long it outranks KV:
// KV's 60 s worst-case staleness after a write, plus margin.
const PENDING_LISTS_CONFIG_KEY = "config:lists:pending";
const LISTS_CONFIG_PENDING_MS = 90_000;

export class IndexCore implements TokenProvider {
  readonly #sql: SqlDb;
  readonly #state: StateStore;
  readonly #alarms: AlarmScheduler;
  readonly #env: AppEnv;

  readonly #transact: Transact;
  // Set by the sub-resource scan while more than one batch is waiting.
  #scanBacklog = false;
  readonly #notifier: ChangeNotifier | null;
  // The highest change-log seq announced to push clients.
  #announcedSeq = -1;
  // Lists named by webhooks, or whose sync setting just changed, since the
  // last sync cycle; synced first.
  #hotLists = new Set<string>();
  // The last lists config handed to refreshListSync (see there). undefined
  // until read back from storage.
  #pendingListsConfig: { cfg: ListsConfig; at: number } | null | undefined = undefined;
  // Serializes updateListsConfig.
  #configChain: Promise<void> = Promise.resolve();
  // Per list, how many times #purgeSkippedList has emptied it. #syncResource
  // compares it across its Graph fetch (see there).
  #purges = new Map<string, number>();

  constructor(deps: {
    sql: SqlDb;
    transact: Transact;
    state: StateStore;
    alarms: AlarmScheduler;
    env: AppEnv;
    notifier?: ChangeNotifier;
  }) {
    // One message per burst of changes, not one per write (sync/coalesce.ts).
    this.#notifier = deps.notifier ? coalescing(deps.notifier) : null;
    this.#sql = deps.sql;
    this.#transact = deps.transact;
    this.#state = deps.state;
    this.#alarms = deps.alarms;
    this.#env = deps.env;
  }

  // Schema bootstrap is idempotent (IF NOT EXISTS). The host runs it once per
  // instance before any request is delivered — the Cloudflare shell inside
  // blockConcurrencyWhile, the documented place for schema setup.
  bootstrap(): void {
    this.#sql.exec(SCHEMA_DDL);
    // Versioned migrations: ALTER existing/new DBs up to the latest schema.
    // Idempotent across boots (gated by the stored schema_meta version).
    const { from, applied } = applyMigrations(this.#sql);
    // A migration that cleared or reset sync state (v4, v7) must start the next cycle
    // itself; otherwise the re-baseline waits for whatever alarm was set before
    // the deploy (up to DELTA_SYNC_INTERVAL_MIN). Seen in production 2026-11-24.
    // A fresh database (from 0) has nothing to rebuild; ensureSyncing starts it.
    if (from > 0 && (applied.includes(4) || applied.includes(7))) {
      void this.#alarms.setAlarm(Date.now() + 1000).catch((e) =>
        log.warn("migration_alarm_failed", { error: String(e) }),
      );
    }
  }

  // -- MCP grant epoch + re-auth state --------------------------------------
  // Both live in DO storage rather than KV because they gate access: a
  // revocation must take effect on the next tool call everywhere, and KV reads
  // can serve a cached value for up to 60 s after a write.
  //
  // The epoch is an opaque random value stamped into every MCP grant's props at
  // /authorize. A grant whose epoch doesn't match the current one is dead — the
  // tool preflight refuses it and its next refresh is rejected (refuseMcpRequest / grantRefusal in core/auth/grant.ts).
  // Bumping the epoch therefore revokes every outstanding MCP grant at once.
  //
  // The re-auth flag is set when Microsoft refuses a refresh for good or answers
  // with a Conditional Access claims challenge. While it's set, every tool —
  // including the cache-only ones — reports reauth_required, so cached task data
  // stops being served once Microsoft access is gone.

  async authState(): Promise<{ epoch: string; reauth: ReauthState | null }> {
    let epoch = await this.#state.get<string>(AUTH_EPOCH_KEY);
    if (!epoch) epoch = await this.#newEpoch();
    const reauth = (await this.#state.get<ReauthState>(REAUTH_KEY)) ?? null;
    return { epoch, reauth };
  }

  // Invalidate every outstanding MCP grant. Returns the new epoch.
  async revokeAllGrants(): Promise<string> {
    const epoch = await this.#newEpoch();
    log.warn("mcp_grants_revoked", {});
    this.#notifier?.closeAll("revoked");
    return epoch;
  }

  async markReauthRequired(reason: string, claims?: string): Promise<void> {
    const state: ReauthState = { reason, at: Date.now(), ...(claims ? { claims } : {}) };
    await this.#state.put(REAUTH_KEY, state);
    log.warn("reauth_required", { reason });
  }

  // Called after a successful /authorize: Microsoft access is back, so resume
  // syncing (the alarm stops re-arming while re-auth is required).
  async clearReauth(): Promise<void> {
    await this.#state.delete(REAUTH_KEY);
    await this.ensureSyncing();
  }

  // ClaimsChallengeSink for this DO's own GraphClient (the sync loop).
  async reportClaimsChallenge(claims: string): Promise<void> {
    await this.markReauthRequired("claims_challenge", claims);
  }

  async #newEpoch(): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const epoch = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    await this.#state.put(AUTH_EPOCH_KEY, epoch);
    return epoch;
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
  // Set when Substrate answers the sidebar read with a 403 (#refreshListAppearance).
  // Separate from #substrateUnavailable: it turns off only list appearance.
  // Cleared by an identity switch or a restart of the object.
  #appearanceUnavailable = false;

  // Bumped by resetIdentity() on an owner switch. Captured at the start of each
  // refresh so a refresh that resolves AFTER the switch can detect it and refuse
  // to persist the prior account's tokens over the new identity's (H4).
  #identityGeneration = 0;
  // Bumped by every sidebar store from a write (storeFolderAppearance,
  // storeFolderGroup, removeFolderGroup). A sidebar read that sees it change
  // between its GETs and its apply may predate the write, so it is dropped.
  #sidebarWriteGen = 0;

  // Returns a valid access token, refreshing only if the stored one is within
  // REFRESH_SKEW_MS of expiry. The agent already gates on freshness before
  // delegating, but the DO re-checks so its own sync loop shares the same path.
  async getAccessToken(): Promise<string> {
    const stored = await loadTokens(this.#env);
    if (!stored) throw new Error("not_authenticated");
    if (stored.expires_at > Date.now() + REFRESH_SKEW_MS) return stored.access_token;
    return this.#refreshResource("graph");
  }

  // Forces a refresh regardless of current freshness (GraphClient 401 path).
  async refreshToken(): Promise<string> {
    const stored = await loadTokens(this.#env);
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

      const stored = await loadTokens(this.#env);
      if (!stored) throw new Error("not_authenticated");

      const scope = resource === "graph" ? SCOPES : SUBSTRATE_SCOPES;
      let res;
      try {
        res = await refreshTokensForScope(this.#env, stored.refresh_token, scope);
      } catch (e) {
        // AADSTS65001 = the owner consented to Graph but not the EXO resource.
        // Latch unavailable so My Day tools degrade cleanly instead of retrying.
        const reauth = reauthReasonFromTokenError(e);
        // An EXO-only refusal (AADSTS65001 unconsented scope, or a Conditional
        // Access policy that targets Exchange Online but not Graph) disables My
        // Day, not the whole server: Graph access is still fine, and re-authorizing
        // wouldn't help if the policy can't be met for EXO.
        if (
          resource === "substrate" &&
          (reauth || (e instanceof TokenExchangeError && e.detail.includes("AADSTS65001")))
        ) {
          this.#substrateUnavailable = true;
          throw new Error("my_day_unavailable");
        }
        if (reauth && gen === this.#identityGeneration) {
          await this.markReauthRequired(reauth);
          throw new ReauthRequiredError(reauth);
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
        await storeTokens(this.#env, next);
        return next.access_token;
      }

      // Substrate: persist ONLY the rotated refresh token (if any) back to
      // tokens:owner — never clobber the Graph access_token/scope/expires_at,
      // which a Graph caller still reads. Cache the EXO access token in memory.
      const newRefresh = res.refresh_token ?? stored.refresh_token;
      if (newRefresh !== stored.refresh_token) {
        await storeTokens(this.#env, { ...stored, refresh_token: newRefresh });
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
  // A task in an excluded list is never mirrored (section 1.2), even when a
  // write tool just created or changed it in Graph: its row (if any) goes,
  // and the feed sends a deletion. The same guard is on every write-through
  // below that names a list.
  upsertTask(task: TodoTask, listId: string): void {
    if (this.#isExcluded(listId)) {
      this.deleteTask(task.id);
      return;
    }
    const row = taskToRow(task, listId);
    const modified = task.lastModifiedDateTime ? Date.parse(task.lastModifiedDateTime) : NaN;
    this.#clocked("task", task.id, Number.isNaN(modified) ? Date.now() : modified, () =>
      this.#sql.exec(UPSERT_TASK_SQL, ...TASK_COLUMNS.map((c) => row[c])),
    );
    this.#stampTask(task.id);
  }

  // Runs a write to one entity's row and stamps the field clock of each
  // clocked field it changed with max(existing, atMs). A row the write
  // inserted stamps nothing: no app edit can predate the entity's arrival,
  // and stamping a create's defaults would supersede the app's own queued
  // edits to them.
  //
  // Lists, links and a step's title carry no modification time from Graph,
  // so their changes are stamped when this server sees them (a write-through,
  // or for one made in To Do, the next roster sync or sub-resource scan).
  // That can be later than the To Do edit, so a queued app edit made in
  // between loses to it: a bias toward To Do, accepted.
  #clocked<T>(kind: string, graphId: string, atMs: number | ((field: string) => number), write: () => T): T {
    const spec = CLOCKED[kind];
    const cols = [...new Set(Object.values(spec.fields).flat())];
    const read = () =>
      this.#sql
        .exec<Record<string, SqlValue>>(`SELECT ${cols.join(", ")} FROM ${spec.table} WHERE ${spec.key} = ?`, graphId)
        .toArray()[0];
    const before = read();
    const out = write();
    if (!before) return out;
    const after = read();
    if (!after) return out;
    const changed = Object.entries(spec.fields)
      .filter(([, columns]) => columns.some((c) => before[c] !== after[c]))
      .map(([field]) => field);
    if (changed.length === 0) return out;
    const sid = this.#sql
      .exec<{ sid: string }>("SELECT sid FROM entity_map WHERE kind = ? AND graph_id = ?", kind, graphId)
      .toArray()[0]?.sid;
    if (!sid) return out;
    for (const field of changed) {
      this.#sql.exec(
        `INSERT INTO field_clock (kind, sid, field, at_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, sid, field) DO UPDATE SET at_ms = max(at_ms, excluded.at_ms)`,
        kind, sid, field, typeof atMs === "number" ? atMs : atMs(field),
      );
    }
    return out;
  }

  // While its list is re-baselining, mark a task as seen by this baseline so
  // the sweep keeps it. Covers delta rows and write-throughs alike (section
  // 3.3). A no-op when no baseline is in progress.
  #stampTask(taskId: string): void {
    this.#sql.exec(
      `UPDATE tasks SET baseline_gen = s.sweep_gen FROM sync_state s
        WHERE tasks.task_id = ? AND s.resource = 'tasks:' || tasks.list_id AND s.sweep_gen IS NOT NULL`,
      taskId,
    );
  }

  deleteTask(taskId: string): void {
    this.#sql.exec("DELETE FROM tasks WHERE task_id = ?", taskId);
    // Cascade: no FK, so drop the task's checklist rows explicitly (FTS follows
    // via the AFTER DELETE trigger). Cheap no-op when the cache is unused.
    this.#sql.exec("DELETE FROM checklist_items WHERE task_id = ?", taskId);
    this.#sql.exec("DELETE FROM linked_resources WHERE task_id = ?", taskId);
    this.#sql.exec("DELETE FROM attachments WHERE task_id = ?", taskId);
  }

  // A task moved to another list, as one transaction. Replaces the old
  // delete-then-upsert re-key, which dropped the task's steps and My Day fields
  // in between (and would read as a deletion to a change feed). newTaskId is
  // the ID after the move when it differs (plain Graph IDs change on a
  // re-parent); omit it when the ID is stable. If the destination is already
  // mirrored, the source's row (and sid) replaces it; see below.
  moveTask(taskId: string, toListId: string, newTaskId?: string): void {
    this.#transact(() => {
      if (this.#isExcluded(toListId)) {
        // Moved out of the mirror: a deletion, like any task of that list.
        this.deleteTask(taskId);
        if (newTaskId && newTaskId !== taskId) this.deleteTask(newTaskId);
        return;
      }
      const to = newTaskId ?? taskId;
      const dest =
        to === taskId
          ? undefined
          : this.#sql.exec<Record<string, SqlValue>>("SELECT * FROM tasks WHERE task_id = ?", to).toArray()[0];
      if (dest) {
        // The destination is already mirrored under a sid of its own (delta, or
        // a write-through, got there first). The task's sid must follow the
        // move, so that row goes (clients that saw its sid get a deletion) and
        // its map row lets go of the Graph ID; its columns are copied onto the
        // re-keyed row below, keeping the source's Substrate-only fields where
        // the destination has none.
        this.#sql.exec("DELETE FROM tasks WHERE task_id = ?", to);
        for (const table of ["checklist_items", "linked_resources", "attachments"]) {
          this.#sql.exec(`DELETE FROM ${table} WHERE task_id = ?`, to);
        }
        this.#sql.exec("UPDATE entity_map SET graph_id = NULL WHERE kind = 'task' AND graph_id = ?", to);
      }
      // Re-point the task's stable ID first, so the change log keeps the same
      // sid when the row's Graph ID changes.
      if (to !== taskId) {
        this.#sql.exec("UPDATE entity_map SET graph_id = ? WHERE kind = 'task' AND graph_id = ?", to, taskId);
      }
      this.#sql.exec("UPDATE tasks SET task_id = ?, list_id = ? WHERE task_id = ?", to, toListId, taskId);
      if (dest) {
        const substrateOnly = new Set(["committed_day", "committed_order", "order_datetime", "postponed_day"]);
        const cols = Object.keys(dest).filter((k) => k !== "task_id" && k !== "list_id" && !(substrateOnly.has(k) && dest[k] == null));
        if (cols.length) {
          this.#sql.exec(`UPDATE tasks SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE task_id = ?`, ...cols.map((k) => dest[k]), to);
        }
      }
      this.#stampTask(to);
      for (const table of ["checklist_items", "linked_resources", "attachments"]) {
        this.#sql.exec(`UPDATE ${table} SET task_id = ?, list_id = ? WHERE task_id = ?`, to, toListId, taskId);
      }
    });
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
    this.#sql.exec(`UPDATE tasks SET ${sets.join(", ")} WHERE task_id = ?`, ...params, taskId);
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
    const bind: SqlValue[] = [];
    const keys = ["committed_day", "committed_order", "order_datetime", "postponed_day"] as const;
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) {
        sets.push(`${k} = ?`);
        bind.push(patch[k] ?? null);
      }
    }
    if (sets.length === 0) return;
    bind.push(taskId);
    this.#sql.exec(`UPDATE tasks SET ${sets.join(", ")} WHERE task_id = ?`, ...bind);
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
    if (this.#isExcluded(listId)) return; // not mirrored; see upsertTask
    // Diff, not delete-and-reinsert: an unchanged step writes nothing, so the
    // change log isn't bumped on every scan (section 18.6).
    this.#deleteMissing("checklist_items", "item_id", taskId, items.map((i) => i.id));
    for (const item of items) {
      const row = checklistItemToRow(item, taskId, listId);
      this.#clocked("step", item.id, stepClock(item), () => this.#sql.exec(
        `INSERT INTO checklist_items (${CHECKLIST_COLUMNS.join(", ")})
           VALUES (${CHECKLIST_COLUMNS.map(() => "?").join(", ")})
         ON CONFLICT(item_id) DO UPDATE SET
           task_id=excluded.task_id, list_id=excluded.list_id, display_name=excluded.display_name,
           is_checked=excluded.is_checked, created_at=excluded.created_at, checked_at=excluded.checked_at`,
        ...CHECKLIST_COLUMNS.map((c) => row[c]),
      ));
    }
    this.#sql.exec(
      "UPDATE tasks SET checklist_synced_at = ?, has_checklist = ? WHERE task_id = ?",
      Date.now(),
      items.length > 0 ? 1 : 0,
      taskId,
    );
  }

  // Delete a task's rows in `table` whose key isn't in `keep`.
  #deleteMissing(table: string, key: string, taskId: string, keep: string[]): void {
    const have = this.#sql
      .exec<{ k: string }>(`SELECT ${key} k FROM ${table} WHERE task_id = ?`, taskId)
      .toArray()
      .map((r) => r.k);
    const keepSet = new Set(keep);
    for (const k of have) if (!keepSet.has(k)) this.#sql.exec(`DELETE FROM ${table} WHERE ${key} = ?`, k);
  }

  // Authoritative replace of a task's linked resources from a fresh Graph
  // fetch (the sub-resource scan), as a diff.
  replaceLinkedResources(taskId: string, listId: string, links: LinkedResource[]): void {
    if (this.#isExcluded(listId)) return; // not mirrored; see upsertTask
    this.#deleteMissing("linked_resources", "link_id", taskId, links.map((l) => l.id));
    for (const l of links) {
      this.#clocked("link", l.id, Date.now(), () => this.#sql.exec(
        `INSERT INTO linked_resources (link_id, task_id, list_id, web_url, display_name, application_name, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(link_id) DO UPDATE SET task_id=excluded.task_id, list_id=excluded.list_id,
           web_url=excluded.web_url, display_name=excluded.display_name,
           application_name=excluded.application_name, external_id=excluded.external_id`,
        l.id, taskId, listId, l.webUrl ?? null, l.displayName ?? null, l.applicationName ?? null, l.externalId ?? null,
      ));
    }
  }

  // Authoritative replace of a task's attachment metadata (no bytes), as a diff.
  replaceAttachments(taskId: string, listId: string, atts: Attachment[]): void {
    if (this.#isExcluded(listId)) return; // not mirrored; see upsertTask
    this.#deleteMissing("attachments", "attachment_id", taskId, atts.map((a) => a.id));
    for (const a of atts) {
      const modified = a.lastModifiedDateTime ? Date.parse(a.lastModifiedDateTime) : NaN;
      this.#sql.exec(
        `INSERT INTO attachments (attachment_id, task_id, list_id, name, size, content_type, kind, modified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attachment_id) DO UPDATE SET task_id=excluded.task_id, list_id=excluded.list_id,
           name=excluded.name, size=excluded.size, content_type=excluded.content_type,
           kind=excluded.kind, modified_at=excluded.modified_at`,
        a.id, taskId, listId, a.name ?? null, a.size ?? null, a.contentType ?? null,
        a["@odata.type"] === "#microsoft.graph.taskReferenceAttachment" ? "reference" : "file",
        Number.isNaN(modified) ? null : modified,
      );
    }
  }

  // One attachment this server just attached through Graph (an app upload,
  // section 5.6), recorded at once so the feed carries it before the next
  // sub-resource scan.
  putAttachment(taskId: string, listId: string, a: { id: string; name: string; size: number; content_type: string }): void {
    if (this.#isExcluded(listId)) return;
    this.#sql.exec(
      `INSERT INTO attachments (attachment_id, task_id, list_id, name, size, content_type, kind, modified_at)
         VALUES (?, ?, ?, ?, ?, ?, 'file', ?)
       ON CONFLICT(attachment_id) DO NOTHING`,
      a.id, taskId, listId, a.name, a.size, a.content_type, Date.now(),
    );
  }

  deleteAttachment(attachmentId: string): void {
    this.#sql.exec("DELETE FROM attachments WHERE attachment_id = ?", attachmentId);
  }

  // Mark a task's checklist stale so the next budgeted scan re-fetches it. The
  // incremental engine: the delta-apply path calls this whenever a task changes
  // (checklist edits bump the task's lastModifiedDateTime → ride $delta).
  //
  // checklist_synced_at: NULL = never fetched; > 0 = fetched then; < 0 = was
  // fetched at -value and is due again. A task fetched before keeps counting
  // as complete in the change feed while it waits: what changes on the re-fetch
  // logs the task itself (the step/link/attachment triggers), and the marker is
  // not a logged column, so a NULL here would leave clients holding
  // subresources_complete: false with no later row to correct it.
  markChecklistDirty(taskId: string): void {
    this.#sql.exec(
      "UPDATE tasks SET checklist_synced_at = -abs(checklist_synced_at) WHERE task_id = ? AND checklist_synced_at IS NOT NULL",
      taskId,
    );
  }

  // The task's cached steps no longer match Graph's (a copy-move re-keyed the
  // source's rows onto the copy, whose step IDs differ): report it as not
  // fetched until the scan replaces them.
  forgetSubresources(taskId: string): void {
    this.#sql.exec("UPDATE tasks SET checklist_synced_at = NULL WHERE task_id = ?", taskId);
  }

  // Drop a task's cached checklist rows (task deletion already cascades via
  // deleteTask; exposed for explicit clears).
  clearChecklistItems(taskId: string): void {
    this.#sql.exec("DELETE FROM checklist_items WHERE task_id = ?", taskId);
  }

  // Write-through for a single checklist mutation (create/update MCP tools):
  // upsert one item for instant cross-task visibility without a re-list. Bumps
  // has_checklist=1 but deliberately leaves checklist_synced_at UNTOUCHED — the
  // cached set may be incomplete (task not yet backfilled), so the marker still
  // governs whether a full fetch is owed. Latency optimization, not correctness:
  // the self-induced edit also rides delta → markChecklistDirty → authoritative
  // re-fetch next scan.
  upsertChecklistItem(taskId: string, listId: string, item: ChecklistItem): void {
    if (this.#isExcluded(listId)) return; // not mirrored; see upsertTask
    const row = checklistItemToRow(item, taskId, listId);
    this.#clocked("step", item.id, stepClock(item), () => this.#sql.exec(
      `INSERT INTO checklist_items (${CHECKLIST_COLUMNS.join(", ")})
         VALUES (${CHECKLIST_COLUMNS.map(() => "?").join(", ")})
       ON CONFLICT(item_id) DO UPDATE SET
         display_name=excluded.display_name, is_checked=excluded.is_checked,
         created_at=excluded.created_at, checked_at=excluded.checked_at`,
      ...CHECKLIST_COLUMNS.map((c) => row[c]),
    ));
    this.#sql.exec("UPDATE tasks SET has_checklist = 1 WHERE task_id = ?", taskId);
  }

  // Write-through for delete_checklist_item: drop one row. has_checklist is left
  // alone (can't tell if it was the last item without an authoritative set; the
  // next delta-driven re-fetch reconciles it). taskId is accepted for symmetry
  // and to scope the delete defensively.
  deleteChecklistItem(taskId: string, itemId: string): void {
    this.#sql.exec(
      "DELETE FROM checklist_items WHERE item_id = ? AND task_id = ?",
      itemId,
      taskId,
    );
  }

  // Write-throughs for the link ops, the linked-resource twins of the two
  // above: without them a link the sync API just created has a sid but no row,
  // so resolveSids reports it not live until the next sub-resource scan, and an
  // edit sent right after the create is refused as deleted.
  upsertLinkedResource(taskId: string, listId: string, link: LinkedResource): void {
    if (this.#isExcluded(listId)) return; // not mirrored; see upsertTask
    this.#clocked("link", link.id, Date.now(), () => this.#sql.exec(
      `INSERT INTO linked_resources (link_id, task_id, list_id, web_url, display_name, application_name, external_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(link_id) DO UPDATE SET web_url=excluded.web_url, display_name=excluded.display_name,
         application_name=excluded.application_name, external_id=excluded.external_id`,
      link.id, taskId, listId, link.webUrl ?? null, link.displayName ?? null, link.applicationName ?? null, link.externalId ?? null,
    ));
  }

  // A step's manual order after a reorder through this server (Substrate is
  // its only store), so the change is logged and pushed like the scan's.
  setStepOrder(taskId: string, itemId: string, order: string | null): void {
    this.#sql.exec(
      "UPDATE checklist_items SET order_datetime = ? WHERE item_id = ? AND task_id = ? AND order_datetime IS NOT ?",
      order, itemId, taskId, order,
    );
  }

  deleteLinkedResource(taskId: string, linkId: string): void {
    this.#sql.exec("DELETE FROM linked_resources WHERE link_id = ? AND task_id = ?", linkId, taskId);
  }

  // The task and list a mirrored step or link belongs to: the sync API names
  // a step or link by its own sid, while Graph addresses it under its task.
  findParentOf(kind: "step" | "link", graphId: string): { task_id: string; list_id: string } | null {
    const [table, key] = kind === "step" ? ["checklist_items", "item_id"] : ["linked_resources", "link_id"];
    return (
      this.#sql
        .exec<{ task_id: string; list_id: string }>(`SELECT task_id, list_id FROM ${table} WHERE ${key} = ?`, graphId)
        .toArray()[0] ?? null
    );
  }

  // A task's cached checklist rows, open items first then by creation order — the
  // "what am I waiting on" reading. Powers cross-task checklist enrichment.
  getChecklistItems(taskId: string): ChecklistItemRow[] {
    return this.#sql
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
  // Tasks whose steps, links and attachments still need fetching. Open tasks
  // come first, then completed ones (the server becomes the only copy after
  // Graph, so history is filled in too). Lists in openOnlyListIds (archive
  // lists) contribute open tasks only; skipListIds contribute nothing.
  selectDueChecklistTasks(
    max: number,
    skipListIds: string[],
    openOnlyListIds: string[] = [],
  ): Array<{ task_id: string; list_id: string }> {
    // One bound JSON array per list set (IN_JSON), not one parameter per list.
    const skipClause = skipListIds.length > 0 ? `AND list_id NOT IN ${IN_JSON}` : "";
    const openOnlyClause = openOnlyListIds.length > 0 ? `AND (status <> 'completed' OR list_id NOT IN ${IN_JSON})` : "";
    return this.#sql
      .exec(
        `SELECT task_id, list_id FROM tasks
          WHERE (checklist_synced_at IS NULL OR checklist_synced_at < 0)
            ${skipClause}
            ${openOnlyClause}
          ORDER BY (status = 'completed'), modified_at DESC
          LIMIT ?`,
        ...(skipListIds.length > 0 ? [JSON.stringify(skipListIds)] : []),
        ...(openOnlyListIds.length > 0 ? [JSON.stringify(openOnlyListIds)] : []),
        max,
      )
      .toArray() as unknown as Array<{ task_id: string; list_id: string }>;
  }

  findListForTask(
    taskId: string,
  ): { list_id: string; display_name: string | null } | null {
    const rows = this.#sql
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
    const rows = this.#sql
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
    const rows = this.#sql
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
    this.#clocked("list", r.list_id, Date.now(), () => this.#sql.exec(
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
    ));
    this.#sql.exec(
      `UPDATE lists SET baseline_gen = s.sweep_gen FROM sync_state s
        WHERE lists.list_id = ? AND s.resource = 'lists' AND s.sweep_gen IS NOT NULL`,
      r.list_id,
    );
  }

  deleteList(listId: string): void {
    // Drop the list and its tasks (FTS rows cascade via the AFTER DELETE
    // trigger as each task row is removed).
    this.#sql.exec("DELETE FROM tasks WHERE list_id = ?", listId);
    for (const table of ["checklist_items", "linked_resources", "attachments"]) {
      this.#sql.exec(`DELETE FROM ${table} WHERE list_id = ?`, listId);
    }
    this.#sql.exec("DELETE FROM lists WHERE list_id = ?", listId);
    this.#sql.exec("DELETE FROM sync_state WHERE resource = ?", `tasks:${listId}`);
    this.#sql.exec("DELETE FROM sync_state WHERE resource = ?", `myday:${listId}`);
  }

  // Copy each roster list's sync setting (section 1.2) onto its row, where the
  // change feed reads it. Writes only rows whose setting changed; the v11
  // trigger logs those lists again. Returns the lists that changed.
  //
  // A change is stamped on the list's `sync` field clock at the time it is
  // stored, whichever path made it (set_list_config, the app, a config edit
  // the sync cycle picked up), so a queued app edit older than it loses
  // (section 6). The first value recorded for a list is not a change and
  // stamps nothing.
  #storeListSync(rows: ListRow[], cfg: ListsConfig): Array<{ list_id: string; from: string | null; to: ListSync }> {
    const changed: Array<{ list_id: string; from: string | null; to: ListSync }> = [];
    const now = Date.now();
    for (const l of rows) {
      const to = listSync(l, cfg);
      const from = l.sync ?? null;
      if (from === to) continue;
      const write = () => this.#sql.exec("UPDATE lists SET sync = ? WHERE list_id = ?", to, l.list_id);
      if (from === null) write();
      else this.#clocked("list", l.list_id, now, write);
      changed.push({ list_id: l.list_id, from, to });
    }
    return changed;
  }

  // Apply a lists config now rather than at the next cycle: record every
  // list's setting, drop the mirrored rows of a list that became excluded (its
  // tasks leave the feed as deletion records), and sync the changed lists
  // first in a cycle that starts now, so a list switched back on is baselined
  // at once and its tasks come back under their old sids.
  //
  // The caller hands over the config it just wrote instead of this re-reading
  // KV: a KV read can serve the previous value for up to 60 s after a write.
  // For the same reason the config is kept here as pending, and #listsConfig()
  // prefers it to KV for LISTS_CONFIG_PENDING_MS, so the next sync cycle can't
  // read the old value and flip the setting back (purging or re-baselining a
  // list for nothing). Past that window KV has caught up and is read again.
  async refreshListSync(cfg: ListsConfig): Promise<{ changed: number }> {
    // Set in memory before any await, so a cycle that is reading KV right now
    // sees it when its read returns.
    const pending = { cfg, at: Date.now() };
    this.#pendingListsConfig = pending;
    await this.#state.put(PENDING_LISTS_CONFIG_KEY, pending);
    const changed = this.#transact(() => {
      const c = this.#storeListSync(this.listLists(), cfg);
      for (const x of c) if (x.to === "excluded") this.#purgeSkippedList(x.list_id);
      return c;
    });
    // Hot lists also make alarm() re-arm at once when this lands mid-cycle,
    // instead of being pushed back a whole interval by the cycle's own re-arm.
    for (const x of changed) this.#hotLists.add(x.list_id);
    if (changed.length > 0) await this.#alarms.setAlarm(Date.now() + 1);
    return { changed: changed.length };
  }

  // The one write path for config:lists (set_list_config, set_list_alias,
  // list_lists pinning, the app's list.update and list.create): read, apply
  // the change, write, apply the result here. Running it in the index
  // serializes the writers, and the base is the pending config when it is
  // newer than what KV may still serve, so one writer can't revert another's
  // change with a stale read.
  updateListsConfig(change: ListsConfigChange): Promise<ListsConfig> {
    const run = async () => {
      const base = await this.#listsConfig();
      const next = ListsConfigSchema.parse(applyListsConfigChange(base, change));
      await storeListsConfig(this.#env, next);
      await this.refreshListSync(next);
      return next;
    };
    const p = this.#configChain.then(run, run);
    this.#configChain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  // config:lists as this index should act on it: KV, unless a config handed
  // to refreshListSync is recent enough that KV may not show it yet.
  async #listsConfig(): Promise<ListsConfig> {
    const kv = await loadListsConfig(this.#env);
    if (this.#pendingListsConfig === undefined) {
      const stored = (await this.#state.get<{ cfg: ListsConfig; at: number }>(PENDING_LISTS_CONFIG_KEY)) ?? null;
      // refreshListSync may have run during the read; its value is newer.
      if (this.#pendingListsConfig === undefined) this.#pendingListsConfig = stored;
    }
    const p = this.#pendingListsConfig;
    return p && Date.now() - p.at < LISTS_CONFIG_PENDING_MS ? ListsConfigSchema.parse(p.cfg) : kv;
  }

  // The config the index acts on, for callers outside it (the MCP tools). A
  // KV read alone can lag a change made through updateListsConfig by up to a
  // minute (KV is eventually consistent), so a tool would show the old setting.
  listsConfig(): Promise<ListsConfig> {
    return this.#listsConfig();
  }

  // The list's stored setting is excluded. Read from the row each time, not
  // from a config captured earlier, since refreshListSync can change it while
  // a sync cycle is waiting on Graph.
  #isExcluded(listId: string): boolean {
    return this.#sql.exec("SELECT 1 FROM lists WHERE list_id = ? AND sync = 'excluded'", listId).toArray().length > 0;
  }

  // Excluded lists, which the feed never carries, so the app can offer to
  // switch one back on (section 1.2). `id` is the list's sid.
  excludedLists(): Array<{ id: string; name: string | null; wellknown: string | null }> {
    return this.#sql
      .exec<{ id: string; name: string | null; wellknown: string | null }>(
        `SELECT m.sid AS id, l.display_name AS name, l.wellknown
           FROM lists l JOIN entity_map m ON m.kind = 'list' AND m.graph_id = l.list_id
          WHERE l.sync = 'excluded'
          ORDER BY l.display_name`,
      )
      .toArray();
  }

  // Roster reads — the `lists` table is the authoritative roster.
  listLists(): ListRow[] {
    return this.#sql
      .exec("SELECT * FROM lists ORDER BY display_name")
      .toArray() as unknown as ListRow[];
  }

  getList(listId: string): ListRow | null {
    const rows = this.#sql
      .exec("SELECT * FROM lists WHERE list_id = ?", listId)
      .toArray() as unknown as ListRow[];
    return rows.length > 0 ? rows[0] : null;
  }

  // -- Subscription store (ROADMAP §4) --------------------------------------
  getSubscriptions(): SubscriptionRow[] {
    return this.#sql
      .exec("SELECT * FROM subscriptions")
      .toArray() as unknown as SubscriptionRow[];
  }

  findSubscription(subscriptionId: string): SubscriptionRow | null {
    const rows = this.#sql
      .exec("SELECT * FROM subscriptions WHERE subscription_id = ?", subscriptionId)
      .toArray() as unknown as SubscriptionRow[];
    return rows.length > 0 ? rows[0] : null;
  }

  putSubscription(rec: SubscriptionRow): void {
    this.#sql.exec(
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
    this.#sql.exec("DELETE FROM subscriptions WHERE subscription_id = ?", subscriptionId);
  }

  // -- Subscription reconciliation (ROADMAP §4) -----------------------------
  // Bring Graph's subscriptions in line with the live, non-skipped roster, one
  // bounded batch per cycle (free-tier safety). Tolerates per-op Graph failures
  // (logged, retried next cycle). `opts` overrides are for tests only.
  async reconcileSubscriptions(opts: { enabled?: boolean; now?: number } = {}): Promise<void> {
    const enabled = opts.enabled ?? taskSubscriptionsEnabled(this.#env);
    const now = opts.now ?? Date.now();
    const url = webhookUrl(this.#env);

    const records = this.getSubscriptions();

    // Gate OFF (or no reachable webhook URL): tear our subscriptions down,
    // budgeted, and create none.
    if (!enabled || !url) {
      const graph = new GraphClient(this);
      let budget = maxSubscriptionOpsPerCycle(this.#env);
      for (const rec of records) {
        if (budget <= 0) break;
        budget -= 1;
        await this.#tearDownSubscription(graph, rec.subscription_id);
      }
      return;
    }

    // Which lists SHOULD have a subscription: todo lists. Reference lists sync
    // on the timer only, and excluded lists aren't mirrored (section 1.2).
    const cfg = await this.#listsConfig();
    const rosterRows = this.listLists();
    const wanted = new Set(rosterRows.filter((l) => listSync(l, cfg) === "todo").map((l) => l.list_id));

    const graph = new GraphClient(this);
    let budget = maxSubscriptionOpsPerCycle(this.#env);

    // 0. Cross-check our local records against Graph's actual subscription
    //    roster. Graph can expire or evict a subscription out from under us
    //    (early kill, tenant quota, admin action), and todoTask has no
    //    lifecycle/missed-notification signal — so a local record can look
    //    healthy (future expiry) while the Graph subscription is already gone,
    //    silently degrading that list to delta-only. Presence of a *local
    //    record* was the old proxy for "subscribed"; this makes Graph the
    //    source of truth. Best-effort: on a failed fetch we skip the
    //    cross-check and keep the record-only behaviour (never drop a record we
    //    couldn't disprove).
    try {
      const { aliveIds, orphans } = this.#diffGraphSubscriptions(
        await listGraphSubscriptions(graph),
        url,
        wanted,
      );
      // Dead records: a local record whose Graph subscription no longer exists.
      // Drop it (local-only, no budget) so the create pass below recreates a
      // fresh, validatable subscription this same cycle.
      for (const rec of records) {
        if (!aliveIds.has(rec.subscription_id)) {
          this.deleteSubscriptionRecord(rec.subscription_id);
          log.info("subscription_record_dead", {
            list_id: rec.list_id,
            subscription_id: rec.subscription_id,
          });
        }
      }
      // Orphan Graph subs: ours (by notificationUrl) but unwanted or untracked.
      // Tear them down to reclaim tenant quota. We can't adopt them — Graph's
      // GET omits clientState, so their notifications wouldn't be validatable.
      for (const { sub } of orphans) {
        if (budget <= 0) return;
        budget -= 1;
        await this.#tearDownSubscription(graph, sub.id);
      }
    } catch (e) {
      log.warn("subscription_graph_list_failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Re-read after possible record drops so the maps below reflect reality.
    const recordsNow = this.getSubscriptions();
    const haveByList = new Map(recordsNow.map((r) => [r.list_id, r]));

    // 1. Delete records whose list is gone or now skipped. (When the Graph
    //    cross-check ran, most of these are already handled as orphans; this
    //    remains the fallback when Graph was unreachable.)
    for (const rec of recordsNow) {
      if (budget <= 0) return;
      if (!wanted.has(rec.list_id)) {
        budget -= 1;
        await this.#tearDownSubscription(graph, rec.subscription_id);
      }
    }

    // 2. Create for wanted lists with no record — covers brand-new lists and
    //    the dead records dropped above. The per-cycle cap rotates coverage
    //    over a few cycles for a large roster.
    for (const listId of wanted) {
      if (budget <= 0) return;
      if (haveByList.has(listId)) continue;
      budget -= 1;
      await this.#createSubscriptionFor(graph, listId, url, now);
    }
  }

  // Partition Graph's subscription roster relative to ours, the single source of
  // truth shared by reconcile and subscriptionStatus. "Ours" = subscribed to
  // this Worker's webhook URL. Returns:
  //   aliveIds    — live Graph subscription ids on our URL (caller spots dead
  //                 local records as records whose id isn't here).
  //   aliveByList — the lists those live subs cover (caller spots `dark` lists).
  //   orphans     — ours but untracked, or tracked on a list we no longer want;
  //                 torn down to reclaim quota (we can't adopt an untracked sub:
  //                 Graph's GET omits clientState, so its notifications wouldn't
  //                 validate). Carries the resolved listId for reporting.
  // For a tracked sub we trust the local record's list_id over re-parsing the
  // resource string, so a malformed resource can never misclassify (and later
  // tear down) a subscription we know is healthy.
  #diffGraphSubscriptions(
    graphSubs: GraphSubscription[],
    url: string,
    wanted: Set<string>,
  ): {
    aliveIds: Set<string>;
    aliveByList: Set<string>;
    orphans: Array<{ sub: GraphSubscription; listId: string | null }>;
  } {
    const trackedListById = new Map(
      this.getSubscriptions().map((r) => [r.subscription_id, r.list_id]),
    );
    const aliveIds = new Set<string>();
    const aliveByList = new Set<string>();
    const orphans: Array<{ sub: GraphSubscription; listId: string | null }> = [];
    // Normalized "ours" compare: if Graph ever echoed the notificationUrl with
    // different casing or a trailing slash, a strict !== would read every sub as
    // not-ours and (with cleared/dead records) churn the whole fleet. Compare
    // case- and trailing-slash-insensitively.
    const norm = (u: string | undefined) => (u ?? "").trim().replace(/\/+$/, "").toLowerCase();
    const ourUrl = norm(url);
    for (const sub of graphSubs) {
      if (norm(sub.notificationUrl) !== ourUrl) continue; // not ours
      aliveIds.add(sub.id);
      const tracked = trackedListById.get(sub.id);
      const listId = tracked ?? parseTodoListId(sub.resource);
      if (listId) aliveByList.add(listId);
      if (tracked === undefined || !listId || !wanted.has(listId)) {
        orphans.push({ sub, listId });
      }
    }
    return { aliveIds, aliveByList, orphans };
  }

  // Read-only introspection for the subscription layer: the env-derived
  // effective config plus a three-way diff between what SHOULD be subscribed
  // (non-skipped roster), what we hold LOCAL records for, and what Graph
  // ACTUALLY holds — the same comparison reconcile acts on. Surfaces silent
  // drift (`dead`), uncovered lists (`dark`), and quota-leaking `orphan`s.
  // Never writes. When Graph is unreachable, `graph_error` is set and `dark`
  // falls back to "wanted with no local record".
  async subscriptionStatus(opts: { includeRaw?: boolean } = {}): Promise<SubscriptionStatus> {
    const enabled = taskSubscriptionsEnabled(this.#env);
    const url = webhookUrl(this.#env);
    const cfg = await this.#listsConfig();
    const wanted = new Set(this.listLists().filter((l) => listSync(l, cfg) === "todo").map((l) => l.list_id));
    const records = this.getSubscriptions();
    const recByList = new Set(records.map((r) => r.list_id));

    const config: SubscriptionConfig = {
      subscriptions_enabled: enabled,
      // null ⇒ SERVICE_BASE_URL missing or non-https ⇒ no subscriptions created.
      webhook_url: url,
      service_base_url: (this.#env.SERVICE_BASE_URL ?? null) || null,
      my_day_enabled: myDayEnabled(this.#env),
      subscription_lifetime_min: Math.round(SUBSCRIPTION_LIFETIME_MS / 60_000),
      subscription_renew_margin_min: Math.round(SUBSCRIPTION_RENEW_MARGIN_MS / 60_000),
      max_subscription_ops_per_cycle: maxSubscriptionOpsPerCycle(this.#env),
      delta_sync_interval_min: this.#intervalMs() / 60_000,
      my_day_scan_every_n_cycles: this.#myDayScanEveryNCycles(),
      my_day_scan_window_min: this.#myDayScanWindowMs() / 60_000,
    };

    // Graph truth (best-effort), via the same partition reconcile acts on so the
    // report can't drift from the reconciler's behaviour. Without it we can
    // still report wanted/local, but can't classify dead/orphan — flag that with
    // graph_error.
    let aliveIds: Set<string> | null = null;
    let darkFromGraph: string[] | null = null;
    const orphan: Array<{ subscription_id: string; list_id: string | null; resource?: string }> = [];
    // Delivery prerequisite: which of OUR live Graph subs carry a
    // lifecycleNotificationUrl (the field that keeps Exchange-backed todoTask
    // subscriptions from going dormant). A sub created before that field was
    // added shows lifecycle:false until recreated; lists_with names the lists
    // already on a lifecycle-enabled sub.
    let lifecycle: { with: number; without: number; lists_with: string[] } | undefined;
    // Raw Graph subscription objects for OUR subs (clientState omitted — it's our
    // secret). Diagnostic: surfaces applicationId / creatorId / changeType /
    // expiration so an anomalous sub (wrong owning app, etc.) is visible.
    const graph_raw: Array<{
      subscription_id: string;
      resource?: string;
      notification_url?: string;
      lifecycle_url: string | null;
      change_type: string | null;
      application_id: string | null;
      creator_id: string | null;
      content_type: string | null;
      expiration?: string;
    }> = [];
    let graph_error: string | undefined;
    try {
      const graph = new GraphClient(this);
      const graphSubs = await listGraphSubscriptions(graph);
      // Opt-in raw dump — skip the whole pass unless requested.
      if (opts.includeRaw) {
        const ourUrlNorm = (url ?? "").trim().replace(/\/+$/, "").toLowerCase();
        for (const sub of graphSubs) {
          if ((sub.notificationUrl ?? "").trim().replace(/\/+$/, "").toLowerCase() !== ourUrlNorm)
            continue;
          graph_raw.push({
            subscription_id: sub.id,
            resource: sub.resource,
            notification_url: sub.notificationUrl,
            lifecycle_url: sub.lifecycleNotificationUrl ?? null,
            change_type: sub.changeType ?? null,
            application_id: sub.applicationId ?? null,
            creator_id: sub.creatorId ?? null,
            content_type: sub.notificationContentType ?? null,
            expiration: sub.expirationDateTime,
          });
        }
      }
      const { aliveIds: alive, aliveByList, orphans } = this.#diffGraphSubscriptions(
        graphSubs,
        url ?? "",
        wanted,
      );
      for (const o of orphans) {
        orphan.push({ subscription_id: o.sub.id, list_id: o.listId, resource: o.sub.resource });
      }
      aliveIds = alive;
      darkFromGraph = [...wanted].filter((l) => !aliveByList.has(l));
      const trackedListById = new Map(records.map((r) => [r.subscription_id, r.list_id]));
      let withL = 0;
      let withoutL = 0;
      const lists_with: string[] = [];
      for (const sub of graphSubs) {
        if (!alive.has(sub.id)) continue; // ours only
        if (sub.lifecycleNotificationUrl) {
          withL += 1;
          const listId = trackedListById.get(sub.id) ?? parseTodoListId(sub.resource);
          if (listId) lists_with.push(listId);
        } else {
          withoutL += 1;
        }
      }
      lifecycle = { with: withL, without: withoutL, lists_with };
    } catch (e) {
      graph_error = e instanceof Error ? e.message : String(e);
    }

    const dead =
      aliveIds === null
        ? []
        : records
            .filter((r) => !aliveIds!.has(r.subscription_id))
            .map((r) => ({
              list_id: r.list_id,
              subscription_id: r.subscription_id,
              expiration_ms: r.expiration_ms,
            }));
    const dark = darkFromGraph ?? [...wanted].filter((l) => !recByList.has(l));

    return {
      ok: true,
      config,
      summary: {
        wanted: wanted.size,
        local_records: records.length,
        graph_subs_ours: aliveIds === null ? -1 : aliveIds.size,
        dark: dark.length,
        dead: dead.length,
        orphan: orphan.length,
      },
      dark,
      dead,
      orphan,
      lifecycle,
      graph_raw: opts.includeRaw ? graph_raw : undefined,
      graph_error,
    };
  }

  // Renew records nearing expiry, budgeted. Called from the cycle alongside
  // reconcile.
  async renewSubscriptions(opts: { now?: number } = {}): Promise<void> {
    if (!taskSubscriptionsEnabled(this.#env)) return;
    const now = opts.now ?? Date.now();
    const graph = new GraphClient(this);
    let budget = maxSubscriptionOpsPerCycle(this.#env);
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
        // Same /webhook endpoint; the handler routes by payload shape. Carrying
        // a lifecycleNotificationUrl is what keeps an Exchange-backed todoTask
        // subscription delivering — reauthorization challenges land here.
        lifecycleNotificationUrl: notificationUrl,
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
  // Served from the index once a baseline has completed. A list that is being
  // re-baselined (mark and sweep, section 3.3) keeps serving its rows: it has
  // completed a baseline before (last_synced_at) and nothing was dropped.
  isListSynced(listId: string): boolean {
    const resource = `tasks:${listId}`;
    const st = this.#getSyncState(resource);
    if (st?.delta_link) return true;
    if (st?.last_synced_at == null) return false;
    return (
      this.#sql
        .exec<{ g: number | null }>("SELECT sweep_gen g FROM sync_state WHERE resource = ?", resource)
        .toArray()[0]?.g != null
    );
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
      where.push(`list_id IN ${IN_JSON}`);
      params.push(JSON.stringify(f.lists));
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
    // Cast: SqlDb rows are Record<string, SqlValue>; our
    // columns are exactly TaskRow's string|number|null fields.
    const rows = this.#sql.exec(sql, ...params, limit).toArray() as unknown as TaskRow[];

    // A full page implies there may be more — hand back a resume cursor.
    let next_cursor: string | undefined;
    if (rows.length === limit && rows.length > 0) {
      const last = rows[rows.length - 1];
      next_cursor = encodeCursor({ modified_at: last.modified_at, task_id: last.task_id });
    }
    return { rows, next_cursor };
  }

  // FTS task search. `include_checklist` widens recall to tasks whose CHECKLIST
  // items match (text lives in a separate FTS table). BM25 `rank` is computed per
  // FTS corpus, so scores across the two tables aren't comparable — rather than
  // fake a merged ranking, results are TIERED: title/body matches first in their
  // exact relevance order, then checklist-only matches appended (ranked among
  // themselves), deduped by task_id. A task matching both stays in the title/body
  // tier. No-op-safe when the checklist cache is empty (the checklist tier adds
  // nothing). The list/status filters apply to both tiers.
  search(opts: {
    query: string;
    lists?: string[];
    status?: string[];
    limit?: number;
    include_checklist?: boolean;
  }): { rows: TaskRow[] } {
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    // Shared task-level filters (lists/status) used by both tiers.
    const tFilters: string[] = [];
    const tParams: (string | number)[] = [];
    if (opts.lists && opts.lists.length > 0) {
      tFilters.push(`t.list_id IN ${IN_JSON}`);
      tParams.push(JSON.stringify(opts.lists));
    }
    if (opts.status && opts.status.length > 0) {
      tFilters.push(`t.status IN (${opts.status.map(() => "?").join(", ")})`);
      tParams.push(...opts.status);
    }
    const tWhere = tFilters.length ? ` AND ${tFilters.join(" AND ")}` : "";

    // Tier 0 — title/body matches, in BM25 relevance order.
    const titleRows = this.#sql
      .exec(
        `SELECT t.* FROM tasks_fts f JOIN tasks t ON t.rowid = f.rowid
          WHERE tasks_fts MATCH ?${tWhere} ORDER BY rank LIMIT ?`,
        opts.query,
        ...tParams,
        limit,
      )
      .toArray() as unknown as TaskRow[];

    if (!opts.include_checklist) return { rows: titleRows };

    // Tier 1 — tasks matching via checklist text, appended (deduped by task_id;
    // one matched item may repeat a task, and a task may already be in tier 0).
    const clRows = this.#sql
      .exec(
        `SELECT t.* FROM checklist_fts cf
           JOIN checklist_items ci ON ci.rowid = cf.rowid
           JOIN tasks t ON t.task_id = ci.task_id
          WHERE checklist_fts MATCH ?${tWhere} ORDER BY rank LIMIT ?`,
        opts.query,
        ...tParams,
        limit,
      )
      .toArray() as unknown as TaskRow[];

    const seen = new Set(titleRows.map((r) => r.task_id));
    const merged = [...titleRows];
    for (const r of clRows) {
      if (seen.has(r.task_id)) continue;
      seen.add(r.task_id);
      merged.push(r);
    }
    return { rows: merged.slice(0, limit) };
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
      where.push(`ci.list_id IN ${IN_JSON}`);
      params.push(JSON.stringify(opts.lists));
    }

    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const order = hasQuery ? "rank" : "ci.created_at ASC NULLS LAST, ci.item_id ASC";
    const sql = `SELECT ci.*, t.title AS task_title, t.status AS task_status
                   FROM ${from}
                  ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                  ORDER BY ${order} LIMIT ?`;
    const rows = this.#sql.exec(sql, ...params, limit).toArray() as unknown as ChecklistSearchRow[];
    return { rows };
  }

  // Read path for list_my_day_tasks. Single DO query, zero Substrate round
  // trips. Filter = committed_day equals the target day AND not postponed to
  // that same day (faithful to the official client's My Day projection).
  // Sort = committed_order DESC (nulls last), then order_datetime DESC (nulls
  // last) for tasks not yet assigned a My Day order, then task_id DESC for a
  // stable tie-break. Backed by the tasks_committed_day index.
  queryMyDayForDate(day: string): { rows: TaskRow[] } {
    const rows = this.#sql
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
    const rows = this.#sql
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
  // ---- Client sync API, read side (docs/SYNC-API.md sections 4 and 14.1) ----

  // The current position of the change log, for a push client's hello.
  syncCursor(): string {
    return currentCursor(this.#sql);
  }

  // Tells push clients the log moved, at most once per new seq. The hosts call
  // it after every RPC (announcing() below); the sync cycle also calls it after
  // each resource, so a webhook-driven edit doesn't wait for the whole walk.
  announceChanges(): void {
    if (!this.#notifier) return;
    const cursor = currentCursor(this.#sql);
    const seq = Number(cursor.slice(cursor.indexOf(".") + 1));
    if (seq === this.#announcedSeq) return;
    // The first check after a start only records where the log is: a client
    // connecting gets the cursor in its hello, so nothing was missed.
    const first = this.#announcedSeq < 0;
    this.#announcedSeq = seq;
    if (!first) this.#notifier.announce(cursor);
  }

  // One page of the change feed. See change-feed.ts for the cursor rules.
  syncChanges(opts: { cursor?: string | null; limit?: number; scope?: string }): FeedResult {
    return changesSince(this.#sql, { ...opts, timeZone: this.#env.TIMEZONE });
  }

  // One task by sid, with its steps, links and attachment details.
  syncTask(sid: string): ReturnType<typeof taskBySid> {
    return taskBySid(this.#sql, sid, this.#env.TIMEZONE);
  }

  // One attachment by sid: the Graph IDs needed to fetch its bytes, plus the
  // metadata the download's headers come from. Null when the sid is unknown,
  // the attachment is no longer in the mirror, or its list is excluded (an
  // excluded list isn't mirrored, so its attachments are not served, the same
  // as GET /tasks/{sid}).
  syncAttachment(sid: string): {
    list_id: string;
    task_id: string;
    attachment_id: string;
    name: string | null;
    content_type: string | null;
    kind: string | null;
  } | null {
    const row = this.#sql
      .exec<{ list_id: string; task_id: string; attachment_id: string; name: string | null; content_type: string | null; kind: string | null }>(
        // The task's list, not attachments.list_id: that one is stale after a
        // move until the sub-resource scan reaches the task again.
        `SELECT COALESCE(t.list_id, a.list_id) AS list_id, a.task_id, a.attachment_id, a.name, a.content_type, a.kind
           FROM entity_map m JOIN attachments a ON a.attachment_id = m.graph_id
           LEFT JOIN tasks t ON t.task_id = a.task_id
          WHERE m.kind = 'attachment' AND m.sid = ?`,
        sid,
      )
      .toArray()[0];
    if (!row || this.#isExcluded(row.list_id)) return null;
    return row;
  }

  // ── App-owned appearance (docs/SYNC-API.md section 4.8) ──────────────────

  themeImage(id: string): (FeedThemeImage & { id: string }) | null {
    const row = this.#sql.exec("SELECT * FROM theme_images WHERE image_id = ?", id).toArray()[0];
    return row ? { id, ...themeImageData(row) } : null;
  }

  // Records an uploaded image whose bytes are already in the blob store. The
  // same bytes uploaded again keep the stored row, dimensions included.
  putThemeImage(img: { image_id: string; content_type: string; size: number; width: number; height: number; brightness: number | null }): {
    created: boolean;
    image: FeedThemeImage & { id: string };
  } {
    const existing = this.themeImage(img.image_id);
    if (existing) return { created: false, image: existing };
    this.#sql.exec(
      `INSERT INTO theme_images (image_id, content_type, size, width, height, brightness, created_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      img.image_id, img.content_type, img.size, img.width, img.height, img.brightness, Date.now(),
    );
    return { created: true, image: this.themeImage(img.image_id)! };
  }

  #themeImageInUse(id: string): boolean {
    if (this.#sql.exec("SELECT 1 FROM list_images WHERE image_id = ? LIMIT 1", id).toArray().length) return true;
    const settings = appSettingsData(this.#sql).smart_lists;
    return Object.values(settings).some((t) => t?.image_id === id);
  }

  // The row only; the caller deletes the bytes. A failed byte delete leaves
  // an object the sweep removes, since the table no longer has it.
  deleteThemeImage(id: string): "deleted" | "in_use" | "not_found" {
    return this.#transact(() => {
      if (!this.#sql.exec("SELECT 1 FROM theme_images WHERE image_id = ?", id).toArray().length) return "not_found";
      if (this.#themeImageInUse(id)) return "in_use";
      this.#sql.exec("DELETE FROM theme_images WHERE image_id = ?", id);
      return "deleted";
    });
  }

  // Sets a list's image and/or its style; a field left undefined keeps its
  // value, null clears it. A list with neither has no row.
  setListImage(
    listId: string,
    patch: { image_id?: string | null; image_style?: ImageStyle | null },
  ): "ok" | "unknown_list" | "unknown_theme_image" {
    return this.#transact(() => {
      if (!this.#sql.exec("SELECT 1 FROM lists WHERE list_id = ?", listId).toArray().length) return "unknown_list";
      const imageId = patch.image_id;
      if (imageId && !this.#sql.exec("SELECT 1 FROM theme_images WHERE image_id = ?", imageId).toArray().length) {
        return "unknown_theme_image";
      }
      const cur = this.#sql
        .exec<{ image_id: string | null; style_json: string | null }>("SELECT image_id, style_json FROM list_images WHERE list_id = ?", listId)
        .toArray()[0];
      const nextImage = imageId === undefined ? (cur?.image_id ?? null) : imageId;
      const nextStyle =
        patch.image_style === undefined ? (cur?.style_json ?? null) : patch.image_style === null ? null : JSON.stringify(patch.image_style);
      if (nextImage === null && nextStyle === null) {
        this.#sql.exec("DELETE FROM list_images WHERE list_id = ?", listId);
        return "ok";
      }
      this.#sql.exec(
        `INSERT INTO list_images (list_id, image_id, style_json) VALUES (?, ?, ?)
         ON CONFLICT(list_id) DO UPDATE SET image_id = excluded.image_id, style_json = excluded.style_json`,
        listId, nextImage, nextStyle,
      );
      if (imageId) this.#sql.exec("UPDATE theme_images SET unreferenced_since = NULL WHERE image_id = ?", imageId);
      return "ok";
    });
  }

  // Replaces the themes of the smart lists named; null returns one to the
  // app's default. All or nothing: one unknown image refuses the whole call.
  setSmartListThemes(values: Partial<Record<SmartList, SmartListTheme | null>>): "ok" | "unknown_theme_image" {
    return this.#transact(() => {
      const images = Object.values(values).flatMap((v) => (v?.image_id ? [v.image_id] : []));
      for (const id of images) {
        if (!this.#sql.exec("SELECT 1 FROM theme_images WHERE image_id = ?", id).toArray().length) return "unknown_theme_image";
      }
      for (const [key, v] of Object.entries(values)) {
        if (v === null || v === undefined) this.#sql.exec("DELETE FROM app_settings WHERE key = ?", key);
        else {
          this.#sql.exec(
            "INSERT INTO app_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            key, JSON.stringify({ color: v.color, image_id: v.image_id, image_style: v.image_style }),
          );
        }
      }
      for (const id of images) this.#sql.exec("UPDATE theme_images SET unreferenced_since = NULL WHERE image_id = ?", id);
      return "ok";
    });
  }

  // The blob sweep's index half (section 4.9). Marks each unused image with
  // when the sweep first saw it unused, clears the mark on used ones, and
  // deletes the rows of images unused for `idleMs`. Returns the deleted ids,
  // whose bytes the caller removes.
  sweepThemeImages(nowMs: number, idleMs: number): string[] {
    return this.#transact(() => {
      const used = new Set(
        this.#sql
          .exec<{ image_id: string }>("SELECT DISTINCT image_id FROM list_images WHERE image_id IS NOT NULL")
          .toArray()
          .map((r) => r.image_id),
      );
      for (const t of Object.values(appSettingsData(this.#sql).smart_lists)) if (t?.image_id) used.add(t.image_id);
      const rows = this.#sql
        .exec<{ image_id: string; unreferenced_since: number | null }>(
          "SELECT image_id, unreferenced_since FROM theme_images",
        )
        .toArray();
      const expired: string[] = [];
      for (const r of rows) {
        if (used.has(r.image_id)) {
          if (r.unreferenced_since !== null) this.#sql.exec("UPDATE theme_images SET unreferenced_since = NULL WHERE image_id = ?", r.image_id);
          continue;
        }
        // The idle time runs from the first sweep that saw it unused.
        if (r.unreferenced_since === null) {
          this.#sql.exec("UPDATE theme_images SET unreferenced_since = ? WHERE image_id = ?", nowMs, r.image_id);
        } else if (nowMs - r.unreferenced_since >= idleMs) expired.push(r.image_id);
      }
      for (const id of expired) this.#sql.exec("DELETE FROM theme_images WHERE image_id = ?", id);
      return expired;
    });
  }

  // Of the given theme image ids and attachment sids (from a blob store
  // listing), those the mirror still has. The sweep deletes the rest.
  liveBlobIds(themeImageIds: string[], attachmentSids: string[]): { theme_images: string[]; attachments: string[] } {
    const images = themeImageIds.filter(
      (id) => this.#sql.exec("SELECT 1 FROM theme_images WHERE image_id = ?", id).toArray().length > 0,
    );
    const atts = attachmentSids.filter(
      (sid) =>
        this.#sql
          .exec(
            `SELECT 1 FROM entity_map m JOIN attachments a ON a.attachment_id = m.graph_id
              WHERE m.kind = 'attachment' AND m.sid = ?`,
            sid,
          )
          .toArray().length > 0,
    );
    return { theme_images: images, attachments: atts };
  }

  // FTS search answered with feed-shaped tasks, in one call (one RPC on
  // Cloudflare instead of one per hit).
  syncSearch(query: string, limit: number): NonNullable<ReturnType<typeof taskBySid>>[] {
    const { rows } = this.search({ query, limit, include_checklist: true });
    const ids = rows.slice(0, limit).map((r) => r.task_id);
    const sids = taskSids(this.#sql, ids);
    return ids.flatMap((id) => {
      const t = sids[id] ? taskBySid(this.#sql, sids[id], this.#env.TIMEZONE) : null;
      return t ? [t] : [];
    });
  }

  // Graph task IDs → sids (search results are served by sid).
  syncTaskSids(taskIds: string[]): Record<string, string> {
    return taskSids(this.#sql, taskIds);
  }

  // ---- Client sync API, write side (docs/SYNC-API.md sections 5 and 6) ----
  // The idempotency record and field clocks; src/core/sync/mutations.ts runs
  // the batch and calls these. Each is one synchronous SQLite step.

  // Claims a mutation id. `done` returns the stored result (a retry); a live
  // `pending` row means another request is running it now; an expired one is
  // taken over.
  mutationBegin(
    id: string,
    principal: string,
    nowMs: number,
    leaseMs: number,
  ): { state: "new"; prior_at_ms?: number } | { state: "done"; result: unknown } | { state: "leased" } {
    return this.#transact(() => {
      const row = this.#sql
        .exec<{ state: string; result_json: string | null; lease_until: number | null; at_ms: number }>(
          "SELECT state, result_json, lease_until, at_ms FROM applied_mutations WHERE mutation_id = ?",
          id,
        )
        .toArray()[0];
      if (row?.state === "done") return { state: "done" as const, result: JSON.parse(row.result_json ?? "null") };
      if (row && (row.lease_until ?? 0) > nowMs) return { state: "leased" as const };
      // A pending row whose lease is free is an earlier attempt that may have
      // written (released as ambiguous, or crashed): keep its first at_ms and
      // hand it to the caller.
      this.#sql.exec(
        `INSERT INTO applied_mutations (mutation_id, state, principal, lease_until, at_ms) VALUES (?, 'pending', ?, ?, ?)
         ON CONFLICT(mutation_id) DO UPDATE SET state = 'pending', principal = excluded.principal,
           lease_until = excluded.lease_until`,
        id,
        principal,
        nowMs + leaseMs,
        nowMs,
      );
      return row ? { state: "new" as const, prior_at_ms: row.at_ms } : { state: "new" as const };
    });
  }

  // Records the outcome and the clocks of the fields it set, together.
  mutationFinish(
    id: string,
    result: unknown,
    clocks: Array<{ kind: string; sid: string; field: string; at_ms: number }>,
  ): void {
    this.#transact(() => {
      this.#sql.exec(
        "UPDATE applied_mutations SET state = 'done', result_json = ?, lease_until = NULL WHERE mutation_id = ?",
        JSON.stringify(result),
        id,
      );
      for (const c of clocks) {
        this.#sql.exec(
          `INSERT INTO field_clock (kind, sid, field, at_ms) VALUES (?, ?, ?, ?)
           ON CONFLICT(kind, sid, field) DO UPDATE SET at_ms = excluded.at_ms`,
          c.kind,
          c.sid,
          c.field,
          c.at_ms,
        );
      }
    });
  }

  // A mutation whose write may have reached Graph: keep the row, free the
  // lease, so the retry runs at once and knows to look before writing.
  mutationRelease(id: string): void {
    this.#sql.exec("UPDATE applied_mutations SET lease_until = 0 WHERE mutation_id = ? AND state = 'pending'", id);
  }

  // A mutation that failed and may be retried: forget it.
  mutationAbandon(id: string): void {
    this.#sql.exec("DELETE FROM applied_mutations WHERE mutation_id = ? AND state = 'pending'", id);
  }

  fieldClocks(kind: string, sid: string): Record<string, number> {
    const rows = this.#sql
      .exec<{ field: string; at_ms: number }>("SELECT field, at_ms FROM field_clock WHERE kind = ? AND sid = ?", kind, sid)
      .toArray();
    return Object.fromEntries(rows.map((r) => [r.field, r.at_ms]));
  }

  // sid → Graph ID, and whether that entity exists in the mirror now.
  // `excluded`: the entity is an excluded list, or belongs to one (section
  // 1.2), so the sync API refuses to write to it. A task whose row is gone is
  // placed by the list its last change-log row names, since an excluded
  // list's tasks are deleted from the mirror.
  resolveSids(
    refs: Array<{ kind: string; sid: string }>,
  ): Record<string, { graph_id: string | null; live: boolean; excluded?: true }> {
    const table: Record<string, [string, string]> = {
      list: ["lists", "list_id"],
      task: ["tasks", "task_id"],
      step: ["checklist_items", "item_id"],
      link: ["linked_resources", "link_id"],
      attachment: ["attachments", "attachment_id"],
      // A sidebar group: list.update's group_id and list.reorder's reference.
      list_group: ["list_groups", "group_id"],
      // App-owned (section 4.8): an image's sid is its id.
      theme_image: ["theme_images", "image_id"],
    };
    const out: Record<string, { graph_id: string | null; live: boolean; excluded?: true }> = {};
    for (const r of refs) {
      // The app_settings entity always exists once its sid is minted; it has
      // no row of its own until a smart list is themed.
      if (r.kind === "app_settings") {
        const m = this.#sql
          .exec<{ graph_id: string | null }>("SELECT graph_id FROM entity_map WHERE kind = 'app_settings' AND sid = ?", r.sid)
          .toArray()[0];
        out[`${r.kind}:${r.sid}`] = { graph_id: m?.graph_id ?? null, live: !!m };
        continue;
      }
      const t = table[r.kind];
      if (!t) continue;
      const m = this.#sql
        .exec<{ graph_id: string | null }>("SELECT graph_id FROM entity_map WHERE kind = ? AND sid = ?", r.kind, r.sid)
        .toArray()[0];
      const graphId = m?.graph_id ?? null;
      const live =
        !!graphId && this.#sql.exec(`SELECT 1 FROM ${t[0]} WHERE ${t[1]} = ? LIMIT 1`, graphId).toArray().length > 0;
      let listId: string | null = null;
      if (graphId && r.kind === "list") listId = graphId;
      // Groups and theme images belong to no list.
      else if (r.kind === "list_group" || r.kind === "theme_image") listId = null;
      else if (graphId && live) {
        listId = this.#sql.exec<{ l: string }>(`SELECT list_id l FROM ${t[0]} WHERE ${t[1]} = ?`, graphId).toArray()[0]?.l ?? null;
      } else if (r.kind === "task") {
        listId =
          this.#sql
            .exec<{ l: string | null }>(
              `SELECT m.graph_id l FROM sync_log s JOIN entity_map m ON m.kind = 'list' AND m.sid = s.list_sid
                WHERE s.kind = 'task' AND s.sid = ?`,
              r.sid,
            )
            .toArray()[0]?.l ?? null;
      }
      const excluded = listId !== null && this.#isExcluded(listId);
      out[`${r.kind}:${r.sid}`] = excluded ? { graph_id: graphId, live, excluded } : { graph_id: graphId, live };
    }
    return out;
  }

  // Gives a Graph ID about to be written to the mirror the sid the app chose
  // for it, before the row exists, so the insert trigger never mints one and
  // no client ever sees another sid for it. False when the sid names another
  // entity, or the Graph ID already has a sid (the caller then falls back to
  // adoptSid).
  reserveSid(kind: string, sid: string, graphId: string): boolean {
    return this.#transact(() => {
      const taken = this.#sql
        .exec<{ graph_id: string | null }>("SELECT graph_id FROM entity_map WHERE kind = ? AND sid = ?", kind, sid)
        .toArray()[0];
      if (taken) return taken.graph_id === graphId;
      const existing = this.#sql
        .exec<{ sid: string }>("SELECT sid FROM entity_map WHERE kind = ? AND graph_id = ?", kind, graphId)
        .toArray()[0];
      if (existing) return false;
      this.#sql.exec(
        "INSERT INTO entity_map (kind, sid, graph_id, created_ms, app_owned) VALUES (?, ?, ?, ?, 1)",
        kind, sid, graphId, Date.now(),
      );
      return true;
    });
  }

  // For the ambiguous-create recovery: when the mirror first saw each Graph
  // ID (its entity_map row), and whether its sid was chosen by the app (set by
  // reserveSid/adoptSid). An entity that already carries an app's sid was made
  // by some other mutation and is never a candidate. IDs the mirror has never
  // seen are absent from the result.
  createCandidates(kind: string, graphIds: string[]): Record<string, { first_seen_ms: number; app_owned: boolean }> {
    const out: Record<string, { first_seen_ms: number; app_owned: boolean }> = {};
    for (const id of graphIds) {
      const row = this.#sql
        .exec<{ created_ms: number; app_owned: number }>(
          "SELECT created_ms, app_owned FROM entity_map WHERE kind = ? AND graph_id = ?",
          kind,
          id,
        )
        .toArray()[0];
      if (row) out[id] = { first_seen_ms: row.created_ms, app_owned: row.app_owned === 1 };
    }
    return out;
  }

  // Gives a newly created entity the sid the app chose, after the fact: when
  // reserveSid didn't run first (or lost a race with delta), the entity is
  // already mirrored under a minted sid M that a client may have pulled. M is
  // retired the way a deletion is (a tombstone at a new seq, for lists and
  // tasks) and the entity is logged again under the app's sid; for a step or
  // link, which are logged on their task, the task is logged again. False when
  // the app's sid already names another entity.
  adoptSid(kind: string, sid: string, graphId: string): boolean {
    return this.#transact(() => {
      const taken = this.#sql
        .exec<{ graph_id: string | null }>("SELECT graph_id FROM entity_map WHERE kind = ? AND sid = ?", kind, sid)
        .toArray()[0];
      if (taken) return taken.graph_id === graphId;
      const minted = this.#sql
        .exec<{ sid: string; app_owned: number }>("SELECT sid, app_owned FROM entity_map WHERE kind = ? AND graph_id = ?", kind, graphId)
        .toArray()[0];
      // Another mutation's sid is never retired: that would delete an entity
      // the app made from under it.
      if (minted?.app_owned === 1) return false;
      const now = Date.now();
      if (minted) {
        this.#sql.exec("UPDATE entity_map SET graph_id = NULL WHERE kind = ? AND sid = ?", kind, minted.sid);
        this.#sql.exec("UPDATE field_clock SET sid = ? WHERE kind = ? AND sid = ?", sid, kind, minted.sid);
      }
      this.#sql.exec("INSERT INTO entity_map (kind, sid, graph_id, created_ms, app_owned) VALUES (?, ?, ?, ?, 1)", kind, sid, graphId, now);
      if (!minted) return true;
      const relog = (k: string, s: string, deleted: 0 | 1, listSid: string | null) => {
        this.#sql.exec("DELETE FROM sync_log WHERE kind = ? AND sid = ?", k, s);
        this.#sql.exec("INSERT INTO sync_log (kind, sid, deleted, list_sid, at_ms) VALUES (?, ?, ?, ?, ?)", k, s, deleted, listSid, now);
      };
      // A list group is logged on its own, like a list. A group just made has
      // no lists, so none needs logging again.
      if (kind === "task" || kind === "list" || kind === "list_group") {
        const logged = this.#sql
          .exec<{ list_sid: string | null }>("SELECT list_sid FROM sync_log WHERE kind = ? AND sid = ?", kind, minted.sid)
          .toArray()[0];
        if (!logged) return true;
        relog(kind, minted.sid, 1, logged.list_sid);
        relog(kind, sid, 0, kind === "list" ? sid : kind === "list_group" ? null : logged.list_sid);
        return true;
      }
      // A step or link: log its task again, so a client that pulled the task
      // with the minted sid inside gets it with the app's.
      const table = kind === "step" ? "checklist_items" : kind === "link" ? "linked_resources" : null;
      if (!table) return true;
      const key = kind === "step" ? "item_id" : "link_id";
      const task = this.#sql
        .exec<{ sid: string; list_sid: string | null }>(
          `SELECT m.sid, (SELECT sid FROM entity_map WHERE kind = 'list' AND graph_id = t.list_id) AS list_sid
             FROM ${table} c JOIN tasks t ON t.task_id = c.task_id
             JOIN entity_map m ON m.kind = 'task' AND m.graph_id = t.task_id
            WHERE c.${key} = ?`,
          graphId,
        )
        .toArray()[0];
      if (task) relog("task", task.sid, 0, task.list_sid);
      return true;
    });
  }

  // Idempotency rows are kept 30 days, longer than the app keeps an unsent
  // edit (section 5.4).
  pruneMutations(olderThanMs: number): number {
    const n = this.#sql
      .exec<{ n: number }>("SELECT count(*) n FROM applied_mutations WHERE at_ms < ?", olderThanMs)
      .one().n;
    this.#sql.exec("DELETE FROM applied_mutations WHERE at_ms < ?", olderThanMs);
    return n;
  }

  // What the app needs to set up and label an account (section 14.1).
  // server_id is created once and never changes, unlike the cursor epoch, so
  // the app recognizes a server it already has. The route decides how much of
  // this an unauthenticated caller sees (section 18.7).
  async syncInfo(): Promise<{
    server_id: string;
    cursor: string;
    account: { email: string };
    capabilities: {
      my_day: boolean;
      step_order: boolean;
      sub_resources: boolean;
      list_appearance: boolean;
      list_appearance_write: boolean;
      attachment_download: boolean;
      push: "none" | "websocket";
      source: "graph";
    };
  }> {
    let serverId = await this.#state.get<string>("sync:server_id");
    if (!serverId) {
      serverId = crypto.randomUUID();
      await this.#state.put("sync:server_id", serverId);
    }
    const myDay = myDayEnabled(this.#env);
    const appearance = myDay && !this.#substrateUnavailable && !this.#appearanceUnavailable;
    return {
      server_id: serverId,
      cursor: currentCursor(this.#sql),
      account: { email: this.#env.OWNER_EMAIL ?? "" },
      capabilities: {
        my_day: myDay,
        // Step order is read from Substrate by the sub-resource scan.
        step_order: myDay && checklistCacheEnabled(this.#env),
        // The feed carries every task's steps, links and attachments only when
        // the sub-resource scan runs (the checklist cache). Without it a task
        // carries just the ones written through this server, and those can go
        // stale when edited in another app.
        sub_resources: checklistCacheEnabled(this.#env),
        // Sidebar groups, order and theme are read from Substrate (section
        // 10.4). Off when the Exchange Online scope is missing or refused.
        list_appearance: appearance,
        // list.update theme/group_id and list.reorder (section 5.2). A flag of
        // its own because servers that read appearance predate the writes: an
        // app gating writes on list_appearance would send them to a server
        // that rejects them.
        list_appearance_write: appearance,
        // GET /api/v1/attachments/{sid} streams an attachment's bytes.
        attachment_download: true,
        push: "websocket",
        source: "graph",
      },
    };
  }

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
    notifications: WebhookHealth;
  }> {
    const cfg = await this.#listsConfig();

    const stateRows = this.#sql
      .exec("SELECT * FROM sync_state")
      .toArray() as unknown as SyncStateRow[];
    const stateByResource = new Map(stateRows.map((s) => [s.resource, s]));

    const listRows = this.listLists();
    const listById = new Map(listRows.map((l) => [l.list_id, l]));
    const countRows = this.#sql
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
        if (shouldSkipSync(listById.get(listId) ?? { list_id: listId, wellknown: null }, cfg)) {
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
    return {
      resources,
      totals: { tasks, lists: listRows.length, all_idle },
      notifications: this.#webhookHealth(Date.now()),
    };
  }

  // -- Sync (alarm-driven, resumable, budget-bounded) -----------------------

  // Arm the alarm ~now if none is pending. Called by the cron heartbeat and on
  // cold reads so a fresh index warms without waiting for the next cron tick.
  async ensureSyncing(): Promise<void> {
    const pending = await this.#alarms.getAlarm();
    if (pending === null) await this.#alarms.setAlarm(Date.now() + 1);
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
      this.#hotLists.add(rec.list_id);
      work.push({ listId: rec.list_id, taskId: item.resourceId, changeType: item.changeType });
    }

    // Arm the alarm once for the Graph delta refresh (idempotent; coalesces),
    // and stamp delivery health so a silent stop in Graph's notifications is
    // observable (full coverage + a stale last_notification_at).
    if (accepted > 0) {
      const now = Date.now();
      await this.#alarms.setAlarm(now + 1);
      this.#recordNotification(accepted, now);
    }

    // Targeted My Day refresh of each changed task. Sequential (EXO forbids
    // parallel Substrate calls). Skipped entirely when My Day is off.
    if (myDayEnabled(this.#env)) {
      let sub: SubstrateClient | null = null;
      for (const w of work) {
        if (!w.taskId || w.changeType === "deleted") continue;
        try {
          if (!sub) {
            const ident = await loadIdentity(this.#env);
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
          // A notification's resourceId may be a default REST ID; translate it
          // when it doesn't match the immutable-keyed mirror.
          if (this.getMyDayFields(w.taskId) === null && !looksImmutable(w.taskId)) {
            const t = await new GraphClient(this).translateToImmutable([w.taskId]);
            w.taskId = t.get(w.taskId) ?? w.taskId;
          }
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

  // Lifecycle-event entrypoint (the webhook splits these out of the same POST by
  // payload shape). These are what keep an Exchange-backed todoTask subscription
  // alive between renewals:
  //   reauthorizationRequired — Graph's periodic re-consent check (cadence ≈
  //     access-token TTL, far shorter than our renewal margin). Respond by
  //     PATCH-renewing, which re-binds the current token; ignoring it is exactly
  //     how the subscription goes dormant (renews fine, stops delivering).
  //   subscriptionRemoved — Graph dropped it; clear the record so reconcile
  //     mints a fresh one.
  //   missed — a delivery gap; arm delta to backfill.
  // clientState-validated like change notifications. The reauthorize PATCH is a
  // mutation of the SUBSCRIPTION resource, not task data, so it cannot emit a
  // todoTask notification — the read-only-toward-task-data invariant holds.
  async onLifecycleEvent(
    items: Array<{ subscriptionId?: string; clientState?: string; lifecycleEvent?: string }>,
  ): Promise<{ reauthorized: number; removed: number; missed: number; rejected: number }> {
    let reauthorized = 0;
    let removed = 0;
    let missed = 0;
    let rejected = 0;
    const graph = new GraphClient(this);
    for (const item of items) {
      const rec = item.subscriptionId ? this.findSubscription(item.subscriptionId) : null;
      if (!rec || rec.client_state !== item.clientState) {
        rejected += 1;
        continue;
      }
      switch (item.lifecycleEvent) {
        case "reauthorizationRequired":
          try {
            const next = desiredExpiration(Date.now());
            const { expirationDateTime } = await renewSubscription(graph, rec.subscription_id, next);
            this.putSubscription({ ...rec, expiration_ms: Date.parse(expirationDateTime) });
            reauthorized += 1;
            log.info("subscription_reauthorized", {
              subscription_id: rec.subscription_id,
              list_id: rec.list_id,
            });
          } catch (e) {
            // 404 → gone on Graph's side; drop so reconcile recreates. Other
            // errors: leave it for the renew/reconcile cycle to retry.
            if (e instanceof GraphError && e.status === 404) {
              this.deleteSubscriptionRecord(rec.subscription_id);
            }
            log.warn("subscription_reauthorize_failed", {
              subscription_id: rec.subscription_id,
              error: e instanceof Error ? e.message : String(e),
            });
          }
          break;
        case "subscriptionRemoved":
          this.deleteSubscriptionRecord(rec.subscription_id);
          removed += 1;
          log.info("subscription_removed_by_graph", {
            subscription_id: rec.subscription_id,
            list_id: rec.list_id,
          });
          break;
        case "missed":
          missed += 1;
          break;
        default:
          rejected += 1;
      }
    }
    // Removed records and missed gaps both want a delta cycle (recreate the sub /
    // backfill the gap). A reauthorize alone doesn't change task state.
    if (removed + missed > 0) await this.#alarms.setAlarm(Date.now() + 1);
    return { reauthorized, removed, missed, rejected };
  }

  // Tear down and re-mint subscriptions so they pick up the current creation
  // shape (notably lifecycleNotificationUrl, which can't be PATCHed onto an
  // existing subscription). Clears the local record(s); the next reconcile cycle
  // then tears down the now-untracked old Graph subs as orphans and creates
  // fresh ones for the wanted lists. Scope to one list (the delivery experiment:
  // recreate one list, leave the rest as a control) or all (the rollout).
  async recreateSubscriptions(listId?: string): Promise<{ cleared: number }> {
    const cleared = this.getSubscriptions().filter(
      (r) => listId === undefined || r.list_id === listId,
    ).length;
    if (listId === undefined) {
      this.#sql.exec("DELETE FROM subscriptions");
    } else {
      this.#sql.exec("DELETE FROM subscriptions WHERE list_id = ?", listId);
    }
    await this.#alarms.setAlarm(Date.now() + 1);
    log.info("subscriptions_recreate_requested", { list_id: listId ?? "*", cleared });
    return { cleared };
  }

  // One sync cycle per alarm, then re-arm: soon if anything is still mid-cycle
  // (baseline draining), else at the configured interval.
  async alarm(): Promise<void> {
    // Cold / never-authorized: nothing to sync. Don't re-arm — ensureSyncing()
    // (cron heartbeat or a post-/authorize read) restarts the loop.
    if (!(await loadTokens(this.#env))) return;
    // Microsoft refused our refresh token or demanded Conditional Access step-up:
    // every refresh would fail the same way, so stop until clearReauth() re-arms.
    if (await this.#state.get(REAUTH_KEY)) return;
    const midCycle = await this.runSyncCycle();
    const intervalMs = this.#intervalMs();
    // A webhook that arrived while this cycle ran armed the alarm for now, and
    // the setAlarm below would push it back a whole interval: run again at once
    // for any list it named.
    const next =
      this.#hotLists.size > 0
        ? 1
        : midCycle
          ? MID_CYCLE_REARM_MS
          : this.#scanBacklog
            ? Math.min(intervalMs, BACKFILL_REARM_MS)
            : intervalMs;
    await this.#alarms.setAlarm(Date.now() + next);
    // Ends push sockets whose token expired even when nothing changed, since
    // an idle socket is otherwise only checked when a change goes out.
    this.#notifier?.sweep();
  }

  // Force a re-baseline: drop rows + delta tokens (one list or everything) and
  // arm the alarm now. Manual twin of the 410 path. Note: if the target list is
  // skipped (no_sync / built-in flaggedEmails), the next cycle won't re-baseline
  // it, so resync on a skipped list is effectively just a purge.
  // Re-baseline one list, or the roster and every list, without emptying
  // anything first: rows stay served while the baseline runs, and rows it
  // doesn't return are deleted when it completes (section 3.3).
  async resync(listId?: string): Promise<void> {
    if (listId) {
      this.#beginSweep(`tasks:${listId}`);
    } else {
      this.#beginSweep("lists");
      for (const l of this.listLists()) this.#beginSweep(`tasks:${l.list_id}`);
    }
    await this.#alarms.setAlarm(Date.now() + 1);
  }

  // Start a mark-and-sweep baseline for one resource: drop its delta cursor and
  // record a new generation.
  #beginSweep(resource: string, lastError: string | null = null): void {
    this.#setSyncState(resource, {
      delta_link: null,
      next_link: null,
      status: "baseline",
      ...(lastError ? { last_error: lastError } : {}),
    });
    this.#sql.exec("UPDATE sync_state SET sweep_gen = ? WHERE resource = ?", Date.now(), resource);
  }

  // The baseline reached its deltaLink: delete what it didn't see, then clear
  // the generation. One transaction, so a crash can't leave half a sweep.
  #finishSweep(resource: string): void {
    const gen = this.#sql
      .exec<{ g: number | null }>("SELECT sweep_gen g FROM sync_state WHERE resource = ?", resource)
      .toArray()[0]?.g;
    if (gen == null) return;
    this.#transact(() => {
      if (resource === "lists") {
        const stale = this.#sql
          .exec<{ list_id: string }>(
            "SELECT list_id FROM lists WHERE baseline_gen IS NULL OR baseline_gen <> ?",
            gen,
          )
          .toArray();
        for (const l of stale) this.deleteList(l.list_id);
      } else {
        const listId = resource.slice("tasks:".length);
        for (const table of ["checklist_items", "linked_resources", "attachments"]) {
          this.#sql.exec(
            `DELETE FROM ${table} WHERE task_id IN (
               SELECT task_id FROM tasks WHERE list_id = ? AND (baseline_gen IS NULL OR baseline_gen <> ?))`,
            listId,
            gen,
          );
        }
        this.#sql.exec(
          "DELETE FROM tasks WHERE list_id = ? AND (baseline_gen IS NULL OR baseline_gen <> ?)",
          listId,
          gen,
        );
      }
      this.#sql.exec("UPDATE sync_state SET sweep_gen = NULL WHERE resource = ?", resource);
    });
  }

  // Hard identity reset: wipe ALL indexed state because the owning Microsoft
  // account changed (auth handler detected a different /me.id). Drops every
  // task (FTS mirror cascades via the AFTER DELETE trigger), the full `lists`
  // roster, and every `sync_state` cursor, then cancels any pending alarm so a
  // stale baseline for the previous identity can't run against the new account's
  // tokens. The KV twin (tokens/identity) is cleared by
  // core/auth/microsoft.ts wipeIdentityScopedState(), which also calls this.
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
    this.#notifier?.closeAll("reset");
    this.#substrateToken = null;
    this.#substrateUnavailable = false;
    this.#appearanceUnavailable = false;
    await this.#state.delete(APPEARANCE_BACKOFF_KEY);
    await this.#state.delete(APPEARANCE_FIRST_READ_KEY);
    // Kill every MCP grant paired with the outgoing account; the new account's
    // grant is issued under the fresh epoch right after this wipe.
    await this.#newEpoch();
    await this.#state.delete(REAUTH_KEY);
    this.#sql.exec("DELETE FROM tasks"); // tasks_fts cascades via AFTER DELETE trigger
    this.#sql.exec("DELETE FROM lists");
    this.#sql.exec("DELETE FROM sync_state");
    this.#sql.exec("DELETE FROM subscriptions");
    // A different owner: no client may continue from a cursor into the old
    // owner's data. Drop the change log and stable IDs (the deletes above
    // logged tombstones) and replace the epoch.
    // The app-owned appearance (section 4.8) was the old owner's too. Its
    // image bytes are left to the blob sweep, which deletes any image the
    // table no longer has.
    for (const table of [
      "checklist_items", "linked_resources", "attachments", "list_groups",
      "theme_images", "list_images", "app_settings", "field_clock", "sync_log", "entity_map",
    ]) {
      this.#sql.exec(`DELETE FROM ${table}`);
    }
    this.#sql.exec("UPDATE sync_meta SET epoch = lower(hex(randomblob(8))) WHERE id = 1");
    seedAppSettings(this.#sql);
    await this.#alarms.deleteAlarm();
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
    const cfg = await this.#listsConfig();
    const rosterRows = this.listLists();
    const settingOf = (listId: string): ListSync =>
      listSync(rosterRows.find((l) => l.list_id === listId) ?? { list_id: listId, wellknown: null }, cfg);
    // Record each list's setting on its row, where the change feed reads it.
    this.#storeListSync(rosterRows, cfg);
    // From here on the row is the setting: refreshListSync can change it while
    // this cycle waits on Graph, so every later check reads it again.
    const skip = (listId: string): boolean => this.#isExcluded(listId);

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
    // Lists a webhook just named go first, and each list's changes are
    // announced as soon as they land (docs/SYNC-API.md section 7.2), so an
    // edit reaches push clients without waiting for the rest of the walk.
    let remaining = maxTaskPages;
    const hot = [...this.#hotLists];
    this.#hotLists.clear();
    // Todo lists first, then reference lists (section 1.2): a reference list
    // only gets what's left of the page budget.
    const byPriority = this.#listIdsByPriority();
    const order = [
      ...byPriority.filter((id) => settingOf(id) !== "reference"),
      ...byPriority.filter((id) => settingOf(id) === "reference"),
    ];
    for (const listId of [...hot.filter((id) => order.includes(id)), ...order.filter((id) => !hot.includes(id))]) {
      if (skip(listId)) continue;
      if (remaining <= 0) break;
      const r = await this.#syncResource(`tasks:${listId}`, tasksDeltaUrl(listId), remaining);
      remaining -= r.pagesFetched;
      anyOutstanding ||= r.midCycle;
      try {
        this.announceChanges();
      } catch (e) {
        log.warn("sync_announce_failed", { error: String(e) });
      }
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
      // Sidebar groups, order and theme (section 10.4): two Substrate GETs
      // when due. Never fails the cycle.
      await this.#refreshListAppearance().catch((e) =>
        log.warn("list_appearance_failed", { error: String(e) }),
      );
      await this.#runMyDayScanBatch(skip).catch((e) =>
        log.warn("my_day_scan_failed", { error: String(e) }),
      );
      // Drain the checklist backfill/refresh set (gated + budgeted). Same calm-
      // cycle placement so its Graph GETs don't stack on a baseline page-burst.
      await this.#runChecklistScanBatch(skip).catch((e) =>
        log.warn("checklist_scan_failed", { error: String(e) }),
      );
      try {
        this.pruneMutations(Date.now() - MUTATION_RETENTION_MS);
      } catch (e) {
        log.warn("prune_mutations_failed", { error: String(e) });
      }
    }
    return anyOutstanding;
  }

  // Drop a skipped list's indexed rows + task sync_state (FTS cascades via the
  // AFTER DELETE trigger). The roster row is intentionally LEFT so the list
  // still appears in list_lists and stays readable via the live-Graph cold
  // fallback. Guarded so a steady-state skipped list costs zero row-writes.
  #purgeSkippedList(listId: string): void {
    const hasRows =
      this.#sql.exec("SELECT 1 FROM tasks WHERE list_id = ? LIMIT 1", listId).toArray().length > 0;
    const hasState =
      !!this.#getSyncState(`tasks:${listId}`) || !!this.#getSyncState(`myday:${listId}`);
    if (!hasRows && !hasState) return;
    this.#purges.set(listId, (this.#purges.get(listId) ?? 0) + 1);
    this.#sql.exec("DELETE FROM tasks WHERE list_id = ?", listId);
    for (const table of ["checklist_items", "linked_resources", "attachments"]) {
      this.#sql.exec(`DELETE FROM ${table} WHERE list_id = ?`, listId);
    }
    this.#sql.exec("DELETE FROM sync_state WHERE resource = ?", `tasks:${listId}`);
    this.#sql.exec("DELETE FROM sync_state WHERE resource = ?", `myday:${listId}`);
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

    // A list purged while its pages were in flight (refreshListSync excluded
    // it): drop what came back and leave no sync state. If it is still
    // excluded, the rows and a fresh cursor would bring it back into the
    // mirror. If it was switched back on meanwhile, the result continues a
    // cursor that no longer matches the emptied list: storing its delta link
    // would leave the list empty but idle. With no state, the list's next
    // sync (it is hot, so at once) is a fresh baseline.
    const listId = resource.startsWith("tasks:") ? resource.slice("tasks:".length) : null;
    const purgesBefore = listId === null ? 0 : (this.#purges.get(listId) ?? 0);
    const excludedNow = () =>
      listId !== null && (this.#isExcluded(listId) || (this.#purges.get(listId) ?? 0) !== purgesBefore);
    try {
      const res = await followToTerminal(graph, startUrl, Math.max(1, maxPages));
      if (excludedNow()) return { pagesFetched: res.pagesFetched, midCycle: false };
      this.#applyRows(resource, res.rows);
      if (res.deltaLink) {
        this.#finishSweep(resource);
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
      if (excludedNow()) return { pagesFetched: 1, midCycle: false };
      if (e instanceof GraphError && e.status === 410) {
        // Delta token expired (~30d). Re-baseline with mark and sweep: rows
        // stay served, and those the new baseline doesn't return are removed
        // when it completes. For the roster this sweeps lists only; each list's
        // own task delta token is still valid.
        log.warn("sync_410_rebaseline", { resource });
        this.#beginSweep(resource, "410_gone");
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
    const checklist = checklistCacheEnabled(this.#env);
    for (const row of rows) {
      if (row.kind === "removed") {
        // A list's delta reports a task that left it — deleted, or moved to
        // another list. Task IDs are immutable, so a moved task's row already
        // sits under its new list (the move's write-through, or the other
        // list's delta earlier in the cycle); deleting by ID alone would drop
        // it from the mirror until it next changed. Only remove it from here.
        const owner = this.#sql
          .exec<{ list_id: string }>("SELECT list_id FROM tasks WHERE task_id = ?", row.id)
          .toArray()[0];
        if (owner && owner.list_id !== listId) {
          log.info("delta_removed_moved_task_kept", { list_id: listId, now_in: owner.list_id });
          continue;
        }
        this.deleteTask(row.id); // cascades checklist_items
      } else {
        const modifiedAt = () =>
          this.#sql.exec<{ m: number | null }>("SELECT modified_at m FROM tasks WHERE task_id = ?", row.task.id).toArray()[0];
        const before = checklist ? modifiedAt() : undefined;
        this.upsertTask(row.task, listId);
        if (!checklist) continue;
        // Incremental engine: a task that rode delta CHANGED (checklist edits bump
        // its lastModifiedDateTime), so its cached checklist may be stale — mark it
        // for re-fetch by the next budgeted scan. Delta carries no expansions, so
        // we can't diff the checklist here; the marker + scan does it cheaply.
        // A row whose modified time didn't move is skipped: a re-baseline returns
        // every task unchanged and must not re-queue the whole backfill (18.6).
        const after = modifiedAt();
        if (before && after && before.m === after.m) continue;
        this.markChecklistDirty(row.task.id);
      }
    }
  }


  #getSyncState(resource: string): SyncStateRow | null {
    const rows = this.#sql
      .exec("SELECT * FROM sync_state WHERE resource = ?", resource)
      .toArray() as unknown as SyncStateRow[];
    return rows.length > 0 ? rows[0] : null;
  }

  // Stamp the webhook-delivery telemetry on each accepted notification batch.
  #recordNotification(accepted: number, now: number): void {
    const cur = this.#getSyncState(WEBHOOK_HEALTH_KEY);
    const prevTotal = cur?.status ? Number(cur.status) || 0 : 0;
    this.#setSyncState(WEBHOOK_HEALTH_KEY, {
      last_synced_at: now,
      status: String(prevTotal + accepted),
    });
  }

  // Read the webhook-delivery health (see WebhookHealth / WEBHOOK_HEALTH_KEY).
  #webhookHealth(now: number): WebhookHealth {
    const row = this.#getSyncState(WEBHOOK_HEALTH_KEY);
    const last = row?.last_synced_at ?? null;
    return {
      last_notification_at: last,
      notifications_total: row?.status ? Number(row.status) || 0 : 0,
      minutes_since: last === null ? null : Math.round((now - last) / 60_000),
    };
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
    this.#sql.exec(
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
    const lists = this.#sql
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

  // The To Do sidebar, read-only from Substrate (docs/SYNC-API.md section
  // 10.4): every folder's group, position and theme, and every list group.
  // Due when a list has never been read (a new list, or the first cycle after
  // migration v12), or when the last successful read is a sync interval old;
  // a sidebar reorder or theme change doesn't show in Graph's roster delta,
  // so the interval is what picks those up. Without the Exchange Online scope
  // it does nothing and the columns stay NULL.
  //
  // A 403 sets #appearanceUnavailable, never the My Day latch: a sidebar
  // endpoint refusing the owner says nothing about My Day. Any other failure
  // backs off: the next read waits DELTA_SYNC_INTERVAL_MIN × 2^(failures−1),
  // at most APPEARANCE_BACKOFF_MAX_MS, persisted so it survives eviction.
  async #refreshListAppearance(now: number = Date.now()): Promise<void> {
    if (!myDayEnabled(this.#env) || this.#substrateUnavailable || this.#appearanceUnavailable) return;
    const backoff = (await this.#state.get<AppearanceBackoff>(APPEARANCE_BACKOFF_KEY)) ?? null;
    if (backoff && now < backoff.next_at) return;
    const unread = this.#sql.exec("SELECT 1 FROM lists WHERE appearance_synced_at IS NULL LIMIT 1").toArray().length > 0;
    const last = this.#getSyncState(APPEARANCE_STATE_KEY)?.last_synced_at ?? null;
    if (!backoff && !unread && last !== null && now - last < this.#intervalMs()) return;
    const listIds = this.listLists().map((l) => l.list_id);
    if (listIds.length === 0) return;
    // An owner switch during the reads (resetIdentity) makes them the old
    // account's sidebar: nothing from them is written.
    const gen = this.#identityGeneration;
    const writeGen = this.#sidebarWriteGen;
    try {
      const sub = await this.#substrateForScan();
      // Both reads before any write, so a failed second read changes nothing.
      // No 429 retries: a throttled mailbox fails the read, which backs off,
      // rather than holding the alarm for up to 40 s.
      const folders = await sub.listFolders({ fast: true });
      const groups = await sub.listFolderGroups({ fast: true });
      if (gen !== this.#identityGeneration) return;
      if (writeGen !== this.#sidebarWriteGen) {
        // A write stored during the GETs may be missing from them; applying
        // them would undo it. last_synced_at stays, so the next cycle reads again.
        log.info("list_appearance_read_superseded", {});
        return;
      }
      const r = this.applyListAppearance(folders, groups, listIds, now);
      if ((await this.#state.get<number>(APPEARANCE_FIRST_READ_KEY)) === undefined) {
        // The apply's time, not the read's start: the groups' entity_map rows
        // are stamped as they are inserted, after the GETs.
        await this.#state.put(APPEARANCE_FIRST_READ_KEY, Date.now());
      }
      this.#setSyncState(APPEARANCE_STATE_KEY, { last_synced_at: now, status: "idle", last_error: null });
      if (backoff) await this.#state.delete(APPEARANCE_BACKOFF_KEY);
      log.info("list_appearance_synced", r);
    } catch (e) {
      if (gen !== this.#identityGeneration) return;
      if (e instanceof Error && e.message.includes("my_day_unavailable")) return;
      if (e instanceof SubstrateError && e.status === 403) {
        this.#appearanceUnavailable = true;
        log.warn("list_appearance_unavailable", { error: e.detail ?? "403" });
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      const failures = (backoff?.failures ?? 0) + 1;
      const delay = Math.min(this.#intervalMs() * 2 ** (failures - 1), APPEARANCE_BACKOFF_MAX_MS);
      await this.#state.put(APPEARANCE_BACKOFF_KEY, { failures, next_at: now + delay } satisfies AppearanceBackoff);
      this.#setSyncState(APPEARANCE_STATE_KEY, { status: "error", last_error: msg });
      log.warn("list_appearance_read_failed", { error: msg, failures, retry_in_min: Math.round(delay / 60_000) });
    }
  }

  // Stores one sidebar read: upserts the groups and deletes the ones that are
  // gone (each logs a change or deletion record through migration v12's
  // triggers), then sets each list's group, position and theme. Groups are
  // written first, so a list moved into a new group is logged after the
  // group. `listIds`: the lists that existed when the read started; each is
  // marked read, matched or not, so a list Substrate doesn't return isn't
  // read again every cycle. Lists added since keep the marker NULL.
  applyListAppearance(
    folders: SubstrateFolder[],
    groups: SubstrateFolderGroup[],
    listIds: string[],
    now: number = Date.now(),
  ): {
    lists: number;
    unmatched_folders: number;
    unread_lists: number;
    groups: number;
    groups_deleted: number;
    groups_kept_unconfirmed: boolean;
  } {
    return this.#transact(() => {
      const keep = new Set(groups.map((g) => g.Id));
      // A folder naming a group the group read didn't return means the two
      // reads disagree (a group made between them, or a short group read):
      // keep every stored group this time rather than delete one in use.
      const groupsComplete = folders.every((f) => !f.ParentFolderGroupId || keep.has(f.ParentFolderGroupId));
      for (const g of groups) {
        this.#sql.exec(
          `INSERT INTO list_groups (group_id, name, order_datetime) VALUES (?, ?, ?)
           ON CONFLICT(group_id) DO UPDATE SET name = excluded.name, order_datetime = excluded.order_datetime`,
          g.Id, g.Name ?? null, g.OrderDateTime ?? null,
        );
      }
      const stored = this.#sql.exec<{ group_id: string }>("SELECT group_id FROM list_groups").toArray();
      let deleted = 0;
      for (const { group_id } of groupsComplete ? stored : []) {
        if (keep.has(group_id)) continue;
        // Ungroup its lists first, so each is logged again with group_id
        // null even when this read doesn't return it (section 4.2).
        this.#sql.exec("UPDATE lists SET group_id = NULL WHERE group_id = ?", group_id);
        this.#sql.exec("DELETE FROM list_groups WHERE group_id = ?", group_id);
        deleted += 1;
      }
      const known = new Set(listIds);
      const read = new Set<string>();
      let unmatched = 0;
      for (const f of folders) {
        if (!known.has(f.Id)) {
          unmatched += 1;
          continue;
        }
        read.add(f.Id);
        this.#sql.exec(
          `UPDATE lists SET group_id = ?, order_datetime = ?, theme_color = ?, theme_background = ?,
             appearance_synced_at = ? WHERE list_id = ?`,
          f.ParentFolderGroupId ?? null, f.OrderDateTime ?? null,
          rawAppearance(f.ThemeColor), rawAppearance(f.ThemeBackground), now, f.Id,
        );
      }
      for (const id of listIds) {
        if (!read.has(id)) this.#sql.exec("UPDATE lists SET appearance_synced_at = ? WHERE list_id = ?", now, id);
      }
      return {
        lists: read.size,
        unmatched_folders: unmatched,
        unread_lists: listIds.length - read.size,
        groups: groups.length,
        groups_deleted: deleted,
        groups_kept_unconfirmed: !groupsComplete,
      };
    });
  }

  // The sidebar as the mirror last read it: each list's group and position,
  // and each group's position (docs/SYNC-API.md section 10.4). Excluded lists
  // are included: they still hold a place in To Do's sidebar.
  sidebar(): {
    lists: Array<{ list_id: string; group_id: string | null; order_datetime: string | null; wellknown: string | null }>;
    groups: Array<{ group_id: string; order_datetime: string | null }>;
  } {
    return {
      lists: this.#sql
        .exec<{ list_id: string; group_id: string | null; order_datetime: string | null; wellknown: string | null }>(
          "SELECT list_id, group_id, order_datetime, wellknown FROM lists",
        )
        .toArray(),
      groups: this.#sql
        .exec<{ group_id: string; order_datetime: string | null }>("SELECT group_id, order_datetime FROM list_groups")
        .toArray(),
    };
  }

  // When the first sidebar read succeeded, or null if none has.
  async sidebarFirstReadAt(): Promise<number | null> {
    return (await this.#state.get<number>(APPEARANCE_FIRST_READ_KEY)) ?? null;
  }

  // Stores one folder as a write returned it (ops setListAppearance), the
  // same columns a sidebar read sets. A group the mirror hasn't read yet is
  // stored as named; the next sidebar read adds the group itself.
  storeFolderAppearance(folder: SubstrateFolder): void {
    this.#sidebarWriteGen++;
    this.#sql.exec(
      `UPDATE lists SET group_id = ?, order_datetime = ?, theme_color = ?, theme_background = ? WHERE list_id = ?`,
      folder.ParentFolderGroupId ?? null, folder.OrderDateTime ?? null,
      rawAppearance(folder.ThemeColor), rawAppearance(folder.ThemeBackground), folder.Id,
    );
  }

  // Stores one list group as a write returned it (ops/lists.ts), the same
  // columns a sidebar read sets. The insert trigger logs it; on a create the
  // caller has reserved the app's sid first, so none is minted.
  storeFolderGroup(group: SubstrateFolderGroup): void {
    this.#sidebarWriteGen++;
    this.#sql.exec(
      `INSERT INTO list_groups (group_id, name, order_datetime) VALUES (?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET name = excluded.name, order_datetime = excluded.order_datetime`,
      group.Id, group.Name ?? null, group.OrderDateTime ?? null,
    );
  }

  // Drops a deleted group the way a sidebar read does: its lists are
  // ungrouped first, so each is logged again with group_id null.
  removeFolderGroup(groupId: string): void {
    this.#sidebarWriteGen++;
    this.#transact(() => {
      this.#sql.exec("UPDATE lists SET group_id = NULL WHERE group_id = ?", groupId);
      this.#sql.exec("DELETE FROM list_groups WHERE group_id = ?", groupId);
    });
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
    if (!myDayEnabled(this.#env)) return;

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

    const ident = await loadIdentity(this.#env);
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
        // Substrate returns default REST IDs; the mirror is keyed on immutable
        // IDs (section 18.2), so translate the folder's IDs in one call.
        const ids = await new GraphClient(this).translateToImmutable(
          folderTasks.map((t) => t.Id ?? "").filter(Boolean),
        );
        for (const t of folderTasks) {
          const id = t.Id ? ids.get(t.Id) : undefined;
          if (!id) continue;
          this.updateMyDayFields(id, {
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
    if (!checklistCacheEnabled(this.#env)) return;

    // Flagged email gets no sub-resource fetch at all; other archive lists get
    // it for open tasks only (sections 1.2, 18.7a).
    // From the stored setting, which backfillRemaining (change-feed.ts) also
    // reads, so the count it reports matches what this scan will drain.
    const lists = this.listLists();
    const skipIds = lists
      .filter((l) => skip(l.list_id) || l.wellknown === "flaggedEmails")
      .map((l) => l.list_id);
    const openOnlyIds = lists.filter((l) => l.sync === "reference").map((l) => l.list_id);
    // Backfill mode: while more than one batch is waiting, take a bigger batch
    // and have alarm() come back soon instead of after the full interval.
    const normal = checklistScanMaxTasksPerCycle(this.#env);
    const probe = this.selectDueChecklistTasks(normal + 1, skipIds, openOnlyIds);
    this.#scanBacklog = probe.length > normal;
    const due = this.#scanBacklog
      ? this.selectDueChecklistTasks(Math.max(normal, BACKFILL_TASKS_PER_CYCLE), skipIds, openOnlyIds)
      : probe;
    if (due.length === 0) return;
    const sub = myDayEnabled(this.#env) ? await this.#substrateForScan() : null;

    const graph = new GraphClient(this);
    let scanned = 0;
    let errored = 0;
    for (const { task_id, list_id } of due) {
      try {
        // One GET returns the steps and linked resources; attachments need
        // their own call, made only when the task has any (section 1.1).
        const t = await getTaskWithSubresources(graph, list_id, task_id);
        const atts = t.hasAttachments ? await listAttachments(graph, list_id, task_id) : [];
        // Step order lives only in Substrate. Best effort: a failure keeps the
        // steps and leaves their order as it was.
        let order: Map<string, string | null> | null = null;
        if (sub && (t.checklistItems?.length ?? 0) > 0) {
          try {
            const subtasks = await sub.listSubtasks(list_id, task_id, { fast: true });
            order = new Map(subtasks.filter((s) => s.Id).map((s) => [s.Id as string, s.OrderDateTime ?? null]));
          } catch (e) {
            log.warn("checklist_order_fetch_failed", { task_id, error: String(e) });
          }
        }
        this.#transact(() => {
          this.replaceLinkedResources(task_id, list_id, t.linkedResources ?? []);
          this.replaceAttachments(task_id, list_id, atts);
          // Last: it clears the "needs fetch" marker.
          this.replaceChecklistItems(task_id, list_id, t.checklistItems ?? []);
          if (order) {
            for (const [id, at] of order) {
              this.#sql.exec(
                "UPDATE checklist_items SET order_datetime = ? WHERE item_id = ? AND task_id = ? AND order_datetime IS NOT ?",
                at, id, task_id, at,
              );
            }
          }
        });
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

  async #substrateForScan(): Promise<SubstrateClient> {
    const ident = await loadIdentity(this.#env);
    return new SubstrateClient(
      {
        getSubstrateAccessToken: () => this.getSubstrateAccessToken(),
        forceSubstrateRefresh: () => this.forceSubstrateRefresh(),
      },
      ident?.anchorMailbox ?? null,
    );
  }

  #intervalMs(): number {
    const min = Number(this.#env.DELTA_SYNC_INTERVAL_MIN);
    return (Number.isFinite(min) && min > 0 ? min : 15) * 60_000;
  }

  #myDayScanEveryNCycles(): number {
    const n = Number(this.#env.MY_DAY_SCAN_EVERY_N_CYCLES);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
  }

  #myDayScanWindowMs(): number {
    return this.#intervalMs() * this.#myDayScanEveryNCycles();
  }

  // Max lists scanned per cycle. Small by default so the scan's Substrate GETs
  // stay well under the Workers free-tier subrequest ceiling even on a large
  // roster; raise it on paid plans to scan more (or the whole roster) per cycle.
  #myDayScanMaxFoldersPerCycle(): number {
    const n = Number(this.#env.MY_DAY_SCAN_MAX_FOLDERS_PER_CYCLE);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 6;
  }

  // -- Write lease (docs/SYNC-API.md section 18.4) ----------------------------
  // One writer at a time across every surface that changes Microsoft data (MCP
  // tools today, sync mutations and the n8n routes later). The writes run in
  // the caller — the McpAgent Worker on Cloudflare, the request on Node — not
  // in here, and a closure can't cross Durable Object RPC, so the queue can't
  // be a promise chain like #refreshChain. It is a lease: the writer acquires
  // it, makes its Graph/Substrate calls, renews it while they run, and
  // releases it. Waiting happens HERE, in a FIFO of pending acquires, so a
  // burst of writes queues in arrival order instead of polling; only the
  // wait crosses RPC. A writer that dies stops renewing and the TTL hands the
  // lease to the next waiter. Client side: src/core/ops/write-lease.ts.
  //
  // {holder, expiresAt} is persisted in the StateStore so a restart of the
  // object (it can be evicted between a holder's renewals) doesn't drop a live
  // lease; the waiters are in memory because their RPCs die with the object.
  #writeLease: { holder: string; expiresAt: number } | null = null;
  #writeLeaseLoaded: Promise<void> | null = null;
  #writeLeaseWaiters: Array<{
    holder: string;
    ttl: number;
    resolve: (r: { granted: true; expiresAt: number } | { granted: false }) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  #writeLeaseExpiryTimer: ReturnType<typeof setTimeout> | undefined;

  // Grants the lease to `holder` when it already holds it (renewal: extends
  // it), or when it is free and nobody is queued ahead. Otherwise waits up to
  // waitMs in FIFO order; { granted: false } when the wait runs out. TTL and
  // wait are clamped so a bad caller can't hold or block writes for long.
  async acquireWriteLease(
    holder: string,
    ttlMs: number,
    waitMs = 0,
  ): Promise<{ granted: true; expiresAt: number } | { granted: false }> {
    await this.#loadWriteLease();
    const ttl = clampMs(ttlMs, WRITE_LEASE_MIN_TTL_MS, WRITE_LEASE_MAX_TTL_MS);
    const lease = this.#writeLease;
    const now = Date.now();
    const free = !lease || lease.expiresAt <= now;
    if (lease?.holder === holder && lease.expiresAt > now) return this.#grantWriteLease(holder, ttl);
    if (free && this.#writeLeaseWaiters.length === 0) return this.#grantWriteLease(holder, ttl);
    const wait = clampMs(waitMs, 0, WRITE_LEASE_MAX_WAIT_MS);
    if (wait === 0) return { granted: false };
    const granted = new Promise<{ granted: true; expiresAt: number } | { granted: false }>((resolve) => {
      const w = {
        holder,
        ttl,
        resolve,
        timer: setTimeout(() => {
          this.#writeLeaseWaiters = this.#writeLeaseWaiters.filter((x) => x !== w);
          resolve({ granted: false });
        }, wait),
      };
      this.#writeLeaseWaiters.push(w);
    });
    this.#handOffWriteLease();
    return granted;
  }

  // Releases the lease only if `holder` still holds it (a holder whose lease
  // expired and passed on can't release the new owner's), then hands it to
  // the next waiter. True if released.
  async releaseWriteLease(holder: string): Promise<boolean> {
    await this.#loadWriteLease();
    if (this.#writeLease?.holder !== holder) return false;
    this.#writeLease = null;
    if (!this.#handOffWriteLease()) await this.#persistWriteLease();
    return true;
  }

  async #grantWriteLease(holder: string, ttl: number): Promise<{ granted: true; expiresAt: number }> {
    const expiresAt = Date.now() + ttl;
    this.#writeLease = { holder, expiresAt };
    this.#armWriteLeaseExpiry();
    await this.#persistWriteLease();
    return { granted: true, expiresAt };
  }

  // Gives a free or expired lease to the head of the queue. True if it did.
  #handOffWriteLease(): boolean {
    const lease = this.#writeLease;
    if (lease && lease.expiresAt > Date.now()) {
      this.#armWriteLeaseExpiry();
      return false;
    }
    const next = this.#writeLeaseWaiters.shift();
    if (!next) {
      this.#writeLease = null;
      return false;
    }
    clearTimeout(next.timer);
    void this.#grantWriteLease(next.holder, next.ttl).then(next.resolve);
    return true;
  }

  // While someone waits, wake at the holder's expiry so a dead holder's lease
  // passes on without anyone polling. Renewals push expiresAt out; the timer
  // re-checks and re-arms.
  #armWriteLeaseExpiry(): void {
    if (this.#writeLeaseExpiryTimer !== undefined) clearTimeout(this.#writeLeaseExpiryTimer);
    this.#writeLeaseExpiryTimer = undefined;
    const lease = this.#writeLease;
    if (!lease || this.#writeLeaseWaiters.length === 0) return;
    this.#writeLeaseExpiryTimer = setTimeout(
      () => {
        this.#writeLeaseExpiryTimer = undefined;
        this.#handOffWriteLease();
      },
      Math.max(lease.expiresAt - Date.now(), 0) + 5,
    );
  }

  #loadWriteLease(): Promise<void> {
    this.#writeLeaseLoaded ??= this.#state
      .get<{ holder: string; expiresAt: number }>(WRITE_LEASE_KEY)
      .then((stored) => {
        if (stored && !this.#writeLease && stored.expiresAt > Date.now()) this.#writeLease = stored;
      })
      .catch((e) => log.warn("write_lease_load_failed", { error: String(e) }));
    return this.#writeLeaseLoaded;
  }

  // Memory is authoritative; a failed persist only loses restart survival.
  async #persistWriteLease(): Promise<void> {
    try {
      if (this.#writeLease) await this.#state.put(WRITE_LEASE_KEY, this.#writeLease);
      else await this.#state.delete(WRITE_LEASE_KEY);
    } catch (e) {
      log.warn("write_lease_persist_failed", { error: String(e) });
    }
  }
}

const WRITE_LEASE_KEY = "write_lease";
const WRITE_LEASE_MIN_TTL_MS = 1_000;
const WRITE_LEASE_MAX_TTL_MS = 120_000;
const WRITE_LEASE_MAX_WAIT_MS = 120_000;
const clampMs = (v: number, min: number, max: number) => Math.min(Math.max(Number.isFinite(v) ? v : 0, min), max);

// The columns behind each sync API field that carries a field clock
// (docs/SYNC-API.md section 6), per kind: a server-side write that changes
// one stamps that field's clock, so an older queued app edit is superseded.
// Idempotency rows outlive any edit the app still holds (section 5.4).
const MUTATION_RETENTION_MS = 30 * 86_400_000;

// A step's `checked` is stamped with Graph's checkedDateTime when it's checked;
// anything else with now.
function stepClock(item: ChecklistItem): (field: string) => number {
  const now = Date.now();
  const checkedAt = item.isChecked && item.checkedDateTime ? Date.parse(item.checkedDateTime) : NaN;
  return (field) => (field === "checked" && !Number.isNaN(checkedAt) ? checkedAt : now);
}

// A theme value as stored: the string Substrate sent, or the JSON of anything
// else (the format is undocumented, so nothing is mapped or validated).
function rawAppearance(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
}

const CLOCKED: Record<string, { table: string; key: string; fields: Record<string, readonly string[]> }> = {
  task: {
    table: "tasks",
    key: "task_id",
    fields: {
      title: ["title"],
      body: ["body_content", "body_type"],
      status: ["status"],
      completed_at: ["completed_at"],
      importance: ["importance"],
      due: ["due_at"],
      start: ["start_at"],
      reminder: ["reminder_at", "is_reminder_on"],
      categories: ["categories_json"],
      recurrence: ["recurrence_json"],
    },
  },
  list: { table: "lists", key: "list_id", fields: { name: ["display_name"], sync: ["sync"] } },
  step: { table: "checklist_items", key: "item_id", fields: { title: ["display_name"], checked: ["is_checked"] } },
  link: { table: "linked_resources", key: "link_id", fields: { url: ["web_url"], title: ["display_name"] } },
};

// Every public method — the RPC surface the Cloudflare shell delegates and
// core callers use via ownerIndex(). bootstrap() is host lifecycle, not surface.
export type IndexCoreMethods = Pick<IndexCore, Exclude<keyof IndexCore, "bootstrap">>;

// Over Durable Object RPC every call is async, so callers see every method as
// returning a Promise — even ones that are synchronous in-process. Typing the
// surface this way keeps a Node caller from relying on a sync return value that
// would be a Promise on Cloudflare. alarm() is excluded: the host's scheduler
// invokes it, and a Durable Object stub does not expose it over RPC.
// Return values must stay structured-cloneable: on Cloudflare they cross DO RPC.
type Promisified<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
};
export type IndexBackendSurface = Promisified<Omit<IndexCoreMethods, "alarm">>;

// Wraps an IndexCore so every method call is followed by announceChanges():
// one check of the log's top seq per RPC, so a burst of writes inside one call
// sends one message. Both hosts route their RPC surface through it.
export function announcing(core: IndexCore): IndexCore {
  return new Proxy(core, {
    get(target, key) {
      const member: unknown = Reflect.get(target, key);
      if (typeof member !== "function" || key === "announceChanges" || key === "constructor") {
        return typeof member === "function" ? member.bind(target) : member;
      }
      return (...args: unknown[]) => {
        const after = () => {
          try {
            target.announceChanges();
          } catch (e) {
            log.warn("sync_announce_failed", { error: String(e) });
          }
        };
        let out: unknown;
        try {
          out = (member as (...a: unknown[]) => unknown).apply(target, args);
        } catch (e) {
          after();
          throw e;
        }
        if (out instanceof Promise) {
          return out.then(
            (v) => (after(), v),
            (e) => {
              after();
              throw e;
            },
          );
        }
        after();
        return out;
      };
    },
  });
}
