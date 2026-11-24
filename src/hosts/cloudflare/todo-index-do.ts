import { DurableObject } from "cloudflare:workers";
import { IndexCore, announcing, type IndexCoreMethods } from "../../core/index/index-core";
import type { ChangeNotifier } from "../../core/ports";
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
    this.#core = announcing(
      new IndexCore({
        sql: ctx.storage.sql,
        transact: (fn) => ctx.storage.transactionSync(fn),
        state: ctx.storage,
        alarms: ctx.storage,
        env: appEnv(env),
        notifier: socketNotifier(ctx),
      }),
    );
    // A "ping" text frame is answered by the runtime without waking the
    // object, so idle sockets cost no duration (docs/SYNC-API.md section 7.1).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // Runs once per instance before any request is delivered.
    ctx.blockConcurrencyWhile(async () => this.#core.bootstrap());
  }

  // Push socket upgrade (docs/SYNC-API.md section 7.2). Reached only through
  // this object's stub: the Worker authenticates the request against the
  // /api/v1 resource first and passes what it verified in x-sync-* headers.
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const exp = Number(req.headers.get("x-sync-exp"));
    if (!Number.isFinite(exp) || exp <= Date.now()) return new Response("expired", { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const meta: SocketMeta = { exp: Math.min(exp, Date.now() + MAX_SOCKET_LIFETIME_MS), client: (req.headers.get("x-sync-client") ?? "").slice(0, 100) };
    server.serializeAttachment(meta);
    server.send(JSON.stringify({ type: "hello", cursor: this.#core.syncCursor() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // The protocol carries only pings, answered by the auto-response without
  // waking the object. Any other frame is a protocol violation; closing on it
  // stops a client from keeping the object awake.
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > MAX_CLIENT_FRAME) return ws.close(1009, "message too big");
    if (expired(ws)) return endForReauth(ws);
    ws.close(1008, "only ping is accepted");
  }

  webSocketClose(ws: WebSocket, code: number) {
    // Complete the close handshake (needed on older compatibility dates).
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
  }

  acquireWriteLease(...a: Parameters<IndexCore["acquireWriteLease"]>) { return this.#core.acquireWriteLease(...a); }
  alarm(...a: Parameters<IndexCore["alarm"]>) { return this.#core.alarm(...a); }
  announceChanges(...a: Parameters<IndexCore["announceChanges"]>) { return this.#core.announceChanges(...a); }
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
  moveTask(...a: Parameters<IndexCore["moveTask"]>) { return this.#core.moveTask(...a); }
  syncCursor(...a: Parameters<IndexCore["syncCursor"]>) { return this.#core.syncCursor(...a); }
  adoptSid(...a: Parameters<IndexCore["adoptSid"]>) { return this.#core.adoptSid(...a); }
  fieldClocks(...a: Parameters<IndexCore["fieldClocks"]>) { return this.#core.fieldClocks(...a); }
  mutationAbandon(...a: Parameters<IndexCore["mutationAbandon"]>) { return this.#core.mutationAbandon(...a); }
  mutationBegin(...a: Parameters<IndexCore["mutationBegin"]>) { return this.#core.mutationBegin(...a); }
  mutationFinish(...a: Parameters<IndexCore["mutationFinish"]>) { return this.#core.mutationFinish(...a); }
  pruneMutations(...a: Parameters<IndexCore["pruneMutations"]>) { return this.#core.pruneMutations(...a); }
  resolveSids(...a: Parameters<IndexCore["resolveSids"]>) { return this.#core.resolveSids(...a); }
  syncChanges(...a: Parameters<IndexCore["syncChanges"]>) { return this.#core.syncChanges(...a); }
  syncInfo(...a: Parameters<IndexCore["syncInfo"]>) { return this.#core.syncInfo(...a); }
  syncTask(...a: Parameters<IndexCore["syncTask"]>) { return this.#core.syncTask(...a); }
  syncTaskSids(...a: Parameters<IndexCore["syncTaskSids"]>) { return this.#core.syncTaskSids(...a); }
  onChangeNotification(...a: Parameters<IndexCore["onChangeNotification"]>) { return this.#core.onChangeNotification(...a); }
  onLifecycleEvent(...a: Parameters<IndexCore["onLifecycleEvent"]>) { return this.#core.onLifecycleEvent(...a); }
  putSubscription(...a: Parameters<IndexCore["putSubscription"]>) { return this.#core.putSubscription(...a); }
  query(...a: Parameters<IndexCore["query"]>) { return this.#core.query(...a); }
  queryMyDayForDate(...a: Parameters<IndexCore["queryMyDayForDate"]>) { return this.#core.queryMyDayForDate(...a); }
  reconcileSubscriptions(...a: Parameters<IndexCore["reconcileSubscriptions"]>) { return this.#core.reconcileSubscriptions(...a); }
  recreateSubscriptions(...a: Parameters<IndexCore["recreateSubscriptions"]>) { return this.#core.recreateSubscriptions(...a); }
  refreshToken(...a: Parameters<IndexCore["refreshToken"]>) { return this.#core.refreshToken(...a); }
  renewSubscriptions(...a: Parameters<IndexCore["renewSubscriptions"]>) { return this.#core.renewSubscriptions(...a); }
  replaceAttachments(...a: Parameters<IndexCore["replaceAttachments"]>) { return this.#core.replaceAttachments(...a); }
  replaceLinkedResources(...a: Parameters<IndexCore["replaceLinkedResources"]>) { return this.#core.replaceLinkedResources(...a); }
  replaceChecklistItems(...a: Parameters<IndexCore["replaceChecklistItems"]>) { return this.#core.replaceChecklistItems(...a); }
  releaseWriteLease(...a: Parameters<IndexCore["releaseWriteLease"]>) { return this.#core.releaseWriteLease(...a); }
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

// Socket lifetime: until the access token the client connected with expires,
// and never longer than this, so a revoked or changed grant can't keep a
// socket open indefinitely (section 18.7). The app reconnects with a fresh
// token after a reauth message.
const MAX_SOCKET_LIFETIME_MS = 24 * 3_600_000;
const MAX_CLIENT_FRAME = 1024;

interface SocketMeta {
  exp: number;
  client: string;
}

function expired(ws: WebSocket): boolean {
  const meta = ws.deserializeAttachment() as SocketMeta | null;
  return !meta || meta.exp <= Date.now();
}

function endForReauth(ws: WebSocket) {
  try {
    ws.send(JSON.stringify({ type: "reauth" }));
    ws.close(4001, "reauth");
  } catch {
    // already closed
  }
}

function socketNotifier(ctx: DurableObjectState): ChangeNotifier {
  return {
    announce(cursor) {
      const msg = JSON.stringify({ type: "changed", cursor });
      for (const ws of ctx.getWebSockets()) {
        if (expired(ws)) endForReauth(ws);
        else {
          try {
            ws.send(msg);
          } catch {
            // closing; the runtime drops it
          }
        }
      }
    },
    closeAll() {
      for (const ws of ctx.getWebSockets()) endForReauth(ws);
    },
    sweep() {
      for (const ws of ctx.getWebSockets()) if (expired(ws)) endForReauth(ws);
    },
  };
}
