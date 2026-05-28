import { z } from "zod";
import { log } from "../log";

// Microsoft To Do "My Day" — thin client for the undocumented Substrate endpoint
// (https://substrate.office.com/todob2/api/v1/). My Day membership is driven by
// the `CommittedDay` field on a task, which Graph does not expose; the Substrate
// API does. This client is deliberately trivial: it owns NO token logic. The
// rotating refresh token is shared with Graph and the singleton TodoIndex DO is
// the sole refresher (see cache/index-do.ts getSubstrateAccessToken), so this
// client just asks the provider for a token, injects headers, and retries once
// on 401 by forcing a re-mint.
//
// folderId/taskId are the SAME Exchange item ids Graph returns for
// todoTaskList.id / todoTask.id — no translation. The Substrate task shape is
// the Outlook REST shape (PascalCase: Id, Subject, CommittedDay, …), distinct
// from Graph's camelCase todoTask, so we model it separately and leniently.

export interface SubstrateTokenProvider {
  // A valid EXO-audience (https://outlook.office.com) access token, minted on
  // demand. Throws "my_day_unavailable" if the EXO scope isn't consented.
  getSubstrateAccessToken(): Promise<string>;
  // Force a re-mint regardless of cache freshness. Called on a 401.
  forceSubstrateRefresh(): Promise<string>;
}

export class SubstrateError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "SubstrateError";
  }
}

const SUBSTRATE_HOST = "substrate.office.com";
const SUBSTRATE_BASE = `https://${SUBSTRATE_HOST}/todob2/api/v1`;

// Defense-in-depth: every request carries the owner's Bearer token, so pin the
// host before attaching it (mirrors GraphClient.assertGraphUrl).
export function assertSubstrateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SubstrateError(0, "substrate_url_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== SUBSTRATE_HOST) {
    throw new SubstrateError(
      0,
      "substrate_url_host_rejected",
      `${parsed.protocol}//${parsed.host}`,
    );
  }
}

// A DateTimeTimeZone-shaped value (Outlook REST `{ DateTime, TimeZone }`).
// Substrate has been seen to send either the object or a bare ISO string for
// these, and occasionally null — accept all three so a shape drift never fails
// the parse. The handler normalizes to a single ISO string downstream.
const DateTimeTimeZoneLike = z
  .union([
    z.object({ DateTime: z.string().optional(), TimeZone: z.string().optional() }).passthrough(),
    z.string(),
  ])
  .nullable();

// Lenient — the Substrate task carries many Outlook fields. We model the subset
// the My Day tools project (identity, My Day toggle, status/importance, dates,
// reminder, categories, body, order) plus passthrough() to keep the rest intact.
// Every added field is .optional() so a wrong/absent key yields `undefined`, not
// a parse failure — the to-do web client's exact casings aren't documented.
export const SubstrateTaskSchema = z
  .object({
    Id: z.string().optional(),
    Subject: z.string().optional(),
    CommittedDay: z.string().nullable().optional(),
    // PostponedDay == today suppresses a task from My Day even when CommittedDay
    // is set, so add_to_my_day clears it. Surfaced for confirmation.
    PostponedDay: z.string().nullable().optional(),
    // The owning folder. A cross-list move re-parents the item by PATCHing this
    // to the destination folder id; the response echoes it so the caller can
    // confirm the move actually took (move_task's reparent-confirmed check).
    ParentFolderId: z.string().optional(),
    // OrderDateTime drives manual (drag-to-reorder) list position — the same
    // field reparentTask passes through to preserve ordering. Higher = nearer
    // the top of the list in the To Do UI's manual sort.
    OrderDateTime: z.string().nullable().optional(),
    // My Day drag-to-reorder order. Distinct from OrderDateTime (list manual
    // order). Cached as committed_order; the read path sorts My Day by it.
    CommittedOrder: z.string().nullable().optional(),
    // Detail fields the My Day tools project. Status/Importance are free strings
    // (To Do sends e.g. "NotStarted"/"Completed", "Low"/"Normal"/"High") — we
    // don't pin the enum so an unseen value still rides through.
    Status: z.string().nullable().optional(),
    Importance: z.string().nullable().optional(),
    DueDateTime: DateTimeTimeZoneLike.optional(),
    StartDateTime: DateTimeTimeZoneLike.optional(),
    CompletedDateTime: DateTimeTimeZoneLike.optional(),
    ReminderDateTime: DateTimeTimeZoneLike.optional(),
    IsReminderOn: z.boolean().nullable().optional(),
    HasAttachments: z.boolean().nullable().optional(),
    Categories: z.array(z.string()).nullable().optional(),
    Body: z
      .object({ ContentType: z.string().optional(), Content: z.string().optional() })
      .passthrough()
      .nullable()
      .optional(),
    CreatedDateTime: z.string().nullable().optional(),
    LastModifiedDateTime: z.string().nullable().optional(),
  })
  .passthrough();
