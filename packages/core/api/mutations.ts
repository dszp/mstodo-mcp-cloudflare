// POST /api/v1/sync/mutations (docs/SYNC-API.md section 5): the HTTP half of
// the mutation batch. packages/core/sync/mutations.ts owns validation, idempotency
// and conflicts; packages/core/sync/executor.ts owns the Graph side. This module
// reads the body, builds the ops context, holds the write lease and keeps the
// batch running if the client goes away.
import { loadIdentity } from "../auth/microsoft";
import { GraphClient } from "../graph/client";
import { SubstrateClient } from "../graph/substrate-client";
import { log } from "../log";
import { ownerIndex } from "../owner-index";
import { opsContext } from "../ops/context";
import { WriteBusyError, WriteLease } from "../ops/write-lease";
import type { AppEnv } from "../ports";
import { syncExecutor } from "../sync/executor";
import { applyBatch, BATCH_TIME_BUDGET_MS, parseBatch, type MutationResult } from "../sync/mutations";
import type { Props } from "../types";
import { json } from "./respond";

// 25 mutations with room for long titles and bodies; a larger body is not a
// batch this API sends.
export const MUTATIONS_MAX_BYTES = 256 * 1024;

// The host's ExecutionContext.waitUntil (Cloudflare), or the Node host's
// stand-in: work that must finish even if the response is never read.
export interface BackgroundWork {
  waitUntil(p: Promise<unknown>): void;
}

export async function syncMutations(
  req: Request,
  env: AppEnv,
  props: Partial<Props> | undefined,
  bg: BackgroundWork,
): Promise<Response> {
  const body = await readJson(req, MUTATIONS_MAX_BYTES);
  if (body === TOO_LARGE) return json({ error: "body_too_large", max: MUTATIONS_MAX_BYTES }, 413);
  if (body === BAD_JSON) return json({ error: "bad_json" }, 400);
  const batch = parseBatch(body);
  if (typeof batch === "string") return json({ error: "bad_batch", detail: batch }, 400);

  const principal = props?.principal ? `${props.principal.iss}|${props.principal.sub}` : (props?.user ?? "unknown");
  const index = ownerIndex(env);
  const tokens = {
    getAccessToken: () => index.getAccessToken(),
    forceRefresh: () => index.refreshToken(),
    reportClaimsChallenge: (claims: string) => index.markReauthRequired("claims_challenge", claims),
  };
  const graph = new GraphClient(tokens);
  const substrate = async () =>
    new SubstrateClient(
      {
        getSubstrateAccessToken: () => index.getSubstrateAccessToken(),
        forceSubstrateRefresh: () => index.forceSubstrateRefresh(),
        reportClaimsChallenge: tokens.reportClaimsChallenge,
      },
      (await loadIdentity(env))?.anchorMailbox ?? null,
    );

  // One lease for the whole batch (section 18.4): an MCP write or another
  // device's batch waits for it rather than interleaving between mutations.
  // The wait and the batch share one time budget from the request's start, so
  // a queued batch still answers inside a client timeout and finishes inside
  // waitUntil's grace after a disconnect.
  const started = Date.now();
  const lease = new WriteLease(index, { waitMs: BATCH_TIME_BUDGET_MS });
  const work = lease
    .hold((writes) => {
      const ctx = opsContext({ env, graph, index, substrate, accessToken: tokens.getAccessToken, writes });
      const budgetMs = Math.max(BATCH_TIME_BUDGET_MS - (Date.now() - started), 0);
      return applyBatch(index, syncExecutor(ctx), batch, principal, { budgetMs });
    })
    .then(
      (out) => out,
      async (e: unknown): Promise<{ cursor: string; results: MutationResult[] }> => {
        if (!(e instanceof WriteBusyError)) throw e;
        // Nothing ran: every mutation is retryable as it stands.
        return { cursor: await index.syncCursor(), results: batch.mutations.map(busy) };
      },
    );
  // A client that disconnects mid-batch must not stop it between a Graph write
  // and the idempotency row that records it: its retry would then repeat the
  // write. The batch runs to the end either way; the response waits for it too.
  bg.waitUntil(work.catch((e: unknown) => log.error("sync_mutations_failed", { error: e instanceof Error ? e.message : String(e) })));
  return json(await work);
}

function busy(raw: unknown): MutationResult {
  const id = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : "";
  return { id, status: "failed", error: "write_busy", retry: true };
}

export const TOO_LARGE = Symbol("too_large");
const BAD_JSON = Symbol("bad_json");

// The body as JSON, read at most `max` bytes.
async function readJson(req: Request, max: number): Promise<unknown> {
  const bytes = await readBytes(req, max);
  if (bytes === TOO_LARGE) return TOO_LARGE;
  if (bytes === null) return BAD_JSON;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return BAD_JSON;
  }
}

// The body's bytes, read at most `max`: a declared length over the cap is
// refused unread, and an undeclared one stops at the cap. null: no body.
export async function readBytes(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | typeof TOO_LARGE | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return TOO_LARGE;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return bytes;
}
