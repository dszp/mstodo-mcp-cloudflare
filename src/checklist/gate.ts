// Feature gate + derived config for the checklist-item cache (ROADMAP). Unlike
// subscriptions / My Day (ON unless "false"), this defaults OFF: it adds a
// one-time per-task backfill cost (Graph has no hasChecklist boolean and delta
// carries no expansions, so checklist contents are never free), so it's opt-in.
//
// NOT tied to ENABLE_TASK_SUBSCRIPTIONS: the change signal is $delta (always on
// the timer) — checklist edits bump the task's lastModifiedDateTime and ride the
// incremental feed, so the cache stays fresh with or without subscriptions.
// Subscriptions only lower latency; the two pair well but are independent.

/** Checklist cache is OFF by default; set ENABLE_CHECKLIST_CACHE="true" to enable. */
export function checklistCacheEnabled(env: Env): boolean {
  return String(env.ENABLE_CHECKLIST_CACHE ?? "false").toLowerCase() === "true";
}

// Max tasks whose checklist is (re)fetched per calm cycle. Small by default so
// the scan's Graph GETs stay well under the Workers free-tier subrequest ceiling
// even during a cold backfill; raise it on paid plans (1000-subrequest ceiling)
// to drain the backlog in fewer cycles. Mirrors MY_DAY_SCAN_MAX_FOLDERS_PER_CYCLE.
export const DEFAULT_CHECKLIST_SCAN_MAX_TASKS_PER_CYCLE = 8;

export function checklistScanMaxTasksPerCycle(env: Env): number {
  const n = Number(env.CHECKLIST_SCAN_MAX_TASKS_PER_CYCLE);
  return Number.isFinite(n) && n >= 1
    ? Math.floor(n)
    : DEFAULT_CHECKLIST_SCAN_MAX_TASKS_PER_CYCLE;
}