export type SubstrateTask = z.infer<typeof SubstrateTaskSchema>;

// Shape of the projected detail block shared by every My Day tool. Identity
// fields (list_id, task_id, title) are added by the caller — this is only the
// per-task detail that rides along on the same Substrate response.
export interface SubstrateTaskDetails {
  status: string | null;
  importance: string | null;
  due_date: string | null;
  start_date: string | null;
  completed_date: string | null;
  is_reminder_on: boolean | null;
  reminder_date: string | null;
  has_attachments: boolean | null;
  categories: string[];
  body_preview: string | null;
  created_date: string | null;
  last_modified_date: string | null;
  order_datetime: string | null;
  committed_order: string | null;
}

// Comparator for the To Do manual (drag-to-reorder) sort: OrderDateTime
// descending (higher = nearer the top), with null OrderDateTime sorting last.
// Shared by every surface that mirrors the app's manual order (the My Day
// aggregation, list_tasks_by_manual_order). String compare is sound because the
// app's OrderDateTime values are same-zone ISO 8601 (lexicographic == chrono).
export function compareOrderDateTimeDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}

// Normalize a DateTimeTimeZone-shaped value to a bare ISO string (or null).
function dtTzToIso(v: SubstrateTask["DueDateTime"]): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  return typeof v.DateTime === "string" ? v.DateTime : null;
}

// Date portion (YYYY-MM-DD) of an ISO-ish string.
function datePart(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

// First ~200 chars of the task body, with tags/whitespace flattened. To Do
// stores the note as HTML or text; we strip markup for a readable preview.
function bodyPreview(body: SubstrateTask["Body"]): string | null {
  const content = body && typeof body.Content === "string" ? body.Content : null;
  if (!content) return null;
  const text = content
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, 200) : null;
}

// Project the detail fields that ride along on every Substrate task response.
// Shared by list_my_day_tasks, add_to_my_day, and remove_from_my_day so the
// per-task shape stays identical across all three. Due/start are date-only
// (To Do treats them as calendar dates stored at UTC midnight); reminder,
// completed, created, and last-modified are kept as full timestamps.
export function projectSubstrateTaskDetails(t: SubstrateTask): SubstrateTaskDetails {
  return {
    status: t.Status ?? null,
    importance: t.Importance ?? null,
    due_date: datePart(dtTzToIso(t.DueDateTime)),
    start_date: datePart(dtTzToIso(t.StartDateTime)),
    completed_date: dtTzToIso(t.CompletedDateTime),
    is_reminder_on: t.IsReminderOn ?? null,
    reminder_date: dtTzToIso(t.ReminderDateTime),
    has_attachments: t.HasAttachments ?? null,
    categories: t.Categories ?? [],
    body_preview: bodyPreview(t.Body),
    created_date: t.CreatedDateTime ?? null,
    last_modified_date: t.LastModifiedDateTime ?? null,
    order_datetime: t.OrderDateTime ?? null,
    committed_order: t.CommittedOrder ?? null,
  };
}

