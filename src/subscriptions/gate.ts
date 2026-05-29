// Feature gate + derived config for Graph change-notification subscriptions
// (ROADMAP §4). Mirrors the downloadLinksEnabled pattern: ON unless the var is
// the literal string "false". Subscriptions ride the existing delegated
// Tasks.ReadWrite scope (no new consent), so this is a preference, not a
// permission wall.

/** Subscriptions are ON by default; set ENABLE_TASK_SUBSCRIPTIONS="false" to disable. */
export function taskSubscriptionsEnabled(env: Env): boolean {
  return String(env.ENABLE_TASK_SUBSCRIPTIONS ?? "true").toLowerCase() !== "false";
}

/**
 * The public notificationUrl Graph POSTs to, derived from SERVICE_BASE_URL.
 * Returns null when SERVICE_BASE_URL is missing or not https (Graph requires an
 * https notificationUrl), so the caller can skip subscription creation cleanly.
 */
export function webhookUrl(env: Env): string | null {
  const base = (env.SERVICE_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  return `${base}/webhook`;
}

// todoTask subscription max lifetime is 4,230 min (~2.94 days). Ask for a value
// safely under the cap; Graph rejects > max and clamps < 45 min up to 45 min.
export const SUBSCRIPTION_LIFETIME_MS = 4_200 * 60_000; // 70 hours

// Renew once a subscription has less than this remaining. The cycle runs far
// more often than this margin, so renewal is reliable even if
// DELTA_SYNC_INTERVAL_MIN is lengthened.
export const SUBSCRIPTION_RENEW_MARGIN_MS = 12 * 60 * 60_000; // 12 hours

// Free-tier safety: cap subscription create/renew/delete Graph calls per cycle
// (each create also incurs Graph's synchronous validation round-trip to our
// /webhook). Oldest-/unsubscribed-first rotation covers a large roster over a
// few cycles. Same shape as MY_DAY_SCAN_MAX_FOLDERS_PER_CYCLE.
//
// BUDGET ENVELOPE (free-tier ceiling = 50 subrequests/request). A calm cycle
// already spends: delta pages (≤ ROSTER_MAX_PAGES 10 + MAX_PAGES_PER_CYCLE 30 +
// 1 refresh = 41) + My Day scan (≤ MY_DAY_SCAN_MAX_FOLDERS_PER_CYCLE + 1 mint).
// Subscription ops add on top of that, so the three must fit together. With the
// free-tier My Day default (6 → 7 incl. mint) that leaves ≈2 for subscriptions.
// STEADY STATE is ~0 subscription ops (roster covered, nothing near expiry), so
// this cap only bounds the transient initial ramp; keep it small on free tier
// (2) and raise it on paid (1000 ceiling) where MY_DAY_SCAN_* is already raised.
// reconcile() and renewSubscriptions() each enforce this cap independently; in a
// worst-case ramp cycle both could spend it, so size it as "per maintenance
// pass" headroom, not a hard combined guarantee.
//
// Tunable via the MAX_SUBSCRIPTION_OPS_PER_CYCLE var (mirrors the My Day scan
// caps). FREE PLAN: leave at 2. PAID PLAN (1000-subrequest ceiling): raise it —
// up to your list count — for faster initial coverage and renewal headroom.
export const DEFAULT_MAX_SUBSCRIPTION_OPS_PER_CYCLE = 2;

export function maxSubscriptionOpsPerCycle(env: Env): number {
  const n = Number(env.MAX_SUBSCRIPTION_OPS_PER_CYCLE);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_SUBSCRIPTION_OPS_PER_CYCLE;
}
