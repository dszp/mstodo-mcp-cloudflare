import { DurableObject } from "cloudflare:workers";
import { IndexCore, type IndexCoreMethods } from "../../core/index/index-core";
import { appEnv } from "./env";

// Re-exported for existing importers; the implementations live in core.
export { isScanDue, selectDueScanLists } from "../../core/index/index-core";

// Cloudflare host shell for the singleton index. All logic — the SQLite cache,
// delta sync, and the sole-refresher token chain — lives in IndexCore over
// injected ports; this class only adapts DurableObjectState to those ports and
// exposes IndexCore's public methods as the DO's RPC surface (generated, one
// delegate per public method).
export class TodoIndex extends DurableObject<Env> implements IndexCoreMethods {
  #core: IndexCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#core = new IndexCore({ sql: ctx.storage.sql, state: ctx.storage, alarms: ctx.storage, env: appEnv(env) });
    // Runs once per instance before any request is delivered.
    ctx.blockConcurrencyWhile(async () => this.#core.bootstrap());
  }

  alarm(...a: Parameters<IndexCore["alarm"]>) { return this.#core.alarm(...a); }
  authState(...a: Parameters<IndexCore["authState"]>) { return this.#core.authState(...a); }
  clearChecklistItems(...a: Parameters<IndexCore["clearChecklistItems"]>) { return this.#core.clearChecklistItems(...a); }
  clearMyDayFields(...a: Parameters<IndexCore["clearMyDayFields"]>) { return this.#core.clearMyDayFields(...a); }
  clearReauth(...a: Parameters<IndexCore["clearReauth"]>) { return this.#core.clearReauth(...a); }
  deleteChecklistItem(...a: Parameters<IndexCore["deleteChecklistItem"]>) { return this.#core.deleteChecklistItem(...a); }
  deleteList(...a: Parameters<IndexCore["deleteList"]>) { return this.#core.deleteList(...a); }
  deleteSubscriptionRecord(...a: Parameters<IndexCore["deleteSubscriptionRecord"]>) { return this.#core.deleteSubscriptionRecord(...a); }
  deleteTask(...a: Parameters<IndexCore["deleteTask"]>) { return this.#core.deleteTask(...a); }
  ensureSyncing(...a: Parameters<IndexCore["ensureSyncing"]>) { return this.#core.ensureSyncing(...a); }
  findListForTask(...a: Parameters<IndexCore["findListForTask"]>) { return this.#core.findListForTask(...a); }
  findSubscription(...a: Parameters<IndexCore["findSubscription"]>) { return this.#core.findSubscription(...a); }
  forceRefresh(...a: Parameters<IndexCore["forceRefresh"]>) { return this.#core.forceRefresh(...a); }
  forceSubstrateRefresh(...a: Parameters<IndexCore["forceSubstrateRefresh"]>) { return this.#core.forceSubstrateRefresh(...a); }
  getAccessToken(...a: Parameters<IndexCore["getAccessToken"]>) { return this.#core.getAccessToken(...a); }
  getChecklistItems(...a: Parameters<IndexCore["getChecklistItems"]>) { return this.#core.getChecklistItems(...a); }
  getList(...a: Parameters<IndexCore["getList"]>) { return this.#core.getList(...a); }
  getMyDayFields(...a: Parameters<IndexCore["getMyDayFields"]>) { return this.#core.getMyDayFields(...a); }
  getMyDayScanState(...a: Parameters<IndexCore["getMyDayScanState"]>) { return this.#core.getMyDayScanState(...a); }
  getSubscriptions(...a: Parameters<IndexCore["getSubscriptions"]>) { return this.#core.getSubscriptions(...a); }
  getSubstrateAccessToken(...a: Parameters<IndexCore["getSubstrateAccessToken"]>) { return this.#core.getSubstrateAccessToken(...a); }
  getTaskMeta(...a: Parameters<IndexCore["getTaskMeta"]>) { return this.#core.getTaskMeta(...a); }
  isListSynced(...a: Parameters<IndexCore["isListSynced"]>) { return this.#core.isListSynced(...a); }
  listLists(...a: Parameters<IndexCore["listLists"]>) { return this.#core.listLists(...a); }
  markChecklistDirty(...a: Parameters<IndexCore["markChecklistDirty"]>) { return this.#core.markChecklistDirty(...a); }
  markMyDayUnavailable(...a: Parameters<IndexCore["markMyDayUnavailable"]>) { return this.#core.markMyDayUnavailable(...a); }
  markReauthRequired(...a: Parameters<IndexCore["markReauthRequired"]>) { return this.#core.markReauthRequired(...a); }
  onChangeNotification(...a: Parameters<IndexCore["onChangeNotification"]>) { return this.#core.onChangeNotification(...a); }
  onLifecycleEvent(...a: Parameters<IndexCore["onLifecycleEvent"]>) { return this.#core.onLifecycleEvent(...a); }
  putSubscription(...a: Parameters<IndexCore["putSubscription"]>) { return this.#core.putSubscription(...a); }
  query(...a: Parameters<IndexCore["query"]>) { return this.#core.query(...a); }
  queryMyDayForDate(...a: Parameters<IndexCore["queryMyDayForDate"]>) { return this.#core.queryMyDayForDate(...a); }
  reconcileSubscriptions(...a: Parameters<IndexCore["reconcileSubscriptions"]>) { return this.#core.reconcileSubscriptions(...a); }
  recreateSubscriptions(...a: Parameters<IndexCore["recreateSubscriptions"]>) { return this.#core.recreateSubscriptions(...a); }
  refreshToken(...a: Parameters<IndexCore["refreshToken"]>) { return this.#core.refreshToken(...a); }
  renewSubscriptions(...a: Parameters<IndexCore["renewSubscriptions"]>) { return this.#core.renewSubscriptions(...a); }
  replaceChecklistItems(...a: Parameters<IndexCore["replaceChecklistItems"]>) { return this.#core.replaceChecklistItems(...a); }
  reportClaimsChallenge(...a: Parameters<IndexCore["reportClaimsChallenge"]>) { return this.#core.reportClaimsChallenge(...a); }
  resetIdentity(...a: Parameters<IndexCore["resetIdentity"]>) { return this.#core.resetIdentity(...a); }
  resync(...a: Parameters<IndexCore["resync"]>) { return this.#core.resync(...a); }
  revokeAllGrants(...a: Parameters<IndexCore["revokeAllGrants"]>) { return this.#core.revokeAllGrants(...a); }
  runSyncCycle(...a: Parameters<IndexCore["runSyncCycle"]>) { return this.#core.runSyncCycle(...a); }
  search(...a: Parameters<IndexCore["search"]>) { return this.#core.search(...a); }
  searchChecklistItems(...a: Parameters<IndexCore["searchChecklistItems"]>) { return this.#core.searchChecklistItems(...a); }
  selectDueChecklistTasks(...a: Parameters<IndexCore["selectDueChecklistTasks"]>) { return this.#core.selectDueChecklistTasks(...a); }
  setTaskFlags(...a: Parameters<IndexCore["setTaskFlags"]>) { return this.#core.setTaskFlags(...a); }
  subscriptionStatus(...a: Parameters<IndexCore["subscriptionStatus"]>) { return this.#core.subscriptionStatus(...a); }
  syncStatus(...a: Parameters<IndexCore["syncStatus"]>) { return this.#core.syncStatus(...a); }
  updateMyDayFields(...a: Parameters<IndexCore["updateMyDayFields"]>) { return this.#core.updateMyDayFields(...a); }
  upsertChecklistItem(...a: Parameters<IndexCore["upsertChecklistItem"]>) { return this.#core.upsertChecklistItem(...a); }
  upsertList(...a: Parameters<IndexCore["upsertList"]>) { return this.#core.upsertList(...a); }
  upsertTask(...a: Parameters<IndexCore["upsertTask"]>) { return this.#core.upsertTask(...a); }
}