// Extract the task array from a folder-tasks GET response without assuming a
// fixed envelope. Substrate's task fields are PascalCase, and across folders the
// collection has been seen as `value`, `Value`, or a bare array; empty folders
// can omit the array entirely. Pull whichever is present, then leniently parse
// each item — a single malformed entry is skipped, not fatal.
export function extractTasks(json: unknown): SubstrateTask[] {
  const raw: unknown = Array.isArray(json)
    ? json
    : isRecord(json)
      ? (json.value ?? json.Value ?? [])
      : [];
  if (!Array.isArray(raw)) return [];
  const out: SubstrateTask[] = [];
  for (const item of raw) {
    const parsed = SubstrateTaskSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const taskUrl = (folderId: string, taskId: string) =>
  `${SUBSTRATE_BASE}/taskfolders/${encodeURIComponent(folderId)}/tasks/${encodeURIComponent(taskId)}`;
const folderTasksUrl = (folderId: string) =>
  `${SUBSTRATE_BASE}/taskfolders/${encodeURIComponent(folderId)}/tasks`;

export class SubstrateClient {
  constructor(
    private readonly tokens: SubstrateTokenProvider,
    private readonly anchorMailbox: string | null,
  ) {}

  // PATCH a task. Used to set/clear CommittedDay (add/remove from My Day).
  // Returns the updated task so callers can confirm the round-trip.
  async patchTask(
    folderId: string,
    taskId: string,
    body: Record<string, unknown>,
  ): Promise<SubstrateTask> {
    const res = await this.#fetchWithRetry(taskUrl(folderId, taskId), "PATCH", JSON.stringify(body));
    const json = (await res.json()) as unknown;
    return SubstrateTaskSchema.parse(json);
  }

  // GET a single task. Used by move_task's copy/delete fallback to read the
  // source task's CommittedDay (My Day membership — not exposed by Graph) before
  // deleting the source, so it can be re-applied to the destination copy.
  async getTask(folderId: string, taskId: string): Promise<SubstrateTask> {
    const res = await this.#fetchWithRetry(taskUrl(folderId, taskId), "GET");
    const json = (await res.json()) as unknown;
    return SubstrateTaskSchema.parse(json);
  }

  // Lossless cross-list move: re-parent the SAME underlying item into another
  // folder in one call by PATCHing ParentFolderId to the destination. This is
  // exactly what the To Do web app's drag-and-drop issues — the destination
  // folder appears in BOTH the URL path and the body. Unlike a Graph
  // create/delete, the item rides along whole: checklist items, attachments, a
  // linked resource, and My Day (CommittedDay) all survive. The task's Id DOES
  // change (the new Id encodes the destination folder), so callers re-key any
  // cache from the returned task's Id. `orderDateTime` is the list-position
  // timestamp; pass the source value through to preserve manual ordering, or
  // omit it (the move works without it — the server keeps the existing value).
  async reparentTask(
    destFolderId: string,
    taskId: string,
    orderDateTime?: string,
  ): Promise<SubstrateTask> {
    const body: Record<string, unknown> = { ParentFolderId: destFolderId };
    if (orderDateTime !== undefined) body.OrderDateTime = orderDateTime;
    const res = await this.#fetchWithRetry(
      taskUrl(destFolderId, taskId),
      "PATCH",
      JSON.stringify(body),
    );
    const json = (await res.json()) as unknown;
    return SubstrateTaskSchema.parse(json);
  }

  // List a folder's tasks (unfiltered). The caller matches My Day membership
  // client-side on the CommittedDay date portion — substrate stores CommittedDay
  // as a datetime, so a server `$filter=CommittedDay eq '<bare date>'` wouldn't
  // match. Envelope shape varies across folders, so parsing is tolerant.
  async listFolderTasks(folderId: string): Promise<SubstrateTask[]> {
    const res = await this.#fetchWithRetry(folderTasksUrl(folderId), "GET");
    const json = (await res.json()) as unknown;
    return extractTasks(json);
  }

  async #fetchWithRetry(url: string, method: string, body?: string): Promise<Response> {
    assertSubstrateUrl(url);
    let retried401 = false;
    let retried429 = 0;
    let token = await this.tokens.getSubstrateAccessToken();
    while (true) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      };
      if (this.anchorMailbox) headers["x-anchormailbox"] = this.anchorMailbox;
      if (body !== undefined) headers["content-type"] = "application/json";

      const res = await fetch(url, { method, headers, body });
      if (res.status === 401 && !retried401) {
        retried401 = true;
        log.warn("substrate_401_refresh", { url: redactSubstrateUrl(url) });
        token = await this.tokens.forceSubstrateRefresh();
        continue;
      }
      // EXO throttles aggressively on MailboxConcurrency. Honor Retry-After
      // (clamped) and retry a bounded number of times before surfacing.
      if (res.status === 429 && retried429 < MAX_429_RETRIES) {
        retried429 += 1;
        const delayMs = parseRetryAfter(res.headers.get("retry-after"));
        log.warn("substrate_429_retry", {
          url: redactSubstrateUrl(url),
          delayMs,
          attempt: retried429,
        });
        await sleep(delayMs);
        continue;
      }
      if (!res.ok) {
        const detail = await safeText(res);
        throw new SubstrateError(res.status, `substrate_${res.status}`, detail);
      }
      return res;
    }
  }
}

const MAX_429_RETRIES = 2;
const RETRY_AFTER_CAP_MS = 20_000;

function parseRetryAfter(header: string | null): number {
  if (!header) return 2000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  }
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), RETRY_AFTER_CAP_MS));
  }
  return 2000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Drop the query string before logging (the $filter carries the user's task
// dates; keep it out of logs, consistent with GraphClient.redactUrl).
export function redactSubstrateUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "<unparseable-url>";
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
