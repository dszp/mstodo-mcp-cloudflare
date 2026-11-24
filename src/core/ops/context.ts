import { log } from "../log";
import type { AppEnv, IndexBackend } from "../ports";
import { GraphError, type GraphClient } from "../graph/client";
import type { SubstrateClient } from "../graph/substrate-client";
import { WriteLease, type WriteQueue } from "./write-lease";

// What every write op needs, built once per caller (one MCP tool call, one sync
// mutations request). Ops take Graph IDs: resolving aliases and display names
// (MCP) or sync IDs (the sync API) is the surface's job, before the op runs.
//
// Errors: an op returns err(reason, …) for the outcomes a caller acts on
// (task_not_found, list_not_found, invalid_date, …) and lets GraphError,
// SubstrateError, ReauthRequiredError and WriteBusyError propagate for the
// surface to map (MCP: withGraph / withSubstrate).
export interface OpsContext {
  env: AppEnv;
  graph: GraphClient;
  index: IndexBackend;
  // Built on demand. The My Day and manual-order ops need it and assume the
  // surface already checked ENABLE_MY_DAY; move_task tries it when My Day is
  // on and falls back to copy/delete when it fails.
  substrate: () => Promise<SubstrateClient>;
  // The Graph access token, for the attachment byte upload in move_task's
  // copy fallback (attachFile talks to the upload session URL directly).
  accessToken: () => Promise<string>;
  // The single write queue; every op runs inside writes.run(). A caller
  // holding the lease across several ops passes WriteLease.hold()'s queue.
  writes: WriteQueue;
}

export function opsContext(deps: Omit<OpsContext, "writes"> & { writes?: WriteQueue }): OpsContext {
  return { ...deps, writes: deps.writes ?? new WriteLease(deps.index) };
}

// Parse a GraphError.detail body for the inner error code. Graph emits
// { error: { code, message, innerError: { code, ... } } } on 4xx; the
// innerError code is the precise reason ("ErrorInvalidIdMalformed",
// "ErrorItemNotFound", etc.). Returns undefined if the detail is missing,
// not JSON, or doesn't carry an innerError.code — GraphClient truncates the
// body at 500 chars, so partial JSON is possible on very long responses.
export function getGraphInnerErrorCode(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  try {
    const obj = JSON.parse(detail) as { error?: { innerError?: { code?: unknown } } };
    const code = obj.error?.innerError?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

// Graph's two ways of saying "no such item": 404, or 400 with a malformed-id
// inner error (an id that can't exist).
export function isGraphNotFound(e: unknown): e is GraphError {
  return (
    e instanceof GraphError &&
    (e.status === 404 || (e.status === 400 && getGraphInnerErrorCode(e.detail) === "ErrorInvalidIdMalformed"))
  );
}

// The sync API's create path: the sid the app chose, recorded for the new
// Graph ID before the op writes the entity to the mirror, so the mirror never
// mints one of its own. A failure leaves applyBatch's adoptSid to fix it up.
export async function reserveSid(ctx: OpsContext, kind: "list" | "task" | "step" | "link", sid: string | undefined, graphId: string): Promise<void> {
  if (!sid) return;
  await bestEffort("index_reserve_sid_failed", { kind, graph_id: graphId }, () => ctx.index.reserveSid(kind, sid, graphId));
}

// Index write-through after a Graph write succeeded. The index serves the
// cached reads, so the write lands immediately — but a failure here must not
// fail the op: Graph already has the change and the next delta sync reconciles.
export async function bestEffort(event: string, fields: Record<string, unknown>, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log.warn(event, { ...fields, error: String(e) });
  }
}
