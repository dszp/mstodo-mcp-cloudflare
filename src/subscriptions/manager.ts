import { z } from "zod";
import type { GraphClient } from "../graph/client";
import { SUBSCRIPTION_LIFETIME_MS } from "./gate";

// ROADMAP §4 — Graph-side subscription operations. Pure over an injected
// GraphClient (the TodoIndex singleton is the TokenProvider): no DO, no SQLite.
// Every call rides GraphClient, so the host-pin + 401/429 retry discipline and
// the "only TodoIndex spends the token" invariant hold automatically.

const SUBSCRIPTIONS_URL = "https://graph.microsoft.com/v1.0/subscriptions";
const subscriptionUrl = (id: string) =>
  `https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(id)}`;

// We always want create + update + delete of tasks in the subscribed list.
const CHANGE_TYPE = "created,updated,deleted";

// Graph's subscription object (the fields we use). passthrough() keeps unknowns.
export const GraphSubscriptionSchema = z
  .object({
    id: z.string(),
    resource: z.string().optional(),
    notificationUrl: z.string().optional(),
    expirationDateTime: z.string(),
    clientState: z.string().nullish(),
  })
  .passthrough();
export type GraphSubscription = z.infer<typeof GraphSubscriptionSchema>;

const SubscriptionListSchema = z
  .object({
    value: z.array(GraphSubscriptionSchema),
    "@odata.nextLink": z.string().optional(),
  })
  .passthrough();

// A single-user app holds roughly one subscription per list (tens), so the
// /subscriptions roster fits in one or two pages. This cap is a runaway guard,
// not a real page budget: hitting it means the roster paginated far past what
// we expect, so we'd rather throw (→ record-only fallback in reconcile) than
// act on a roster we can't prove complete.
const MAX_SUBSCRIPTION_PAGES = 20;

// 32 bytes of CSPRNG → base64url. ~43 chars, well under Graph's 128-char
// clientState cap. The secret echoed back in every notification.
export function newClientState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ISO expiry ~70h out (safely under the 4,230-min todoTask cap). `now` is
// injectable for deterministic tests.
export function desiredExpiration(now: number = Date.now()): string {
  return new Date(now + SUBSCRIPTION_LIFETIME_MS).toISOString();
}

export async function createSubscription(
  graph: GraphClient,
  opts: {
    listId: string;
    notificationUrl: string;
    clientState: string;
    expirationDateTime: string;
  },
): Promise<{ id: string; expirationDateTime: string }> {
  const sub = await graph.postJson(
    SUBSCRIPTIONS_URL,
    {
      changeType: CHANGE_TYPE,
      notificationUrl: opts.notificationUrl,
      resource: `/me/todo/lists/${opts.listId}/tasks`,
      expirationDateTime: opts.expirationDateTime,
      clientState: opts.clientState,
    },
    GraphSubscriptionSchema,
  );
  return { id: sub.id, expirationDateTime: sub.expirationDateTime };
}

export async function renewSubscription(
  graph: GraphClient,
  subscriptionId: string,
  expirationDateTime: string,
): Promise<{ expirationDateTime: string }> {
  const sub = await graph.patchJson(
    subscriptionUrl(subscriptionId),
    { expirationDateTime },
    GraphSubscriptionSchema,
  );
  return { expirationDateTime: sub.expirationDateTime };
}

export async function deleteSubscription(graph: GraphClient, subscriptionId: string): Promise<void> {
  await graph.deleteResource(subscriptionUrl(subscriptionId));
}

// Fetch Graph's full subscription roster, following @odata.nextLink to the
// terminal page. Reconcile treats this list as ground truth, so it MUST be
// complete: a partial roster would misclassify live subscriptions as dead
// (dropped + recreated) and their originals as orphans (torn down), re-creating
// the very drift the cross-check exists to heal. If pagination runs past the
// runaway cap we throw rather than return a truncated list — the caller then
// degrades to the safe record-only fallback. Host-pin is inherited: every
// getJson (including the nextLink follows) routes through GraphClient →
// assertGraphUrl.
export async function listGraphSubscriptions(graph: GraphClient): Promise<GraphSubscription[]> {
  const out: GraphSubscription[] = [];
  let next: string | undefined = SUBSCRIPTIONS_URL;
  let pages = 0;
  while (next) {
    if (pages++ >= MAX_SUBSCRIPTION_PAGES) {
      throw new Error(
        `listGraphSubscriptions exceeded ${MAX_SUBSCRIPTION_PAGES} pages; refusing to act on a possibly truncated roster`,
      );
    }
    const res: z.infer<typeof SubscriptionListSchema> = await graph.getJson(
      next,
      SubscriptionListSchema,
    );
    out.push(...res.value);
    next = res["@odata.nextLink"];
  }
  return out;
}

// Extract the todoTaskList id from a subscription resource path like
// "/me/todo/lists/{id}/tasks" (tolerant of a missing leading slash or casing).
// Returns null when the resource isn't a todoTask-tasks subscription.
export function parseTodoListId(resource: string | undefined): string | null {
  if (!resource) return null;
  const m = resource.match(/todo\/lists\/([^/]+)\/tasks/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    // Malformed %-escape (URIError) — fall back to the raw capture rather than
    // throwing, so one bad resource string can't abort the whole cross-check.
    return m[1];
  }
}
