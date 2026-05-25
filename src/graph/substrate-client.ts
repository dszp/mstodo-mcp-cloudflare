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

// Lenient — the Substrate task carries many Outlook fields we don't care about.
// We only read Id (to map back to a Graph task id), Subject (display), and
// CommittedDay (the My Day toggle). passthrough() keeps the rest intact.
export const SubstrateTaskSchema = z
  .object({
    Id: z.string().optional(),
    Subject: z.string().optional(),
    CommittedDay: z.string().nullable().optional(),
    // PostponedDay == today suppresses a task from My Day even when CommittedDay
    // is set, so add_to_my_day clears it. Surfaced for confirmation.
    PostponedDay: z.string().nullable().optional(),
  })
  .passthrough();
export type SubstrateTask = z.infer<typeof SubstrateTaskSchema>;

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
