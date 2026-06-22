import { z } from "zod";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Props } from "../types";
import { errResponse, instrument, type McpResponse } from "../observability/instrument";
import { log } from "../log";
import { fetchMe, loadIdentity, loadTokens, myDayEnabled, REFRESH_SKEW_MS } from "../auth/microsoft";
import { GraphClient, GraphError, type TokenProvider } from "../graph/client";
import {
  SubstrateClient,
  SubstrateError,
  projectSubstrateTaskDetails,
  compareOrderDateTimeDesc,
} from "../graph/substrate-client";
import {
  OWNER_DO_NAME,
  epochToIso,
  rowToList,
  rowToSummary,
  type ChecklistSearchRow,
  type ListRow,
  type TaskRow,
} from "../cache/sql";
import type { TodoIndex } from "../cache/index-do";
import { mapPool } from "../graph/concurrency";
import { VERSION } from "../version";
import { parseDateInput } from "../util/dates";
import {
  createDownloadCapability,
  createUploadCapability,
  DEFAULT_MAX_FILES,
  downloadLinksEnabled,
  MAX_DOWNLOAD_TTL_SECONDS,
  MAX_FILES_CAP,
  type DownloadCapabilityScope,
  type UploadCapabilityScope,
} from "../upload/tokens";
import {
  AttachmentSchema,
  ChecklistItemSchema,
  LinkedResourceSchema,
  PatternedRecurrenceSchema,
  TaskFileAttachmentSchema,
  TodoTaskListSchema,
  TodoTaskSchema,
  type Attachment,
  type ChecklistItem,
  type TodoTask,
  type TodoTaskList,
} from "../graph/types";
import { loadAttachmentConfig, loadLinkRules, loadListsConfig, storeAttachmentConfig, storeLinkRules, storeListsConfig } from "../config/loader";
import { runLinkRules, type LinkRuleMatch } from "../config/link-rules-engine";
import { AttachmentConfigSchema, LinkRuleSchema, LinkRulesConfigSchema, ListPatternSchema, ListsConfigSchema } from "../config/schemas";
import { classifyList, pinClassifications, stripEmoji } from "../config/classifier";
import { resolveListId } from "../config/aliases";
import { resolveListScope, resolveStatusFilter } from "../config/query-scope";
import { attachFile, bytesFromBase64, PER_FILE_MAX_BYTES } from "../upload/graph-upload";
import { buildMoveCopyBody, decideAfterReparentFailure, isReparentConfirmed } from "./move-task";
import { computeReorder, msToOrder, orderToMs, type ReorderSpec } from "./reorder";
import { collectMyDayNeighborOrders, findMyDayRowById } from "./my-day-order";
import type { SubstrateTask } from "../graph/substrate-client";
import {
  createChecklistItem,
  createLinkedResource,
  getFileAttachment,
  listAttachments,
} from "../graph/todo-resources";
import { checklistCacheEnabled } from "../checklist/gate";

const LISTS_URL = "https://graph.microsoft.com/v1.0/me/todo/lists";

// My Day CommittedDay is a local calendar date (YYYY-MM-DD), not UTC. The Worker
// runs UTC, so when the caller omits `date` we compute "today" in the Worker's
// configured TIMEZONE (an IANA name). en-CA formats as YYYY-MM-DD.
const MY_DAY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function todayInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Date portion (YYYY-MM-DD) of a CommittedDay value the Substrate API returns —
// it echoes a full ISO datetime (e.g. "2026-05-25T00:00:00Z"), so membership
// checks compare on the date, not the raw string.
function committedDatePart(committed: string | null | undefined): string | null {
  return committed ? committed.slice(0, 10) : null;
}

// Wrap a plain JSON result object in the MCP text-content envelope. The codebase
// builds this inline in most handlers; move_task has several return points, so
// it shares one helper.
function jsonResult(result: Record<string, unknown>): McpResponse {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

// `etag_304` was removed in Phase 2 step 10 — step 9 smoke confirmed
// /me/todo/lists doesn't emit a collection-level ETag, so the 304 path
// for lists:all is dead code. Per-resource ETags ride on individual
// TodoTaskList items via @odata.etag passthrough and remain usable for
// future per-list conditional GETs.
// Where a roster/list read was served from: the DO index (authoritative) or a
// cold live-Graph enumerate while the index is still warming.
type ListsSource = "index" | "graph_cold";

// Strip @odata.* annotations from the public surface — the LLM only cares about
// the user-facing fields. Shared by list_lists and get_list response builders.
function summarizeList(l: TodoTaskList) {
  return {
    id: l.id,
    displayName: l.displayName,
    isOwner: l.isOwner,
    isShared: l.isShared,
    wellknownListName: l.wellknownListName,
  };
}

function listResponse(args: { list: TodoTaskList; source: ListsSource }): McpResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          source: args.source,
          list: summarizeList(args.list),
        }),
      },
    ],
  };
}

// Public-surface task shape — strips @odata.* annotations and the body field
// (potentially large; available via get_task in step 8). Date/time fields are
// returned as Graph emitted them: createdDateTime/lastModifiedDateTime as
// plain ISO strings; dueDateTime/etc. as the nested { dateTime, timeZone }
// objects per the Phase 0.5b findings.
function summarizeTask(t: TodoTask) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    importance: t.importance,
    isReminderOn: t.isReminderOn,
    hasAttachments: t.hasAttachments,
    createdDateTime: t.createdDateTime,
    lastModifiedDateTime: t.lastModifiedDateTime,
    dueDateTime: t.dueDateTime,
    reminderDateTime: t.reminderDateTime,
    startDateTime: t.startDateTime,
    completedDateTime: t.completedDateTime,
    categories: t.categories,
  };
}

// `tasks` are already-summarized objects (rowToSummary for the DO path,
// summarizeTask for the cold live-Graph page). `source` marks which served it.
function tasksResponse(args: {
  list_id: string;
  tasks: unknown[];
  next_cursor: string | undefined;
  source: ListsSource;
}): McpResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          list_id: args.list_id,
          source: args.source,
          count: args.tasks.length,
          // Present only when more pages exist; pass back as `cursor` to
          // list_tasks to resume. Absent on the cold (graph_cold) path.
          next_cursor: args.next_cursor,
          tasks: args.tasks,
        }),
      },
    ],
  };
}

// Detailed task shape — get_task's response. Returns the body + every
// expansion (checklistItems, linkedResources, attachments) plus recurrence
// and bodyLastModifiedDateTime, none of which list_tasks's summarizeTask
// includes. Strips @odata.etag (cache concern); all other passthrough
// extras from TodoTaskSchema are dropped by virtue of explicit selection.
function detailedTask(t: TodoTask) {
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    bodyLastModifiedDateTime: t.bodyLastModifiedDateTime,
    status: t.status,
    importance: t.importance,
    isReminderOn: t.isReminderOn,
    hasAttachments: t.hasAttachments,
    categories: t.categories,
    createdDateTime: t.createdDateTime,
    lastModifiedDateTime: t.lastModifiedDateTime,
    completedDateTime: t.completedDateTime,
    dueDateTime: t.dueDateTime,
    reminderDateTime: t.reminderDateTime,
    startDateTime: t.startDateTime,
    recurrence: t.recurrence,
    // Inline expansions — only present when Graph honored $expand. Phase 2
    // requests all three in one call; step 9 smoke confirms support.
    checklistItems: t.checklistItems,
    linkedResources: t.linkedResources,
    attachments: t.attachments,
  };
}

function taskResponse(args: {
  task: TodoTask;
  list_id: string;
  my_day?: { committed_day: string | null; committed_order: string | null } | null;
}): McpResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          list_id: args.list_id,
          task: detailedTask(args.task),
          // Present only when include_my_day was requested. `null` = requested but
          // the task isn't in the cache / My Day is off (unknown); an object with
          // null fields = indexed but not on My Day.
          ...(args.my_day !== undefined ? { my_day: args.my_day } : {}),
        }),
      },
    ],
  };
}

// Response envelope for reorder_my_day_task, mirroring reorder_task's shape on
// the Substrate plane: identity + position + the projected task detail, echoing
// the value we PATCHed if Substrate omits it from the response.
function reorderMyDayResponse(args: {
  list_id: string;
  task_id: string;
  date: string;
  position: string;
  task: SubstrateTask;
  newOrder: string;
}): McpResponse {
  const { list_id, task_id, date, position, task, newOrder } = args;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          list_id,
          task_id,
          date,
          position,
          title: task.Subject ?? null,
          ...projectSubstrateTaskDetails(task),
          committed_day: committedDatePart(task.CommittedDay),
          // Echo the value we PATCHed if the response omits it.
          committed_order: task.CommittedOrder ?? newOrder,
        }),
      },
    ],
  };
}

// Cross-list query/search/aggregation response envelope. `tasks` are DO rows
// mapped through rowToSummary; `source` is always "index" (these tools read the
// DO directly — a cold index returns an empty page and best-effort warms).
function indexTasksResponse(args: {
  rows: TaskRow[];
  next_cursor?: string;
  extra?: Record<string, unknown>;
}): McpResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          source: "index",
          count: args.rows.length,
          ...(args.extra ?? {}),
          ...(args.next_cursor !== undefined ? { next_cursor: args.next_cursor } : {}),
          tasks: args.rows.map(rowToSummary),
        }),
      },
    ],
  };
}

// search_checklist_items envelope: flat matched rows (already ordered by the DO)
// grouped by their parent task, first-seen order preserved. `count` is the item
// count; `tasks` carries each task's matched items with epoch→ISO timestamps.
function checklistItemsResponse(
  rows: ChecklistSearchRow[],
  extra: { query?: string; pending_only: boolean },
): McpResponse {
  const byTask = new Map<
    string,
    {
      task_id: string;
      list_id: string;
      title: string;
      status: string;
      items: Array<{
        item_id: string;
        display_name: string | null;
        is_checked: boolean;
        created_at?: string;
        checked_at?: string;
      }>;
    }
  >();
  for (const r of rows) {
    let g = byTask.get(r.task_id);
    if (!g) {
      g = {
        task_id: r.task_id,
        list_id: r.list_id,
        title: r.task_title,
        status: r.task_status,
        items: [],
      };
      byTask.set(r.task_id, g);
    }
    g.items.push({
      item_id: r.item_id,
      display_name: r.display_name,
      is_checked: !!r.is_checked,
      created_at: epochToIso(r.created_at),
      checked_at: epochToIso(r.checked_at),
    });
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          source: "index",
          count: rows.length,
          pending_only: extra.pending_only,
          ...(extra.query !== undefined ? { query: extra.query } : {}),
          tasks: [...byTask.values()],
        }),
      },
    ],
  };
}

// Inline attachment cap — raw payload size (before base64 encoding). Empirically
// confirmed in Phase 0.5b smoke: Graph rejected above 3072 KiB. Phase 15 config
// (config:attachments) will make this configurable; this constant is the hard floor.
const MAX_INLINE_ATTACHMENT_BYTES = 3072 * 1024;

// Parse a GraphError.detail body for the inner error code. Graph emits
// { error: { code, message, innerError: { code, ... } } } on 4xx; the
// innerError code is the precise reason ("ErrorInvalidIdMalformed",
// "ErrorItemNotFound", etc.). Returns undefined if the detail is missing,
// not JSON, or doesn't carry an innerError.code — GraphClient truncates the
// body at 500 chars, so partial JSON is possible on very long responses.
function getGraphInnerErrorCode(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  try {
    const obj = JSON.parse(detail) as { error?: { innerError?: { code?: unknown } } };
    const code = obj.error?.innerError?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

export class MSToDoMCP extends McpAgent<Env, never, Props> implements TokenProvider {
  server = new McpServer({ name: "mstodo-mcp", version: VERSION });

  async init() {
    this.server.registerTool(
      "whoami",
      {
        description:
          "Return the Microsoft identity (displayName, mail, userPrincipalName) of the authenticated owner. Smoke test for the OAuth + Graph integration.",
        inputSchema: {},
      },
      async (): Promise<McpResponse> =>
        instrument("whoami", async () => {
          // Pre-flight: distinguish "never authorized" (errResponse, friendly
          // hint) from "tokens present but Graph call failed" (graph_me_failed).
          // getAccessToken() would also throw on no-auth, but mapping that
          // throw back to a specific MCP response is more code than one extra
          // cheap KV read.
          const stored = await loadTokens(this.env);
          if (!stored) {
            return errResponse("not_authenticated", {
              hint: "Visit /authorize via the Claude.ai MCP connector to sign in to Microsoft.",
            });
          }
          try {
            const token = await this.getAccessToken();
            const me = await fetchMe(token);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    id: me.id,
                    displayName: me.displayName,
                    mail: me.mail,
                    userPrincipalName: me.userPrincipalName,
                  }),
                },
              ],
            };
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return errResponse("graph_me_failed", { message });
          }
        }),
    );

    this.server.registerTool(
      "list_lists",
      {
        description:
          "Return the owner's Microsoft To Do task lists (id, displayName, isOwner, isShared, wellknownListName, type). " +
          "Each list includes a 'type' field (todo | reference | excluded | unclassified) when classification patterns are configured. " +
          "Pass 'type' to filter to a specific class. " +
          "Served from the TodoIndex roster (source: 'index'); falls back to a live Graph enumerate (source: 'graph_cold') while the index is warming.",
        inputSchema: {
          type: z
            .enum(["todo", "reference", "excluded", "unclassified"])
            .optional()
            .describe(
              "When provided, return only lists matching this classification. " +
              "Requires list classification patterns to be configured via set_list_config.",
            ),
        },
      },
      async ({ type: typeFilter }): Promise<McpResponse> =>
        this.withGraph("list_lists", async (graph) => {
          const { lists, source } = await this.getRoster(graph);
          let config = await loadListsConfig(this.env);

          // Pin current name-classifications to immutable list IDs so a later
          // rename can't change a list's class. One-time per list; once every
          // matched list is pinned this writes nothing (added === 0).
          if (config.patterns.length > 0) {
            const { overrides, added } = pinClassifications(
              lists.map((l) => ({ list_id: l.id, display_name: l.displayName ?? null })),
              config,
            );
            if (added > 0) {
              config = { ...config, overrides };
              await storeListsConfig(this.env, config).catch((e) =>
                log.warn("list_pin_persist_failed", { error: String(e) }),
              );
            }
          }

          // Annotate when any classification exists (patterns OR manual pins).
          const hasClass =
            config.patterns.length > 0 || Object.keys(config.overrides).length > 0;
          const annotated = lists.map((l) => ({
            ...summarizeList(l),
            ...(hasClass ? { type: classifyList(l.displayName ?? "", config, l.id) } : {}),
          }));

          const filtered = typeFilter
            ? annotated.filter((l) => l.type === typeFilter)
            : annotated;

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  source,
                  count: filtered.length,
                  ...(typeFilter ? { type_filter: typeFilter } : {}),
                  lists: filtered,
                }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "get_list",
      {
        description:
          "Return one Microsoft To Do task list. Served from the TodoIndex roster; falls back to a live Graph enumerate while the index is warming. Returns list_not_found if the id is absent from the roster (out-of-band list creation surfaces within one sync cycle).",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .describe("List alias (from get_list_config), display name, or Graph list ID."),
        },
      },
      async ({ list }): Promise<McpResponse> =>
        this.withGraph("get_list", async (graph) => {
          const list_id = await this.resolveList(list);
          // DO roster fast path.
          const row = await this.#index()
            .getList(list_id)
            .catch(() => null);
          if (row) return listResponse({ list: rowToList(row), source: "index" });

          // Cold/miss: enumerate live (and warm the index) before giving up.
          const { lists, source } = await this.getRoster(graph);
          const found = lists.find((l) => l.id === list_id);
          if (!found) {
            return errResponse("list_not_found", { list, list_id, source });
          }
          return listResponse({ list: found, source });
        }),
    );

    this.server.registerTool(
      "list_tasks",
      {
        description:
          "Return one page of tasks from a Microsoft To Do list, served from the TodoIndex (source: 'index'). Pagination uses an opaque keyset next_cursor — pass it back as `cursor` for the next page (absent on the last page). While the index is warming for a list (source: 'graph_cold'), a single live Graph page is returned without a cursor; retry shortly for full pagination. Returns count + next_cursor + tasks.",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .describe("List alias (from get_list_config), display name, or Graph list ID. Required even when `cursor` is supplied."),
          status: z
            .enum(["notStarted", "inProgress", "completed", "waitingOnOthers", "deferred"])
            .optional()
            .describe("Filter to tasks with this status. Ignored when `cursor` is supplied (the cursor preserves the original filter)."),
          top: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("Maximum tasks per page. Default 50; max 200. Ignored when `cursor` is supplied."),
          cursor: z
            .string()
            .optional()
            .describe("Opaque keyset pagination token from a prior list_tasks response."),
        },
      },
      async ({ list, status, top, cursor }): Promise<McpResponse> =>
        this.withGraph("list_tasks", async (graph) => {
          const list_id = await this.resolveList(list);
          const limit = top ?? 50;

          // Serve from the DO when the list has an authoritative baseline, OR
          // whenever a cursor is supplied (a cursor only ever comes from a prior
          // DO page — the cold fallback below emits none).
          const synced =
            !!cursor || (await this.#index().isListSynced(list_id).catch(() => false));
          if (synced) {
            const { rows, next_cursor } = await this.#index().query({
              lists: [list_id],
              status: status ? [status] : undefined,
              limit,
              cursor,
            });
            return tasksResponse({
              list_id,
              tasks: rows.map(rowToSummary),
              next_cursor,
              source: "index",
            });
          }

          // Cold index for this list: serve one live Graph page so the caller
          // isn't stuck with an empty result, and kick a sync to warm it. No
          // next_cursor — pagination resumes from the DO once warm (retry).
          await this.#index()
            .ensureSyncing()
            .catch((e) => log.warn("index_ensure_syncing_failed", { error: String(e) }));
          const u = new URL(
            `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks`,
          );
          u.searchParams.set("$top", String(limit));
          if (status) u.searchParams.set("$filter", `status eq '${status}'`);
          const PageSchema = z
            .object({
              "@odata.context": z.string().optional(),
              "@odata.nextLink": z.string().optional(),
              value: z.array(TodoTaskSchema),
            })
            .passthrough();
          try {
            const page = await graph.getJson(u.toString(), PageSchema);
            return tasksResponse({
              list_id,
              tasks: page.value.map(summarizeTask),
              next_cursor: undefined,
              source: "graph_cold",
            });
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("list_not_found", { list_id });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "get_task",
      {
        description:
          "Return one Microsoft To Do task by id with inline expansions (checklistItems, linkedResources, attachments) and the full body. `list` is optional — when omitted it is resolved from the index via task_id (pass it explicitly to skip the lookup or when the index hasn't seen the task yet). Returns task_not_found if the id is invalid, or list_required if the list can't be inferred. Pass include_my_day: true to also return the task's My Day fields (committed_day, committed_order) from the SQLite cache — off by default. Pass include_checklist_order: true to return the inline checklistItems in live manual (drag) order with each item's orderDateTime (one Substrate round-trip; off by default).",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .optional()
            .describe("List alias, display name, or Graph list ID that owns the task. Optional — resolved from the index via task_id when omitted."),
          task_id: z
            .string()
            .min(1)
            .describe("Microsoft Graph task id."),
          include_my_day: z
            .boolean()
            .optional()
            .describe(
              "When true, also return the task's My Day fields (committed_day, committed_order) read from the SQLite cache (no extra Substrate round-trip). Off by default. my_day is null when the task isn't cached or My Day is disabled; an object with null fields means cached but not on My Day.",
            ),
          include_checklist_order: z
            .boolean()
            .optional()
            .describe(
              "When true, return the inline checklistItems in live MANUAL (drag) order with each item's orderDateTime, fetched from Substrate in the same call. Off by default (creation order, no extra round-trip). No effect when My Day / the EXO scope is unavailable (falls back to creation order).",
            ),
        },
      },
      async ({ list, task_id, include_my_day, include_checklist_order }): Promise<McpResponse> =>
        this.withGraph("get_task", async (graph) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          const url = new URL(
            `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`,
          );
          // Single-call $expand for all three nav properties. If step 9 smoke
          // shows Graph rejects any expansion on /v1.0, fall back to parallel
          // sub-collection fetches via mapPool (src/graph/concurrency.ts).
          url.searchParams.set(
            "$expand",
            "checklistItems,linkedResources,attachments",
          );

          try {
            const task = await graph.getJson(url.toString(), TodoTaskSchema);
            // include_checklist_order: enrich the inline steps with live manual
            // order (same Substrate source as list_checklist_items). Best-effort —
            // unavailable leaves Graph creation order. Sort + annotate in place so
            // detailedTask's checklistItems passthrough carries orderDateTime.
            if (include_checklist_order && Array.isArray(task.checklistItems)) {
              const order = await this.#tryChecklistOrder(list_id, task_id);
              if (order) {
                task.checklistItems = [...task.checklistItems]
                  .map((it) => ({ ...it, orderDateTime: order.get(it.id) ?? null }))
                  .sort((a, b) => compareOrderDateTimeDesc(a.orderDateTime, b.orderDateTime));
              }
            }
            // include_my_day: cache read (committed_day/committed_order are
            // Substrate-only and invisible to Graph). null = not cached or My Day
            // off (unknown); {null,null} = cached but not on My Day. Omitted when
            // not requested.
            const my_day = include_my_day
              ? myDayEnabled(this.env)
                ? await this.#index().getMyDayFields(task_id)
                : null
              : undefined;
            return taskResponse({ task, list_id, my_day });
          } catch (e) {
            // 404 = valid-shape id that doesn't exist; 400 + ErrorInvalidIdMalformed
            // = id isn't syntactically a Graph id. Both are "task can't be retrieved"
            // from the caller's perspective. Other GraphErrors propagate to withGraph's
            // `graph_${status}` mapping.
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("task_not_found", { list_id, task_id });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "create_task",
      {
        description:
          "Create a new task in a Microsoft To Do list. Returns the created task with all fields. Invalidates the list's task cache.",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .describe("List alias (from get_list_config), display name, or Graph list ID."),
          title: z.string().min(1).describe("Task title."),
          body: z
            .string()
            .optional()
            .describe("Task body/notes as plain text. Sent to Graph as contentType 'text'."),
          due: z
            .string()
            .optional()
            .describe(
              "Due date/time as ISO 8601 string (e.g. '2026-05-30' or '2026-05-30T10:00:00'). Stored in UTC.",
            ),
          reminder: z
            .string()
            .optional()
            .describe(
              "Reminder date/time as ISO 8601 string. Stored in UTC. Set isReminderOn to true to activate.",
            ),
          start: z
            .string()
            .optional()
            .describe("Start date/time as ISO 8601 string. Stored in UTC."),
          importance: z
            .enum(["low", "normal", "high"])
            .optional()
            .describe("Task importance level."),
          status: z
            .enum(["notStarted", "inProgress", "completed", "waitingOnOthers", "deferred"])
            .optional()
            .describe("Task status. Defaults to notStarted when omitted."),
          isReminderOn: z
            .boolean()
            .optional()
            .describe("Whether the reminder is active. Set true alongside `reminder` to arm it."),
          categories: z.array(z.string()).optional().describe("Category labels (colored tags)."),
          recurrence: PatternedRecurrenceSchema.optional().describe(
            "Task recurrence pattern. Supply both `pattern` and `range` sub-objects per Graph API shape.",
          ),
        },
      },
      async ({
        list,
        title,
        body,
        due,
        reminder,
        start,
        importance,
        status,
        isReminderOn,
        categories,
        recurrence,
      }): Promise<McpResponse> =>
        this.withGraph("create_task", async (graph) => {
          const list_id = await this.resolveList(list);
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks`;

          // Build Graph request body — only include fields explicitly provided.
          const graphBody: Record<string, unknown> = { title };
          if (body !== undefined) graphBody.body = { content: body, contentType: "text" };
          if (due !== undefined) graphBody.dueDateTime = { dateTime: due, timeZone: "UTC" };
          if (reminder !== undefined)
            graphBody.reminderDateTime = { dateTime: reminder, timeZone: "UTC" };
          if (start !== undefined) graphBody.startDateTime = { dateTime: start, timeZone: "UTC" };
          if (importance !== undefined) graphBody.importance = importance;
          if (status !== undefined) graphBody.status = status;
          if (isReminderOn !== undefined) graphBody.isReminderOn = isReminderOn;
          if (categories !== undefined) graphBody.categories = categories;
          if (recurrence !== undefined) graphBody.recurrence = recurrence;

          try {
            const task = await graph.postJson(url, graphBody, TodoTaskSchema);
            await this.#indexUpsertTask(task, list_id);
            const link_rules = await this.applyLinkRules(graph, list_id, task);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: true, list_id, task: detailedTask(task), link_rules }),
                },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("list_not_found", { list_id });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "update_task",
      {
        description:
          "Update one or more fields of an existing Microsoft To Do task via PATCH. Only supplied fields are changed; omitted fields are left as-is. Pass null for a datetime field to clear it. Returns the updated task. Invalidates the list's task cache.",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .describe("List alias (from get_list_config), display name, or Graph list ID that owns the task."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
          title: z.string().min(1).optional().describe("New task title."),
          body: z
            .string()
            .optional()
            .describe("New body/notes as plain text. Sent as contentType 'text'."),
          due: z
            .string()
            .nullable()
            .optional()
            .describe("New due date/time (ISO 8601, UTC). Pass null to clear."),
          reminder: z
            .string()
            .nullable()
            .optional()
            .describe("New reminder date/time (ISO 8601, UTC). Pass null to clear."),
          start: z
            .string()
            .nullable()
            .optional()
            .describe("New start date/time (ISO 8601, UTC). Pass null to clear."),
          completed_date: z
            .string()
            .nullable()
            .optional()
            .describe(
              "Backdate a task's completion. ISO 8601 date (e.g. '2026-05-25'); To Do stores completion at " +
                "DATE granularity, so any time-of-day is dropped (midnight UTC). Marks the task completed as of " +
                "that date — works whether the task is not-yet-done OR already completed (the server forces the " +
                "completion to re-stamp). For a normal complete-now, omit this and just set status:'completed'. " +
                "Implies status:'completed' unless you pass status explicitly. NOT supported on recurring tasks " +
                "(completing one advances it to the next occurrence) — returns recurring_completion_unsupported. " +
                "Pass null to clear the completion date.",
            ),
          importance: z
            .enum(["low", "normal", "high"])
            .optional()
            .describe("New importance level."),
          status: z
            .enum(["notStarted", "inProgress", "completed", "waitingOnOthers", "deferred"])
            .optional()
            .describe("New status."),
          isReminderOn: z.boolean().optional().describe("Whether the reminder is active."),
          categories: z
            .array(z.string())
            .optional()
            .describe("Replacement category labels — full list, not additive."),
          recurrence: PatternedRecurrenceSchema.nullable()
            .optional()
            .describe("New recurrence pattern. Pass null to clear."),
          if_match: z
            .string()
            .optional()
            .describe(
              "ETag from a prior get_task response (the '@odata.etag' field). Sends If-Match to avoid clobbering concurrent edits.",
            ),
        },
      },
      async ({
        list,
        task_id,
        title,
        body,
        due,
        reminder,
        start,
        completed_date,
        importance,
        status,
        isReminderOn,
        categories,
        recurrence,
        if_match,
      }): Promise<McpResponse> =>
        this.withGraph("update_task", async (graph) => {
          const list_id = await this.resolveList(list);
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`;

          // Only include fields the caller explicitly supplied. Null datetimes
          // are passed through as-is so Graph clears the field server-side.
          const graphBody: Record<string, unknown> = {};
          if (title !== undefined) graphBody.title = title;
          if (body !== undefined) graphBody.body = { content: body, contentType: "text" };
          if (due !== undefined)
            graphBody.dueDateTime = due !== null ? { dateTime: due, timeZone: "UTC" } : null;
          if (reminder !== undefined)
            graphBody.reminderDateTime =
              reminder !== null ? { dateTime: reminder, timeZone: "UTC" } : null;
          if (start !== undefined)
            graphBody.startDateTime =
              start !== null ? { dateTime: start, timeZone: "UTC" } : null;
          if (completed_date !== undefined) {
            graphBody.completedDateTime =
              completed_date !== null ? { dateTime: completed_date, timeZone: "UTC" } : null;
            // Graph only retains completedDateTime while status is 'completed'
            // (per the todoTask update docs). Imply it for a backdate so the
            // date sticks, unless the caller set status explicitly.
            if (completed_date !== null && status === undefined) graphBody.status = "completed";
          }
          if (importance !== undefined) graphBody.importance = importance;
          if (status !== undefined) graphBody.status = status;
          if (isReminderOn !== undefined) graphBody.isReminderOn = isReminderOn;
          if (categories !== undefined) graphBody.categories = categories;
          if (recurrence !== undefined) graphBody.recurrence = recurrence;

          // Backdating a completion needs a real notStarted->completed
          // transition: Graph ignores completedDateTime on a re-PATCH of an
          // already-completed task, and a recurring task can't hold one at all
          // (completing advances it to the next occurrence). So when a concrete
          // completed_date is given we look the task up first, refuse recurring,
          // and reset an already-completed task to notStarted so the PATCH below
          // transitions it afresh and the date sticks.
          let mainIfMatch = if_match;
          if (completed_date !== undefined && completed_date !== null) {
            let current;
            try {
              current = await graph.getJson(url, TodoTaskSchema);
            } catch (e) {
              if (
                e instanceof GraphError &&
                (e.status === 404 ||
                  (e.status === 400 && getGraphInnerErrorCode(e.detail) === "ErrorInvalidIdMalformed"))
              ) {
                return errResponse("task_not_found", { list_id, task_id });
              }
              throw e;
            }
            if (current.recurrence != null) {
              return errResponse("recurring_completion_unsupported", {
                list_id,
                task_id,
                hint: "Completing a recurring task advances it to the next occurrence, so To Do can't keep a fixed completion date. Remove the recurrence first, or complete it without completed_date.",
              });
            }
            if ((current.status ?? "") === "completed") {
              // Already completed: reset to notStarted so the PATCH below is a
              // genuine transition (otherwise completedDateTime is ignored).
              await graph.patchJson(url, { status: "notStarted" }, TodoTaskSchema, {
                ifMatch: if_match,
              });
              // The reset consumed the caller's ETag; don't reuse a stale one.
              mainIfMatch = undefined;
            }
          }

          try {
            const task = await graph.patchJson(url, graphBody, TodoTaskSchema, {
              ifMatch: mainIfMatch,
            });
            await this.#indexUpsertTask(task, list_id);
            const response: Record<string, unknown> = {
              ok: true,
              list_id,
              task: detailedTask(task),
            };
            // Only re-run link rules when the matched fields changed.
            if (title !== undefined || body !== undefined) {
              // PATCH response doesn't include linkedResources, so re-fetch
              // with $expand=linkedResources before applyLinkRules so the
              // existingUrls seed is populated and duplicates are prevented.
              const expandUrl = new URL(url);
              expandUrl.searchParams.set("$expand", "linkedResources");
              const taskWithLinks = await graph.getJson(expandUrl.toString(), TodoTaskSchema);
              response.link_rules = await this.applyLinkRules(graph, list_id, taskWithLinks);
            }
            return {
              content: [{ type: "text", text: JSON.stringify(response) }],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("task_not_found", { list_id, task_id });
              }
              if (e.status === 412) {
                return errResponse("precondition_failed", {
                  list_id,
                  task_id,
                  hint: "ETag mismatch — task was modified since last read. Re-fetch and retry.",
                });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "delete_task",
      {
        description:
          "Permanently delete a Microsoft To Do task. Returns ok: true on success. Invalidates the list's task cache.",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .describe("List alias (from get_list_config), display name, or Graph list ID that owns the task."),
          task_id: z.string().min(1).describe("Microsoft Graph task id to delete."),
        },
      },
      async ({ list, task_id }): Promise<McpResponse> =>
        this.withGraph("delete_task", async (graph) => {
          const list_id = await this.resolveList(list);
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`;
          try {
            await graph.deleteResource(url);
            await this.#indexDeleteTask(task_id);
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: true, task_id, list_id }) }],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("task_not_found", { list_id, task_id });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "move_task",
      {
        description:
          "Move a task between lists. Prefers a LOSSLESS in-place Substrate re-parent when ENABLE_MY_DAY/EXO is enabled: one PATCH moves the same underlying item, so checklist items, the linked resource, attachments, and My Day all ride along. The task id CHANGES on a re-parent (the new id encodes the destination), so the result returns `task_id` (current) plus `previous_task_id`. When Substrate is unavailable it FALLS BACK to a non-atomic create-then-delete full copy: sub-resources are copied individually (checklist in order, the single linked resource, and attachments by round-tripping bytes through the Worker). A required-copy failure aborts with the SOURCE LEFT INTACT — an attachment >25 MiB, a reference-type attachment (no bytes to copy), or attachments that can't be enumerated aborts the move. A retried failed copy can create a second destination task (no idempotency key — documented footgun). `method` ('substrate_reparent' | 'copy_delete') tells you which path ran and whether sub-resources rode along or were copied individually; the id always changes, so read `task_id` and `previous_task_id`. Invalidates both lists' caches. NOTE: disabling ENABLE_MY_DAY silently downgrades moves to the lossy fallback.",
        inputSchema: {
          task_id: z.string().min(1).describe("Microsoft Graph task id to move."),
          from_list: z.string().min(1).describe("Source list — alias, display name, or Graph list ID."),
          to_list: z.string().min(1).describe("Destination list — alias, display name, or Graph list ID."),
        },
      },
      async ({ task_id, from_list, to_list }): Promise<McpResponse> =>
        this.withGraph("move_task", async (graph) => {
          const [from_list_id, to_list_id] = await Promise.all([
            this.resolveList(from_list),
            this.resolveList(to_list),
          ]);
          // Fetch the source with all sub-resources expanded — required for the
          // copy/delete fallback and for not-found handling. ($expand carries
          // checklist/linked-resource/attachment metadata but NOT attachment
          // bytes; those are fetched per-attachment in the fallback.)
          const srcUrl = new URL(
            `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(from_list_id)}/tasks/${encodeURIComponent(task_id)}`,
          );
          srcUrl.searchParams.set("$expand", "checklistItems,linkedResources,attachments");

          let srcTask: TodoTask;
          try {
            srcTask = await graph.getJson(srcUrl.toString(), TodoTaskSchema);
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("task_not_found", { list_id: from_list_id, task_id });
              }
            }
            throw e;
          }

          // ---- PRIMARY: lossless Substrate in-place re-parent ----
          // When My Day/EXO is enabled, move the SAME underlying item in one
          // PATCH so checklist items, attachments, the linked resource, and My
          // Day ride along. The id changes (new id encodes the destination), so
          // we surface previous_task_id and re-key the cache. Runtime EXO
          // consent is only known when the call is made; unavailable Substrate
          // or an unconfirmed move cleanly degrades to the fallback below.
          if (myDayEnabled(this.env)) {
            const r = await this.#reparentViaSubstrate(to_list_id, task_id);
            if (r.ok) {
              const newId = r.task.Id ?? task_id;
              // Best-effort cache re-key. Reuse srcTask's expansions so the
              // has_checklist/has_attachments flags carry to the new id; delta
              // sync (source removal + dest add) self-heals any gap next cycle.
              await this.#indexDeleteTask(task_id);
              await this.#indexUpsertTask({ ...srcTask, id: newId }, to_list_id);
              return jsonResult({
                ok: true,
                method: "substrate_reparent",
                task_id: newId,
                previous_task_id: task_id,
                from_list_id,
                to_list_id,
              });
            }
            if (r.attempted) {
              // A re-parent was attempted but didn't confirm — it may have
              // committed at EWS while dropping its response, so blindly
              // creating a copy would duplicate. Re-check the source before any
              // fallback create (the duplicate-creation guard).
              const recheck = await this.#recheckSource(graph, from_list_id, task_id);
              if (decideAfterReparentFailure(recheck) === "treat_as_moved") {
                await this.#indexDeleteTask(task_id);
                const newId = r.task?.Id;
                return jsonResult({
                  ok: true,
                  method: "substrate_reparent",
                  task_id: newId ?? task_id,
                  previous_task_id: task_id,
                  from_list_id,
                  to_list_id,
                  note: newId
                    ? "Re-parent response was not fully confirmed; treated as moved (delta sync will reconcile)."
                    : "Source no longer present after an ambiguous re-parent; treated as moved. The task id may have changed — delta sync will reconcile.",
                });
              }
              // Source confirmed still present → safe to fall through to copy.
            }
            // r.attempted === false (Substrate unavailable, no PATCH sent) →
            // fall straight through to the copy/delete fallback.
          }

          // ---- FALLBACK: copy everything to destination, then delete source ----
          // Lossy path made as lossless as Graph allows. Copy-before-delete: a
          // required-copy failure aborts with the source fully intact.
          const postBody = buildMoveCopyBody(srcTask);
          const dstTasksUrl = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(to_list_id)}/tasks`;
          let newTask: TodoTask;
          try {
            newTask = await graph.postJson(dstTasksUrl, postBody, TodoTaskSchema);
            await this.#indexUpsertTask(newTask, to_list_id);
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("list_not_found", { list_id: to_list_id });
              }
            }
            throw e;
          }
          const newId = newTask.id;

          // Abort with best-effort cleanup of the just-created destination task.
          // The source is never touched during the copy phase, so it remains the
          // valid, complete task (task_id below is the still-live source id).
          const abort = async (
            error: string,
            extra: Record<string, unknown> = {},
          ): Promise<McpResponse> => {
            let cleanup_succeeded = true;
            try {
              await graph.deleteResource(
                `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(to_list_id)}/tasks/${encodeURIComponent(newId)}`,
              );
              await this.#indexDeleteTask(newId);
            } catch (e) {
              cleanup_succeeded = false;
              log.warn("move_fallback_cleanup_failed", { newId, error: String(e) });
            }
            const result: Record<string, unknown> = {
              ok: false,
              method: "copy_delete",
              error,
              from_list_id,
              to_list_id,
              task_id, // source id — still valid, source untouched
              cleanup_succeeded,
              ...extra,
            };
            if (!cleanup_succeeded) result.orphan_task_id = newId;
            return jsonResult(result);
          };

          // Copy checklist items in createdDateTime order.
          let checklist_copied = 0;
          const items = (srcTask.checklistItems ?? [])
            .slice()
            .sort((a, b) => (a.createdDateTime ?? "").localeCompare(b.createdDateTime ?? ""));
          for (const it of items) {
            try {
              await createChecklistItem(graph, to_list_id, newId, {
                displayName: it.displayName ?? "",
                isChecked: it.isChecked,
              });
              checklist_copied += 1;
            } catch (e) {
              return abort("checklist_copy_failed", { detail: String(e), checklist_copied });
            }
          }

          // Copy the linked resource (Graph allows at most one per task).
          let linked_resources_copied = 0;
          const lr = (srcTask.linkedResources ?? [])[0];
          if (lr) {
            try {
              await createLinkedResource(graph, to_list_id, newId, {
                applicationName: lr.applicationName ?? "Linked resource",
                displayName: lr.displayName,
                externalId: lr.externalId ?? undefined,
                webUrl: lr.webUrl ?? undefined,
              });
              linked_resources_copied += 1;
            } catch (e) {
              return abort("linked_resource_copy_failed", {
                detail: String(e),
                checklist_copied,
              });
            }
          }

          // Copy attachments — bytes round-trip through the Worker (Graph has no
          // server-side copy). Enumerate via the attachments COLLECTION:
          // `$expand=attachments` is silently ignored on a todoTask (it returns
          // no `attachments` array), so reading srcTask.attachments would drop
          // every attachment and then delete the source. List the collection.
          let attachments_copied = 0;
          if (srcTask.hasAttachments) {
            const cfg = await loadAttachmentConfig(this.env);
            const accessToken = await this.getAccessToken();
            let srcAttachments: Attachment[];
            try {
              srcAttachments = await listAttachments(graph, from_list_id, task_id);
            } catch (e) {
              return abort("attachment_list_failed", {
                detail: String(e),
                checklist_copied,
                linked_resources_copied,
              });
            }
            if (srcAttachments.length === 0) {
              // hasAttachments was true but none enumerated — refuse to delete
              // the source on an inconsistent read rather than silently lose data.
              return abort("attachment_enumeration_empty", {
                checklist_copied,
                linked_resources_copied,
              });
            }
            for (const meta of srcAttachments) {
              const counts = { checklist_copied, linked_resources_copied, attachments_copied };
              if (meta["@odata.type"] !== "#microsoft.graph.taskFileAttachment") {
                // Reference attachments carry no bytes to re-upload — abort
                // rather than silently drop (the lossy behavior we're replacing).
                return abort("reference_attachment_not_copyable", {
                  attachment_id: meta.id,
                  ...counts,
                });
              }
              let full;
              try {
                full = await getFileAttachment(graph, from_list_id, task_id, meta.id);
              } catch (e) {
                return abort("attachment_read_failed", {
                  attachment_id: meta.id,
                  detail: String(e),
                  ...counts,
                });
              }
              if (!full.contentBytes) {
                return abort("attachment_missing_bytes", { attachment_id: meta.id, ...counts });
              }
              const bytes = bytesFromBase64(full.contentBytes);
              if (bytes.byteLength > PER_FILE_MAX_BYTES) {
                return abort("attachment_too_large", {
                  attachment_id: meta.id,
                  size: bytes.byteLength,
                  max: PER_FILE_MAX_BYTES,
                  ...counts,
                });
              }
              try {
                await attachFile(graph, accessToken, {
                  listId: to_list_id,
                  taskId: newId,
                  name: full.name ?? "attachment",
                  bytes,
                  contentType: full.contentType ?? "application/octet-stream",
                  maxInlineBytes: cfg.max_inline_bytes,
                });
                attachments_copied += 1;
              } catch (e) {
                return abort("attachment_upload_failed", {
                  attachment_id: meta.id,
                  detail: String(e),
                  ...counts,
                });
              }
            }
          }

          // Carry My Day (best-effort, only if enabled). Reads the source's
          // CommittedDay via Substrate BEFORE the source delete, then applies it
          // to the destination copy. Never aborts. (Mostly relevant when the
          // primary re-parent failed and fell through here; when My Day is
          // enabled the primary path normally handles the move whole.)
          let my_day_carried = false;
          let my_day_skipped_reason: string | undefined;
          if (myDayEnabled(this.env)) {
            const carry = await this.#carryMyDay(from_list_id, to_list_id, task_id, newId);
            my_day_carried = carry.carried;
            if (!carry.carried) my_day_skipped_reason = carry.reason;
          } else {
            my_day_skipped_reason = "my_day_disabled";
          }

          // Delete the source — non-fatal on failure (return ok:true + warning
          // so the caller can retry delete_task rather than lose the new id).
          let warning: string | undefined;
          try {
            await graph.deleteResource(
              `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(from_list_id)}/tasks/${encodeURIComponent(task_id)}`,
            );
            await this.#indexDeleteTask(task_id);
          } catch (e) {
            const detail = e instanceof GraphError ? e.detail : String(e);
            warning = `Copied to destination (task_id: ${newId}) but source delete failed: ${detail ?? "unknown"}. Retry: delete_task({ list_id: "${from_list_id}", task_id: "${task_id}" }).`;
            log.warn("move_task_delete_failed", { from_list_id, task_id, detail });
          }

          // Fix destination cache flags — the bare POST response lacked
          // sub-resource state, so set them from what we copied.
          await this.#indexSetFlags(newId, {
            has_checklist: checklist_copied > 0,
            has_attachments: attachments_copied > 0,
          });

          const result: Record<string, unknown> = {
            ok: true,
            method: "copy_delete",
            task_id: newId,
            previous_task_id: task_id,
            from_list_id,
            to_list_id,
            checklist_copied,
            linked_resources_copied,
            attachments_copied,
            my_day_carried,
          };
          if (my_day_skipped_reason) result.my_day_skipped_reason = my_day_skipped_reason;
          if (warning) result.warning = warning;
          return jsonResult(result);
        }),
    );

    this.server.registerTool(
      "create_list",
      {
        description:
          "Create a new Microsoft To Do task list. Returns the created list. Invalidates the lists cache.",
        inputSchema: {
          display_name: z.string().min(1).describe("Display name for the new list."),
        },
      },
      async ({ display_name }): Promise<McpResponse> =>
        this.withGraph("create_list", async (graph) => {
          const list = await graph.postJson(
            "https://graph.microsoft.com/v1.0/me/todo/lists",
            { displayName: display_name },
            TodoTaskListSchema,
          );
          await this.#indexUpsertList(list);
          return {
            content: [
              { type: "text", text: JSON.stringify({ ok: true, list: summarizeList(list) }) },
            ],
          };
        }),
    );

    this.server.registerTool(
      "update_list",
      {
        description:
          "Rename a Microsoft To Do task list. Only displayName can be changed via Graph. Returns the updated list. Invalidates the lists cache.",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .describe("List alias (from get_list_config), display name, or Graph list ID."),
          display_name: z.string().min(1).describe("New display name for the list."),
        },
      },
      async ({ list, display_name }): Promise<McpResponse> =>
        this.withGraph("update_list", async (graph) => {
          const list_id = await this.resolveList(list);
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}`;
          try {
            const list = await graph.patchJson(
              url,
              { displayName: display_name },
              TodoTaskListSchema,
            );
            await this.#indexUpsertList(list);
            return {
              content: [
                { type: "text", text: JSON.stringify({ ok: true, list: summarizeList(list) }) },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("list_not_found", { list_id });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "delete_list",
      {
        description:
          "Permanently delete a Microsoft To Do task list and all its tasks. The default list (wellknownListName: 'defaultList') cannot be deleted — Graph returns 405. Invalidates the lists cache.",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .describe(
              "List alias (from get_list_config), display name, or Graph list ID to delete. The default list cannot be deleted.",
            ),
        },
      },
      async ({ list }): Promise<McpResponse> =>
        this.withGraph("delete_list", async (graph) => {
          const list_id = await this.resolveList(list);
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}`;
          try {
            await graph.deleteResource(url);
            await this.#indexDeleteList(list_id);
            return {
              content: [{ type: "text", text: JSON.stringify({ ok: true, list_id }) }],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("list_not_found", { list_id });
              }
              if (e.status === 405) {
                return errResponse("method_not_allowed", {
                  list_id,
                  hint: "The default list (wellknownListName: 'defaultList') cannot be deleted.",
                });
              }
            }
            throw e;
          }
        }),
    );

    // Checklist item collection schema — used inline by list_checklist_items.
    const ChecklistCollectionSchema = z
      .object({ value: z.array(ChecklistItemSchema) })
      .passthrough();

    this.server.registerTool(
      "list_checklist_items",
      {
        description:
          "Return all checklist items (subtasks / 'steps' in the To Do app) for a Microsoft To Do task.",
        inputSchema: {
          list: z.string().min(1).optional().describe("List alias (from get_list_config), display name, or Graph list ID."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
        },
      },
      async ({ list, task_id }): Promise<McpResponse> =>
        this.withGraph("list_checklist_items", async (graph) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/checklistItems`;
          try {
            const result = await graph.getJson(url, ChecklistCollectionSchema);
            // Best-effort live manual order (Substrate). When unavailable, fall
            // back to Graph creation order — never an error.
            const order = await this.#tryChecklistOrder(list_id, task_id);
            const items = order
              ? [...result.value]
                  .map((it) => ({ ...it, orderDateTime: order.get(it.id) ?? null }))
                  .sort((a, b) => compareOrderDateTimeDesc(a.orderDateTime, b.orderDateTime))
              : result.value;
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    list_id,
                    task_id,
                    ordered: order !== null,
                    count: items.length,
                    items,
                  }),
                },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("task_not_found", { list_id, task_id });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "create_checklist_item",
      {
        description:
          "Create a new checklist item (subtask / 'step') on a Microsoft To Do task. Invalidates the list's task cache.",
        inputSchema: {
          list: z.string().min(1).optional().describe("List alias (from get_list_config), display name, or Graph list ID."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
          display_name: z.string().min(1).describe("Checklist item text."),
          is_checked: z
            .boolean()
            .optional()
            .describe("Whether the item starts checked. Defaults to false."),
        },
      },
      async ({ list, task_id, display_name, is_checked }): Promise<McpResponse> =>
        this.withGraph("create_checklist_item", async (graph) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          try {
            const item = await createChecklistItem(graph, list_id, task_id, {
              displayName: display_name,
              isChecked: is_checked,
            });
            await this.#indexSetFlags(task_id, { has_checklist: true });
            await this.#indexUpsertChecklistItem(task_id, list_id, item);
            return {
              content: [
                { type: "text", text: JSON.stringify({ ok: true, list_id, task_id, item }) },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("task_not_found", { list_id, task_id });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "update_checklist_item",
      {
        description:
          "Update the text or checked state of a checklist item (subtask / 'step'). Invalidates the list's task cache.",
        inputSchema: {
          list: z.string().min(1).optional().describe("List alias (from get_list_config), display name, or Graph list ID."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
          item_id: z.string().min(1).describe("Checklist item id (from list_checklist_items)."),
          display_name: z.string().min(1).optional().describe("New item text."),
          is_checked: z.boolean().optional().describe("New checked state."),
        },
      },
      async ({ list, task_id, item_id, display_name, is_checked }): Promise<McpResponse> =>
        this.withGraph("update_checklist_item", async (graph) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/checklistItems/${encodeURIComponent(item_id)}`;
          const body: Record<string, unknown> = {};
          if (display_name !== undefined) body.displayName = display_name;
          if (is_checked !== undefined) body.isChecked = is_checked;
          try {
            const item = await graph.patchJson(url, body, ChecklistItemSchema);
            // Write-through to the checklist cache (when enabled): update the
            // cached item's text/checked state immediately. has_checklist is
            // unaffected by an update. No-op when the cache is off.
            await this.#indexUpsertChecklistItem(task_id, list_id, item);
            return {
              content: [
                { type: "text", text: JSON.stringify({ ok: true, list_id, task_id, item }) },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("checklist_item_not_found", { list_id, task_id, item_id });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "delete_checklist_item",
      {
        description:
          "Delete a checklist item (subtask / 'step') from a task. Invalidates the list's task cache.",
        inputSchema: {
          list: z.string().min(1).optional().describe("List alias (from get_list_config), display name, or Graph list ID."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
          item_id: z
            .string()
            .min(1)
            .describe("Checklist item id to delete (from list_checklist_items)."),
        },
      },
      async ({ list, task_id, item_id }): Promise<McpResponse> =>
        this.withGraph("delete_checklist_item", async (graph) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/checklistItems/${encodeURIComponent(item_id)}`;
          try {
            await graph.deleteResource(url);
            // Write-through to the checklist cache (when enabled): drop the cached
            // item row. has_checklist is left as-is (can't tell if it was the last
            // item without a re-list); the next delta-driven re-fetch reconciles.
            await this.#indexDeleteChecklistItem(task_id, item_id);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: true, list_id, task_id, item_id }),
                },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("checklist_item_not_found", { list_id, task_id, item_id });
              }
            }
            throw e;
          }
        }),
    );

    // Linked resource collection schema — used inline by list_linked_resources.
    const LinkedResourceCollectionSchema = z
      .object({ value: z.array(LinkedResourceSchema) })
      .passthrough();

    this.server.registerTool(
      "list_linked_resources",
      {
        description: "Return all linked resources attached to a Microsoft To Do task.",
        inputSchema: {
          list: z.string().min(1).optional().describe("List alias (from get_list_config), display name, or Graph list ID."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
        },
      },
      async ({ list, task_id }): Promise<McpResponse> =>
        this.withGraph("list_linked_resources", async (graph) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/linkedResources`;
          try {
            const result = await graph.getJson(url, LinkedResourceCollectionSchema);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    list_id,
                    task_id,
                    count: result.value.length,
                    linked_resources: result.value,
                  }),
                },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("task_not_found", { list_id, task_id });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "get_linked_resource",
      {
        description: "Return a single linked resource by id.",
        inputSchema: {
          list: z.string().min(1).optional().describe("List alias (from get_list_config), display name, or Graph list ID."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
          resource_id: z.string().min(1).describe("Linked resource id (from list_linked_resources)."),
        },
      },
      async ({ list, task_id, resource_id }): Promise<McpResponse> =>
        this.withGraph("get_linked_resource", async (graph) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/linkedResources/${encodeURIComponent(resource_id)}`;
          try {
            const resource = await graph.getJson(url, LinkedResourceSchema);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: true, list_id, task_id, linked_resource: resource }),
                },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("linked_resource_not_found", {
                  list_id,
                  task_id,
                  resource_id,
                });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "create_linked_resource",
      {
        description:
          "Attach a linked resource to a Microsoft To Do task (e.g. a URL, ticket, or external reference). Invalidates the list's task cache.",
        inputSchema: {
          list: z.string().min(1).optional().describe("List alias (from get_list_config), display name, or Graph list ID."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
          application_name: z
            .string()
            .min(1)
            .describe("Name of the application or source (e.g. 'Jira', 'GitHub')."),
          display_name: z
            .string()
            .optional()
            .describe("Human-readable label for the link."),
          external_id: z
            .string()
            .optional()
            .describe("Identifier within the external system (e.g. ticket number)."),
          web_url: z.string().optional().describe("URL to open the linked resource."),
        },
      },
      async ({
        list,
        task_id,
        application_name,
        display_name,
        external_id,
        web_url,
      }): Promise<McpResponse> =>
        this.withGraph("create_linked_resource", async (graph) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          try {
            const resource = await createLinkedResource(graph, list_id, task_id, {
              applicationName: application_name,
              displayName: display_name,
              externalId: external_id,
              webUrl: web_url,
            });
            // No DO write: linked resources aren't an indexed field; the task
            // already exists in the index and the next delta sync reconciles.
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: true, list_id, task_id, linked_resource: resource }),
                },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("task_not_found", { list_id, task_id });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "update_linked_resource",
      {
        description:
          "Update fields of an existing linked resource (applicationName, displayName, externalId, webUrl). This is the operation n8n's built-in To Do node could not perform. Invalidates the list's task cache.",
        inputSchema: {
          list: z.string().min(1).optional().describe("List alias (from get_list_config), display name, or Graph list ID."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
          resource_id: z
            .string()
            .min(1)
            .describe("Linked resource id (from list_linked_resources)."),
          application_name: z.string().min(1).optional().describe("New application name."),
          display_name: z.string().optional().describe("New display label."),
          external_id: z.string().nullable().optional().describe("New external id. Pass null to clear."),
          web_url: z.string().nullable().optional().describe("New URL. Pass null to clear."),
        },
      },
      async ({
        list,
        task_id,
        resource_id,
        application_name,
        display_name,
        external_id,
        web_url,
      }): Promise<McpResponse> =>
        this.withGraph("update_linked_resource", async (graph) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/linkedResources/${encodeURIComponent(resource_id)}`;
          const body: Record<string, unknown> = {};
          if (application_name !== undefined) body.applicationName = application_name;
          if (display_name !== undefined) body.displayName = display_name;
          if (external_id !== undefined) body.externalId = external_id;
          if (web_url !== undefined) body.webUrl = web_url;
          try {
            const resource = await graph.patchJson(url, body, LinkedResourceSchema);
            // No DO write: linked resources aren't an indexed field.
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: true, list_id, task_id, linked_resource: resource }),
                },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("linked_resource_not_found", {
                  list_id,
                  task_id,
                  resource_id,
                });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "delete_linked_resource",
      {
        description:
          "Delete a linked resource from a task. Invalidates the list's task cache.",
        inputSchema: {
          list: z.string().min(1).optional().describe("List alias (from get_list_config), display name, or Graph list ID."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
          resource_id: z
            .string()
            .min(1)
            .describe("Linked resource id to delete (from list_linked_resources)."),
        },
      },
      async ({ list, task_id, resource_id }): Promise<McpResponse> =>
        this.withGraph("delete_linked_resource", async (graph) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/linkedResources/${encodeURIComponent(resource_id)}`;
          try {
            await graph.deleteResource(url);
            // No DO write: linked resources aren't an indexed field.
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: true, list_id, task_id, resource_id }),
                },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("linked_resource_not_found", {
                  list_id,
                  task_id,
                  resource_id,
                });
              }
            }
            throw e;
          }
        }),
    );

    // Attachment collection schema — used inline by list_attachments.
    this.server.registerTool(
      "list_attachments",
      {
        description:
          "Return all attachments for a task (metadata only; contentBytes is absent in list responses — use get_attachment to retrieve file content).",
        inputSchema: {
          list: z.string().min(1).optional().describe("List alias (from get_list_config), display name, or Graph list ID."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
        },
      },
      async ({ list, task_id }): Promise<McpResponse> =>
        this.withGraph("list_attachments", async (graph) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          try {
            const attachments = await listAttachments(graph, list_id, task_id);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    list_id,
                    task_id,
                    count: attachments.length,
                    attachments,
                  }),
                },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("task_not_found", { list_id, task_id });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "get_attachment",
      {
        description:
          "Return a single task attachment including base64-encoded contentBytes (for taskFileAttachment). Use list_attachments to enumerate ids.",
        inputSchema: {
          list: z.string().min(1).optional().describe("List alias (from get_list_config), display name, or Graph list ID."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
          attachment_id: z
            .string()
            .min(1)
            .describe("Attachment id (from list_attachments)."),
        },
      },
      async ({ list, task_id, attachment_id }): Promise<McpResponse> =>
        this.withGraph("get_attachment", async (graph) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/attachments/${encodeURIComponent(attachment_id)}`;
          try {
            const attachment = await graph.getJson(url, AttachmentSchema);
            // For an image, return a native MCP `image` content block so the
            // client renders it inline — no base64-decode round-trip. The bytes
            // are carried in the image block, so strip contentBytes from the JSON
            // metadata block to avoid shipping the base64 through context twice.
            const isImage =
              attachment["@odata.type"] === "#microsoft.graph.taskFileAttachment" &&
              typeof attachment.contentType === "string" &&
              attachment.contentType.toLowerCase().startsWith("image/") &&
              typeof attachment.contentBytes === "string" &&
              attachment.contentBytes.length > 0;
            if (isImage) {
              const { contentBytes, ...metadata } = attachment as typeof attachment & {
                contentBytes?: string;
              };
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ ok: true, list_id, task_id, attachment: metadata }),
                  },
                  {
                    type: "image",
                    data: contentBytes as string,
                    mimeType: attachment.contentType as string,
                  },
                ],
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: true, list_id, task_id, attachment }),
                },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("attachment_not_found", { list_id, task_id, attachment_id });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "create_upload_link",
      {
        description:
          "Mint a short-lived (default 15 min, max 30), single-use web link the user opens in a browser to attach a file to THIS specific task. The file's bytes go straight from the browser to the server and on to Microsoft (≤ 25 MB) — they never pass through the model, so this is the way to attach anything beyond a trivial generated snippet. Returns { upload_url, expires_at }. Present upload_url to the user as a tappable link, then poll list_attachments / get_attachment to confirm. With `filename` the link accepts exactly one file stored under that name; without it the link accepts up to `max_files` files.",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .optional()
            .describe("List alias (from get_list_config), display name, or Graph list ID. Omit to resolve from the index."),
          task_id: z.string().min(1).describe("Microsoft Graph task id the file(s) will attach to."),
          filename: z
            .string()
            .min(1)
            .optional()
            .describe("Bake a fixed filename (incl. extension) — makes a single-file link stored under this name."),
          content_type: z
            .string()
            .min(1)
            .optional()
            .describe("Optional MIME hint; the server sniffs the bytes and overrides this when it can."),
          max_files: z
            .number()
            .int()
            .min(1)
            .max(MAX_FILES_CAP)
            .optional()
            .describe(`Batch links only (no filename): max files the link accepts (1–${MAX_FILES_CAP}, default ${DEFAULT_MAX_FILES}).`),
          ttl_minutes: z
            .number()
            .int()
            .min(1)
            .max(30)
            .optional()
            .describe("Link lifetime in minutes (1–30, default 15)."),
        },
      },
      async ({ list, task_id, filename, content_type, max_files, ttl_minutes }): Promise<McpResponse> =>
        instrument("create_upload_link", async () => {
          const base = (this.env.SERVICE_BASE_URL ?? "").replace(/\/+$/, "");
          if (!/^https?:\/\/[^/]+/i.test(base)) {
            return errResponse("upload_disabled", {
              detail: "SERVICE_BASE_URL is not configured as an absolute URL.",
            });
          }
          if (base.includes("example.workers.dev")) {
            // Ships as a placeholder; minting links to it would produce dead URLs.
            return errResponse("upload_disabled", {
              detail: "SERVICE_BASE_URL is still the example placeholder — set it to this Worker's real public origin.",
            });
          }
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }

          const scope: UploadCapabilityScope = { list_id, task_id };
          if (content_type) scope.content_type = content_type;
          if (filename) {
            scope.filename = filename;
          } else {
            scope.max_files = Math.min(Math.max(max_files ?? DEFAULT_MAX_FILES, 1), MAX_FILES_CAP);
          }

          // Best-effort human-readable labels for the upload page, from the index
          // (a cold/unindexed task just degrades to no title — the page copes).
          const meta = await this.#index()
            .getTaskMeta(task_id)
            .catch((e) => {
              log.warn("upload_link_meta_failed", { task_id, error: String(e) });
              return null;
            });
          if (meta?.title) scope.task_title = meta.title;
          if (meta?.list_display_name) scope.list_name = meta.list_display_name;

          const ttlSeconds = ttl_minutes ? ttl_minutes * 60 : undefined;
          const { token, expiresAt } = await createUploadCapability(this.env, scope, ttlSeconds);
          const upload_url = `${base}/upload?t=${encodeURIComponent(token)}`;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  upload_url,
                  expires_at: expiresAt,
                  list_id,
                  task_id,
                  task_title: scope.task_title ?? null,
                  list_name: scope.list_name ?? null,
                  filename: filename ?? null,
                  max_files: scope.max_files ?? null,
                }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "mint_download_link",
      {
        description:
          "Mint a short-lived (≤ 5 min), single-use URL that serves ONE attachment's raw bytes for a server-to-server transfer — e.g. hand the URL to another MCP server's url-ingest tool to move a file into it. The bytes are fetched server-side and never pass through the model. Returns { download_url, filename, content_type, size, expires_at }. The link is burned on first fetch, so pass it straight to the destination tool; don't expect to reuse it. NOTE: `size` is Microsoft Graph's reported metadata and can OVERSTATE the actual bytes; the authoritative size is the download response's Content-Length (the served bytes are byte-exact to the source). If a filename may collide at the destination, pass an explicit filename there — two attachments on one task can share a name.",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .optional()
            .describe("List alias (from get_list_config), display name, or Graph list ID. Omit to resolve from the index."),
          task_id: z.string().min(1).describe("Microsoft Graph task id the attachment belongs to."),
          attachment_id: z
            .string()
            .min(1)
            .describe("Attachment id to serve (from list_attachments)."),
          ttl_minutes: z
            .number()
            .int()
            .min(1)
            .max(5)
            .optional()
            .describe("Link lifetime in minutes (1–5, default 5)."),
        },
      },
      async ({ list, task_id, attachment_id, ttl_minutes }): Promise<McpResponse> =>
        this.withGraph("mint_download_link", async (graph) => {
          if (!downloadLinksEnabled(this.env)) {
            return errResponse("download_disabled", {
              detail: "Download links are disabled (ENABLE_DOWNLOAD_LINKS=false).",
            });
          }
          const base = (this.env.SERVICE_BASE_URL ?? "").replace(/\/+$/, "");
          if (!/^https?:\/\/[^/]+/i.test(base)) {
            return errResponse("download_disabled", {
              detail: "SERVICE_BASE_URL is not configured as an absolute URL.",
            });
          }
          if (base.includes("example.workers.dev")) {
            return errResponse("download_disabled", {
              detail: "SERVICE_BASE_URL is still the example placeholder — set it to this Worker's real public origin.",
            });
          }
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }

          // Read metadata from the attachments COLLECTION (omits contentBytes), so
          // minting never pulls the whole file into Worker memory — the bytes are
          // fetched lazily at /download time.
          const attachments = await listAttachments(graph, list_id, task_id);
          const att = attachments.find((a) => a.id === attachment_id);
          if (!att) {
            return errResponse("attachment_not_found", { list_id, task_id, attachment_id });
          }
          if (att["@odata.type"] !== "#microsoft.graph.taskFileAttachment") {
            // Only file attachments carry bytes; reference attachments have none.
            return errResponse("attachment_not_downloadable", { list_id, task_id, attachment_id });
          }
          const filename = att.name;
          const content_type = att.contentType ?? undefined;
          const size = att.size;

          const scope: DownloadCapabilityScope = { list_id, task_id, attachment_id };
          if (filename) scope.filename = filename;
          if (content_type) scope.content_type = content_type;
          if (typeof size === "number") scope.size = size;

          const ttlSeconds = ttl_minutes
            ? Math.min(ttl_minutes * 60, MAX_DOWNLOAD_TTL_SECONDS)
            : undefined;
          const { token, expiresAt } = await createDownloadCapability(this.env, scope, ttlSeconds);
          const download_url = `${base}/download?t=${encodeURIComponent(token)}`;
          log.info("download_link_minted", { list_id, task_id, attachment_id });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  download_url,
                  expires_at: expiresAt,
                  list_id,
                  task_id,
                  attachment_id,
                  filename: filename ?? null,
                  content_type: content_type ?? null,
                  size: size ?? null,
                }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "remove_attachment",
      {
        description:
          "Remove an attachment from a task. Invalidates the list's task cache.",
        inputSchema: {
          list: z.string().min(1).optional().describe("List alias (from get_list_config), display name, or Graph list ID."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
          attachment_id: z
            .string()
            .min(1)
            .describe("Attachment id to delete (from list_attachments)."),
        },
      },
      async ({ list, task_id, attachment_id }): Promise<McpResponse> =>
        this.withGraph("remove_attachment", async (graph) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/attachments/${encodeURIComponent(attachment_id)}`;
          try {
            await graph.deleteResource(url);
            // No DO write: a delete may or may not clear has_attachments (can't
            // tell if it was the last attachment); the next delta sync reconciles.
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ ok: true, list_id, task_id, attachment_id }),
                },
              ],
            };
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("attachment_not_found", { list_id, task_id, attachment_id });
              }
            }
            throw e;
          }
        }),
    );

    this.server.registerTool(
      "get_link_rules",
      {
        description:
          "Return the current link-rules configuration. Rules are applied to task titles (and optionally bodies) after create_task and update_task to auto-create linked resources.",
        inputSchema: {},
      },
      async (): Promise<McpResponse> =>
        instrument("get_link_rules", async () => {
          const config = await loadLinkRules(this.env);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, rule_count: config.rules.length, config }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "set_link_rules",
      {
        description:
          "Replace the link-rules configuration. Each rule's `pattern` is compiled as a JS RegExp and rejected if invalid. Overwrites the entire rules array — include all rules you want active. " +
          "Microsoft To Do allows exactly one linked resource per task, so at most one is created per task: rules are evaluated in array order and the first match wins (rule order = priority). Existing links (including Outlook's built-in one) are never replaced.",
        inputSchema: {
          rules: z
            .array(LinkRuleSchema)
            .describe("Full replacement rules array. Pass [] to clear all rules."),
        },
      },
      async ({ rules }): Promise<McpResponse> =>
        instrument("set_link_rules", async () => {
          // Validate every pattern compiles as a RegExp before writing to KV.
          const invalid: Array<{ id: string; pattern: string; error: string }> = [];
          for (const rule of rules) {
            try {
              new RegExp(rule.pattern, rule.flags);
            } catch (e) {
              invalid.push({
                id: rule.id,
                pattern: rule.pattern,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
          if (invalid.length > 0) {
            return errResponse("invalid_link_rules", {
              invalid,
              hint: "Fix the pattern(s) and retry. Patterns must be valid JS RegExp source strings.",
            });
          }

          const config = LinkRulesConfigSchema.parse({ rules });
          await storeLinkRules(this.env, config);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, rule_count: config.rules.length }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "extract_links",
      {
        description:
          "Apply link rules to an existing task and create a linked resource for the first matching rule. dry_run: true surfaces matches without writing — use for backfill preview. Microsoft To Do allows exactly one linked resource per task, so if the task already has any linked resource the match is reported in `skipped` (reason `todo_one_linked_resource_per_task`) and nothing is changed — existing links are never replaced.",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .describe("List alias (from get_list_config), display name, or Graph list ID that owns the task."),
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
          dry_run: z
            .boolean()
            .optional()
            .describe("When true, returns matches without creating linked resources. Defaults to false."),
        },
      },
      async ({ list, task_id, dry_run = false }): Promise<McpResponse> =>
        this.withGraph("extract_links", async (graph) => {
          const list_id = await this.resolveList(list);
          // Expand linkedResources so we can dedup against existing URLs.
          const taskUrl = new URL(
            `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`,
          );
          taskUrl.searchParams.set("$expand", "linkedResources");

          let task: TodoTask;
          try {
            task = await graph.getJson(taskUrl.toString(), TodoTaskSchema);
          } catch (e) {
            if (e instanceof GraphError) {
              const innerCode = getGraphInnerErrorCode(e.detail);
              if (
                e.status === 404 ||
                (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
              ) {
                return errResponse("task_not_found", { list_id, task_id });
              }
            }
            throw e;
          }

          const config = await loadLinkRules(this.env);
          const matches = runLinkRules(config, task);

          if (dry_run) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    dry_run: true,
                    list_id,
                    task_id,
                    match_count: matches.length,
                    matches,
                  }),
                },
              ],
            };
          }

          // Microsoft To Do allows exactly one linked resource per task. If the
          // task already carries any linked resource (a prior rule link, a
          // manual one, or Outlook's built-in "Open in Outlook"), skip rather
          // than attempt — we never clobber an existing link.
          let hasLink = (task.linkedResources ?? []).length > 0;

          const lrBaseUrl = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/linkedResources`;
          const created: LinkRuleMatch[] = [];
          const skipped: Array<{ match: LinkRuleMatch; reason: string }> = [];
          const failed: Array<{ match: LinkRuleMatch; error: string }> = [];

          for (const match of matches) {
            if (hasLink) {
              skipped.push({ match, reason: "todo_one_linked_resource_per_task" });
              continue;
            }
            try {
              await graph.postJson(
                lrBaseUrl,
                {
                  applicationName: match.applicationName,
                  displayName: match.displayName,
                  externalId: match.externalId,
                  webUrl: match.url,
                },
                LinkedResourceSchema,
              );
              created.push(match);
              hasLink = true;
            } catch (e) {
              // Defense-in-depth: a concurrent writer may have added a link
              // since we counted. Graph signals the per-task limit with
              // innerError `LinkedResourceSizeExceeded` — treat as skip, not fail.
              if (
                e instanceof GraphError &&
                getGraphInnerErrorCode(e.detail) === "LinkedResourceSizeExceeded"
              ) {
                skipped.push({ match, reason: "todo_one_linked_resource_per_task" });
                continue;
              }
              const error =
                e instanceof GraphError
                  ? e.detail
                    ? `${e.message}: ${e.detail}`
                    : e.message
                  : e instanceof Error
                    ? e.message
                    : String(e);
              failed.push({ match, error });
              log.warn("extract_links_create_failed", {
                rule_id: match.rule_id,
                url: match.url,
                error,
              });
            }
          }

          // Link-rule matches create linked resources (not an indexed field);
          // the task row is already propagated by the calling create/update_task.

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  dry_run: false,
                  list_id,
                  task_id,
                  created,
                  skipped,
                  failed,
                }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "get_attachment_config",
      {
        description:
          "Return the current attachment configuration (max_inline_bytes). The hard ceiling is 3072 KiB (Graph limit confirmed in Phase 0.5b); set_attachment_config cannot exceed it.",
        inputSchema: {},
      },
      async (): Promise<McpResponse> =>
        instrument("get_attachment_config", async () => {
          const config = await loadAttachmentConfig(this.env);
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, config }) }],
          };
        }),
    );

    this.server.registerTool(
      "set_attachment_config",
      {
        description:
          "Update the attachment configuration. max_inline_bytes is the web-upload cutover: files at or below it attach inline, larger ones (up to 25 MB) via a chunked upload-session (must be ≤ 3072 KiB). Overwrites the full config.",
        inputSchema: {
          max_inline_bytes: z
            .number()
            .int()
            .min(1)
            .max(MAX_INLINE_ATTACHMENT_BYTES)
            .describe(
              `Maximum raw bytes for inline uploads. Hard ceiling: ${MAX_INLINE_ATTACHMENT_BYTES} (3072 KiB).`,
            ),
        },
      },
      async ({ max_inline_bytes }): Promise<McpResponse> =>
        instrument("set_attachment_config", async () => {
          const config = AttachmentConfigSchema.parse({ max_inline_bytes });
          await storeAttachmentConfig(this.env, config);
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, config }) }],
          };
        }),
    );

    this.server.registerTool(
      "get_list_config",
      {
        description:
          "Return the current list classification config (patterns) and alias map. " +
          "Aliases are shown with their resolved display name when the index roster is warm. " +
          "Call list_lists first if you need display names and the index may be cold. " +
          "Also returns the sync policy: no_sync and sync_flagged_emails.",
        inputSchema: {},
      },
      async (): Promise<McpResponse> =>
        instrument("get_list_config", async () => {
          const config = await loadListsConfig(this.env);
          let roster: ListRow[] = [];
          try {
            roster = await this.#index().listLists();
          } catch (e) {
            log.warn("index_roster_read_failed", { error: String(e) });
          }
          const listById = new Map(roster.map((l) => [l.list_id, l.display_name]));
          const enrichedAliases = Object.fromEntries(
            Object.entries(config.aliases).map(([alias, id]) => [
              alias,
              { list_id: id, display_name: listById.get(id) ?? null },
            ]),
          );
          // Pinned classifications (ID → class), resolved to display names. These
          // win over name patterns and survive renames.
          const enrichedOverrides = Object.fromEntries(
            Object.entries(config.overrides).map(([id, type]) => [
              id,
              { type, display_name: listById.get(id) ?? null },
            ]),
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  pattern_count: config.patterns.length,
                  alias_count: Object.keys(config.aliases).length,
                  override_count: Object.keys(config.overrides).length,
                  patterns: config.patterns,
                  aliases: enrichedAliases,
                  overrides: enrichedOverrides,
                  no_sync: config.no_sync,
                  sync_flagged_emails: config.sync_flagged_emails,
                }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "set_list_config",
      {
        description:
          "Update list config. Omitted fields are preserved (not reset). `patterns` replaces the " +
          "classification pattern list (pass [] to clear; first match wins, emoji stripped, each must be " +
          "valid JS RegExp). `overrides` replaces the ID-pinned classification map (Graph list ID → class), " +
          "which wins over name patterns and survives renames; list_lists auto-pins newly name-matched lists, " +
          "so use this to change a pin or drop a key to revert a list to pattern-based. `no_sync` excludes " +
          'lists from delta sync, matched by wellknownListName (e.g. "flaggedEmails") or Graph list ID — the ' +
          "list stays visible and on-demand-readable but is not indexed. `sync_flagged_emails` opts the large " +
          "flaggedEmails well-known list back IN (it is skipped by default to conserve the daily write budget). " +
          "Does not affect aliases — use set_list_alias.",
        inputSchema: {
          patterns: z
            .array(ListPatternSchema)
            .optional()
            .describe(
              "Full replacement pattern array (omit to leave unchanged; [] to clear). Each: pattern " +
              "(RegExp source), flags (default 'i'), type ('todo' | 'reference' | 'excluded').",
            ),
          overrides: z
            .record(z.string().min(1), z.enum(["todo", "reference", "excluded"]))
            .optional()
            .describe(
              "Full replacement map of Graph list ID → class (omit to leave unchanged; {} to clear all pins). " +
              "Pinned classes win over name patterns and survive renames. Dropping a key reverts that list to " +
              "pattern-based — it will re-pin from patterns on the next list_lists.",
            ),
          no_sync: z
            .array(z.string().min(1))
            .optional()
            .describe(
              'Lists excluded from sync, by wellknownListName (e.g. "flaggedEmails") or Graph list ID. ' +
              "Omit to leave unchanged. flaggedEmails is already skipped by default.",
            ),
          sync_flagged_emails: z
            .boolean()
            .optional()
            .describe("Set true to index the large flaggedEmails list (off by default). Omit to leave unchanged."),
        },
      },
      async ({ patterns, overrides, no_sync, sync_flagged_emails }): Promise<McpResponse> =>
        instrument("set_list_config", async () => {
          if (patterns !== undefined) {
            const invalid: Array<{ pattern: string; flags: string; error: string }> = [];
            for (const p of patterns) {
              try {
                new RegExp(p.pattern, p.flags);
              } catch (e) {
                invalid.push({ pattern: p.pattern, flags: p.flags, error: e instanceof Error ? e.message : String(e) });
              }
            }
            if (invalid.length > 0) {
              return errResponse("invalid_list_patterns", {
                invalid,
                hint: "Fix the pattern(s) and retry. Patterns must be valid JS RegExp source strings.",
              });
            }
          }

          const existing = await loadListsConfig(this.env);
          const config = ListsConfigSchema.parse({
            patterns: patterns ?? existing.patterns,
            aliases: existing.aliases,
            overrides: overrides ?? existing.overrides,
            no_sync: no_sync ?? existing.no_sync,
            sync_flagged_emails: sync_flagged_emails ?? existing.sync_flagged_emails,
          });
          await storeListsConfig(this.env, config);
          // Reconcile promptly (purge or re-enable) instead of waiting for cron.
          await this.#index()
            .ensureSyncing()
            .catch((e) => log.warn("index_ensure_syncing_failed", { error: String(e) }));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  pattern_count: config.patterns.length,
                  override_count: Object.keys(config.overrides).length,
                  no_sync: config.no_sync,
                  sync_flagged_emails: config.sync_flagged_emails,
                }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "set_list_alias",
      {
        description:
          "Add or update a single list alias. The alias is a short lowercase handle (e.g. 'inbox', " +
          "'finance') that can be used in place of a Graph list ID in any list-targeting tool. " +
          "list_id_or_name accepts a Graph list ID or a display name (emoji optional — matched " +
          "case-insensitively against the cached roster). Call list_lists first to see available " +
          "lists. Multiple aliases may point to the same list.",
        inputSchema: {
          alias: z
            .string()
            .min(1)
            .describe("Short handle to register (e.g. 'inbox', 'finance', 'legal')."),
          list_id_or_name: z
            .string()
            .min(1)
            .describe(
              "Graph list ID or display name of the target list. " +
              "Display name matching is emoji-stripped and case-insensitive.",
            ),
        },
      },
      async ({ alias, list_id_or_name }): Promise<McpResponse> =>
        instrument("set_list_alias", async () => {
          // Resolve the target against the DO roster.
          let roster: ListRow[] = [];
          try {
            roster = await this.#index().listLists();
          } catch (e) {
            log.warn("index_roster_read_failed", { error: String(e) });
          }
          if (roster.length === 0) {
            return errResponse("list_index_cold", {
              hint: "Call list_lists first to warm the index, then retry set_list_alias.",
            });
          }

          const needle = stripEmoji(list_id_or_name).toLowerCase();
          // Match by Graph list ID (exact) or display name (emoji-stripped, case-insensitive).
          const match = roster.find(
            (l) =>
              l.list_id === list_id_or_name ||
              stripEmoji(l.display_name ?? "").toLowerCase() === needle,
          );
          if (!match) {
            return errResponse("list_not_found", {
              alias,
              list_id_or_name,
              hint: "Check the display name or ID against list_lists output. Names are matched case-insensitively with emoji stripped.",
            });
          }

          const existing = await loadListsConfig(this.env);
          const updatedAliases = { ...existing.aliases, [alias]: match.list_id };
          // Preserve no_sync / sync_flagged_emails — omitting them here would let
          // Zod re-apply their defaults and silently wipe the user's sync policy.
          const config = ListsConfigSchema.parse({
            patterns: existing.patterns,
            aliases: updatedAliases,
            no_sync: existing.no_sync,
            sync_flagged_emails: existing.sync_flagged_emails,
          });
          await storeListsConfig(this.env, config);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  alias,
                  list_id: match.list_id,
                  display_name: match.display_name,
                }),
              },
            ],
          };
        }),
    );

    // -- Phase 5: cross-list query / search / aggregation / ops tools -------
    // All served from the TodoIndex DO. Status enum mirrors the Graph task
    // statuses (shared by query_tasks/search_tasks).
    const StatusEnum = z.enum([
      "notStarted",
      "inProgress",
      "completed",
      "waitingOnOthers",
      "deferred",
    ]);
    const ClassEnum = z.enum(["todo", "reference", "excluded", "unclassified"]);

    this.server.registerTool(
      "query_tasks",
      {
        description:
          "Filtered cross-list task query served from the TodoIndex. Combine any of: lists (aliases/names/ids), status, date ranges, importance, has_checklist. Dates accept ISO 8601 ('2026-06-01') or relative offsets ('+7d', '-30d', '-12h'). Returns summaries + an opaque keyset next_cursor (pass back as `cursor`; absent on the last page). Empty while the index is warming — retry shortly.",
        inputSchema: {
          lists: z
            .array(z.string().min(1))
            .min(1)
            .optional()
            .describe("Restrict to these lists (aliases, display names, or Graph list IDs). Omit for all lists (do not pass an empty array)."),
          status: z
            .union([StatusEnum, z.array(StatusEnum).min(1)])
            .optional()
            .describe("One status or an array of statuses to include."),
          due_before: z.string().optional().describe("Due on/before this date (ISO or relative)."),
          due_after: z.string().optional().describe("Due on/after this date (ISO or relative)."),
          completed_before: z.string().optional().describe("Completed on/before this date (ISO or relative)."),
          completed_after: z.string().optional().describe("Completed on/after this date (ISO or relative)."),
          created_after: z.string().optional().describe("Created on/after this date (ISO or relative)."),
          importance: z.enum(["low", "normal", "high"]).optional().describe("Filter by importance."),
          has_checklist: z
            .boolean()
            .optional()
            .describe("true = has checklist items; false = none or unknown (delta-sourced rows carry no expansion)."),
          has_open_checklist_item: z
            .boolean()
            .optional()
            .describe("true = task has ≥1 UNCHECKED checklist item / subtask / step (the 'waiting on something' follow-up filter); false = none open. Requires ENABLE_CHECKLIST_CACHE."),
          limit: z.number().int().min(1).max(200).optional().describe("Max rows per page. Default 50; max 200."),
          cursor: z.string().optional().describe("Opaque keyset token from a prior query_tasks response."),
          types: z
            .array(ClassEnum)
            .min(1)
            .optional()
            .describe("Include only tasks from lists of these classifications (todo/reference/excluded/unclassified). Requires classification patterns configured."),
          exclude_types: z
            .array(ClassEnum)
            .min(1)
            .optional()
            .describe('Exclude tasks from lists of these classifications. exclude_types:["excluded"] drops flagged-email/excluded noise. Exclude wins over types on overlap.'),
          completed: z
            .boolean()
            .optional()
            .describe("Convenience: true = completed only; false = open tasks. Mutually exclusive with status."),
        },
      },
      async ({
        lists,
        status,
        due_before,
        due_after,
        completed_before,
        completed_after,
        created_after,
        importance,
        has_checklist,
        has_open_checklist_item,
        limit,
        cursor,
        types,
        exclude_types,
        completed,
      }): Promise<McpResponse> =>
        instrument("query_tasks", async () => {
          // Parse each supplied date; an unparseable value is a hard error
          // rather than a silently-dropped filter.
          const dateInputs: Array<[string, string | undefined]> = [
            ["due_before", due_before],
            ["due_after", due_after],
            ["completed_before", completed_before],
            ["completed_after", completed_after],
            ["created_after", created_after],
          ];
          const dates: Record<string, number> = {};
          for (const [field, value] of dateInputs) {
            if (value === undefined) continue;
            const ms = parseDateInput(value);
            if (ms === null) {
              return errResponse("invalid_date", {
                field,
                value,
                hint: "Use ISO 8601 (2026-06-01[T10:00:00Z]) or a relative offset (+7d, -30d, -12h).",
              });
            }
            dates[field] = ms;
          }

          const statusResolved = resolveStatusFilter(status, completed);
          if (!statusResolved.ok) {
            return errResponse("conflicting_status_filter", {
              hint: "Supply either `status` or `completed`, not both. `completed` is a convenience for completed-only / open-only.",
            });
          }
          const statusArr = statusResolved.status;

          const explicitIds =
            lists && lists.length > 0
              ? await Promise.all(lists.map((l) => this.resolveList(l)))
              : undefined;
          let listIds = explicitIds;
          if ((types && types.length > 0) || (exclude_types && exclude_types.length > 0)) {
            const cfg = await loadListsConfig(this.env);
            let roster: ListRow[] = [];
            try {
              roster = await this.#index().listLists();
            } catch (e) {
              log.warn("index_roster_read_failed", { error: String(e) });
            }
            listIds = resolveListScope({
              roster: roster.map((r) => ({ list_id: r.list_id, display_name: r.display_name })),
              config: cfg,
              lists: explicitIds,
              types,
              exclude_types,
            });
          }
          // A classification filter that matched no lists → genuinely empty
          // (NOT "all lists": an empty `lists` array would skip the DO filter and
          // widen query() to every list). Mirrors get_pending_across_lists.
          // (This returns before #warmIfEmpty, so a cold index isn't warmed from
          // a types-filtered call; any roster read / the cron heartbeat warms it.)
          if (listIds !== undefined && listIds.length === 0) {
            return indexTasksResponse({ rows: [] });
          }

          const { rows, next_cursor } = await this.#index().query({
            lists: listIds,
            status: statusArr,
            due_before: dates.due_before,
            due_after: dates.due_after,
            completed_before: dates.completed_before,
            completed_after: dates.completed_after,
            created_after: dates.created_after,
            importance,
            has_checklist,
            has_open_checklist_item,
            limit,
            cursor,
          });
          await this.#warmIfEmpty(rows.length);
          return indexTasksResponse({ rows, next_cursor });
        }),
    );

    this.server.registerTool(
      "search_tasks",
      {
        description:
          "Full-text search over task titles and bodies (FTS5), across lists, served from the TodoIndex. By default also matches text inside checklist items (a.k.a. subtasks / steps) when the checklist cache is enabled — set include_checklist:false for a title/body-only search. Supports bare terms, \"quoted phrases\", column scoping (title:foo), boolean AND/OR/NOT, and prefix* matching. Optionally restrict by lists and status. Returns task summaries; title/body matches come first (by relevance), then tasks that matched only via a checklist item.",
        inputSchema: {
          query: z.string().min(1).describe("FTS5 query string."),
          include_checklist: z
            .boolean()
            .optional()
            .describe("Also match checklist item (subtask / step) text, appending tasks that matched only there. Defaults true; no-op when ENABLE_CHECKLIST_CACHE is off. Set false for title/body only."),
          lists: z
            .array(z.string().min(1))
            .min(1)
            .optional()
            .describe("Restrict to these lists (aliases, display names, or Graph list IDs). Omit to search all (do not pass an empty array)."),
          status: z
            .union([StatusEnum, z.array(StatusEnum).min(1)])
            .optional()
            .describe("One status or an array of statuses to include."),
          limit: z.number().int().min(1).max(200).optional().describe("Max hits. Default 50; max 200."),
          types: z
            .array(ClassEnum)
            .min(1)
            .optional()
            .describe("Include only tasks from lists of these classifications (todo/reference/excluded/unclassified). Requires classification patterns configured."),
          exclude_types: z
            .array(ClassEnum)
            .min(1)
            .optional()
            .describe('Exclude tasks from lists of these classifications. exclude_types:["excluded"] drops flagged-email/excluded noise. Exclude wins over types on overlap.'),
          completed: z
            .boolean()
            .optional()
            .describe("Convenience: true = completed only; false = open tasks. Mutually exclusive with status."),
        },
      },
      async ({ query, lists, status, limit, types, exclude_types, completed, include_checklist }): Promise<McpResponse> =>
        instrument("search_tasks", async () => {
          const statusResolved = resolveStatusFilter(status, completed);
          if (!statusResolved.ok) {
            return errResponse("conflicting_status_filter", {
              hint: "Supply either `status` or `completed`, not both.",
            });
          }
          const statusArr = statusResolved.status;

          const explicitIds =
            lists && lists.length > 0
              ? await Promise.all(lists.map((l) => this.resolveList(l)))
              : undefined;
          let listIds = explicitIds;
          if ((types && types.length > 0) || (exclude_types && exclude_types.length > 0)) {
            const cfg = await loadListsConfig(this.env);
            let roster: ListRow[] = [];
            try {
              roster = await this.#index().listLists();
            } catch (e) {
              log.warn("index_roster_read_failed", { error: String(e) });
            }
            listIds = resolveListScope({
              roster: roster.map((r) => ({ list_id: r.list_id, display_name: r.display_name })),
              config: cfg,
              lists: explicitIds,
              types,
              exclude_types,
            });
          }
          // A classification filter that matched no lists → genuinely empty
          // (NOT "all lists": an empty `lists` array would skip the DO filter and
          // widen search() to every list). Mirrors get_pending_across_lists.
          // (This returns before #warmIfEmpty, so a cold index isn't warmed from
          // a types-filtered call; any roster read / the cron heartbeat warms it.)
          if (listIds !== undefined && listIds.length === 0) {
            return indexTasksResponse({ rows: [], extra: { query } });
          }
          let result: { rows: TaskRow[] };
          try {
            result = await this.#index().search({
              query,
              lists: listIds,
              status: statusArr,
              limit,
              // Default ON: include checklist (subtask/step) text unless the
              // caller opts out. No-op when the checklist cache is disabled.
              include_checklist: include_checklist ?? true,
            });
          } catch (e) {
            // FTS5 raises on malformed query syntax (unbalanced quotes, bad
            // operators). Map to a friendly error instead of unexpected_error.
            return errResponse("invalid_search_query", {
              query,
              message: e instanceof Error ? e.message : String(e),
              hint: 'FTS5 syntax: bare terms, "phrases", title:term, AND/OR/NOT, prefix*.',
            });
          }
          await this.#warmIfEmpty(result.rows.length);
          return indexTasksResponse({ rows: result.rows, extra: { query } });
        }),
    );

    this.server.registerTool(
      "search_checklist_items",
      {
        description:
          "Cross-task search over checklist items — a.k.a. subtasks, or 'steps' in the To Do app — served from the TodoIndex (requires ENABLE_CHECKLIST_CACHE). Use it to treat checklist items as follow-ups: find which tasks have an open item, or search their text. Two modes: pass `query` for FTS5 over item text (ranked by relevance); omit it to list pending items oldest-first — the 'what am I waiting on longest' view. `pending_only` (default true) restricts to unchecked items. Optionally restrict by `lists`. Returns items grouped by their parent task.",
        inputSchema: {
          query: z
            .string()
            .min(1)
            .optional()
            .describe("FTS5 query over checklist item text. Omit to list (pending) items oldest-first."),
          pending_only: z
            .boolean()
            .optional()
            .describe("Only unchecked items. Defaults true (the follow-up use case)."),
          lists: z
            .array(z.string().min(1))
            .min(1)
            .optional()
            .describe("Restrict to these lists (aliases, display names, or Graph list IDs). Omit to search all (do not pass an empty array)."),
          limit: z.number().int().min(1).max(200).optional().describe("Max items. Default 50; max 200."),
        },
      },
      async ({ query, pending_only, lists, limit }): Promise<McpResponse> =>
        instrument("search_checklist_items", async () => {
          if (!checklistCacheEnabled(this.env)) {
            return errResponse("checklist_cache_disabled", {
              hint: "Set ENABLE_CHECKLIST_CACHE=true to enable cross-task checklist queries.",
            });
          }
          const listIds =
            lists && lists.length > 0
              ? await Promise.all(lists.map((l) => this.resolveList(l)))
              : undefined;

          let result: { rows: ChecklistSearchRow[] };
          try {
            result = await this.#index().searchChecklistItems({
              query,
              pending_only,
              lists: listIds,
              limit,
            });
          } catch (e) {
            // FTS5 raises on malformed query syntax — map to a friendly error.
            return errResponse("invalid_search_query", {
              query,
              message: e instanceof Error ? e.message : String(e),
              hint: 'FTS5 syntax: bare terms, "phrases", AND/OR/NOT, prefix*.',
            });
          }
          await this.#warmIfEmpty(result.rows.length);
          return checklistItemsResponse(result.rows, {
            query,
            pending_only: pending_only ?? true,
          });
        }),
    );

    this.server.registerTool(
      "find_task_list",
      {
        description:
          "Resolve which list owns a task id. Primary-key lookup in the TodoIndex (source: 'index'); on a cold-index miss, falls back to probing the live roster (source: 'graph'). Returns { list_id, display_name } or task_not_found.",
        inputSchema: {
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
        },
      },
      async ({ task_id }): Promise<McpResponse> =>
        this.withGraph("find_task_list", async (graph) => {
          const found = await this.#index()
            .findListForTask(task_id)
            .catch((e) => {
              log.warn("index_find_list_failed", { task_id, error: String(e) });
              return null;
            });
          if (found) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    source: "index",
                    list_id: found.list_id,
                    display_name: found.display_name,
                  }),
                },
              ],
            };
          }

          // Cold-index fallback: probe each roster list for the task id. Graph
          // has no "get task by id without a list", so this is N bounded GETs;
          // 404 is expected on all but the owning list. Stop once one hits.
          const { lists } = await this.getRoster(graph);
          const hits: Array<{ list_id: string; display_name: string | null }> = [];
          await mapPool(lists, 6, async (l) => {
            if (hits.length > 0) return; // early-bail once a worker found the owner
            const url = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(l.id)}/tasks/${encodeURIComponent(task_id)}`;
            try {
              await graph.getJson(url, TodoTaskSchema);
              hits.push({ list_id: l.id, display_name: l.displayName ?? null });
            } catch (e) {
              if (e instanceof GraphError) {
                const innerCode = getGraphInnerErrorCode(e.detail);
                if (
                  e.status === 404 ||
                  (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")
                ) {
                  return; // not in this list (or malformed id) — keep probing
                }
              }
              throw e;
            }
          });

          const hit = hits[0];
          if (hit) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: true,
                    source: "graph",
                    list_id: hit.list_id,
                    display_name: hit.display_name,
                  }),
                },
              ],
            };
          }
          return errResponse("task_not_found", { task_id });
        }),
    );

    this.server.registerTool(
      "get_pending_across_lists",
      {
        description:
          "Return open tasks (status notStarted/inProgress/waitingOnOthers) across all lists of a given classification (default 'todo'). Requires list classification patterns (set_list_config). Served from the TodoIndex; returns summaries + keyset next_cursor.",
        inputSchema: {
          type: ClassEnum.optional().describe("List classification to include. Defaults to 'todo'."),
          limit: z.number().int().min(1).max(200).optional().describe("Max rows per page. Default 50; max 200."),
          cursor: z.string().optional().describe("Opaque keyset token from a prior response."),
        },
      },
      async ({ type = "todo", limit, cursor }): Promise<McpResponse> =>
        instrument("get_pending_across_lists", async () => {
          const config = await loadListsConfig(this.env);
          if (config.patterns.length === 0) {
            return errResponse("no_list_patterns_configured", {
              hint: "Configure list classification via set_list_config, then retry.",
            });
          }
          let roster: ListRow[] = [];
          try {
            roster = await this.#index().listLists();
          } catch (e) {
            log.warn("index_roster_read_failed", { error: String(e) });
          }
          const listIds = roster
            .filter((l) => classifyList(l.display_name ?? "", config, l.list_id) === type)
            .map((l) => l.list_id);
          // No lists of this class → genuinely empty (NOT "all lists": an empty
          // `lists` filter would widen query() to every list).
          if (listIds.length === 0) {
            return indexTasksResponse({ rows: [], extra: { type } });
          }
          const { rows, next_cursor } = await this.#index().query({
            lists: listIds,
            status: ["notStarted", "inProgress", "waitingOnOthers"],
            limit,
            cursor,
          });
          return indexTasksResponse({ rows, next_cursor, extra: { type } });
        }),
    );

    this.server.registerTool(
      "get_recently_completed",
      {
        description:
          "Return tasks completed within the last N days (default 7), most-recent first. Optionally scope to one `list` or to all lists of a classification `type` (requires set_list_config). Served from the TodoIndex; a bounded recent view (no pagination).",
        inputSchema: {
          days: z.number().int().min(1).optional().describe("Look-back window in days. Default 7."),
          list: z
            .string()
            .min(1)
            .optional()
            .describe("Restrict to one list (alias, display name, or Graph list ID)."),
          type: ClassEnum.optional().describe("Restrict to all lists of this classification. Ignored when `list` is given."),
          limit: z.number().int().min(1).max(200).optional().describe("Max rows. Default 50; max 200."),
        },
      },
      async ({ days = 7, list, type, limit }): Promise<McpResponse> =>
        instrument("get_recently_completed", async () => {
          const completed_after = Date.now() - days * 86_400_000;
          let listIds: string[] | undefined;
          if (list !== undefined) {
            listIds = [await this.resolveList(list)];
          } else if (type !== undefined) {
            const config = await loadListsConfig(this.env);
            if (config.patterns.length === 0) {
              return errResponse("no_list_patterns_configured", {
                hint: "Configure list classification via set_list_config, then retry.",
              });
            }
            let roster: ListRow[] = [];
            try {
              roster = await this.#index().listLists();
            } catch (e) {
              log.warn("index_roster_read_failed", { error: String(e) });
            }
            listIds = roster
              .filter((l) => classifyList(l.display_name ?? "", config, l.list_id) === type)
              .map((l) => l.list_id);
            // type given but no lists match → empty (don't widen to all lists).
            if (listIds.length === 0) {
              return indexTasksResponse({ rows: [], extra: { days, type } });
            }
          }

          const { rows } = await this.#index().query({
            status: ["completed"],
            completed_after,
            lists: listIds,
            limit,
          });
          // query() orders by modified_at DESC; re-sort by completed_at DESC so
          // "most recently completed" is accurate. For completed tasks the two
          // usually coincide; they can diverge only for a task edited after
          // completion, and only within this single (un-paginated) page.
          const sorted = [...rows].sort(
            (a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0),
          );
          return indexTasksResponse({ rows: sorted, extra: { days, ...(type ? { type } : {}) } });
        }),
    );

    this.server.registerTool(
      "sync_status",
      {
        description:
          "Read-only health probe for the TodoIndex delta sync. Returns one report per resource (the 'lists' roster + one 'tasks:{listId}' per list) with status, last_synced_at, mid_cycle (resume cursor outstanding), last_error, and row_count — plus totals { tasks, lists, all_idle }. all_idle=true means every resource is fully caught up. Also returns `notifications` (webhook-delivery health): last_notification_at (epoch ms of the last accepted Graph change notification), notifications_total (cumulative accepted), and minutes_since. A null/very-old last_notification_at while subscription coverage is full means Graph has silently stopped delivering todoTask notifications and sync is riding the delta poll only — pair this with subscription_status (coverage) to tell 'no subscriptions' from 'subscriptions present but not delivering'.",
        inputSchema: {},
      },
      async (): Promise<McpResponse> =>
        instrument("sync_status", async () => {
          const status = await this.#index().syncStatus();
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: true, ...status }) }],
          };
        }),
    );

    this.server.registerTool(
      "resync",
      {
        description:
          "Force a delta re-baseline: drop indexed rows + delta tokens (one list when `list` is given, else everything) and arm the sync alarm now. Manual twin of the automatic 410 re-baseline; use to recover a list that drifted. Returns ok + the resync scope.",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .optional()
            .describe("Restrict the re-baseline to one list (alias, display name, or Graph list ID). Omit to re-baseline everything."),
        },
      },
      async ({ list }): Promise<McpResponse> =>
        instrument("resync", async () => {
          const list_id = list !== undefined ? await this.resolveList(list) : undefined;
          await this.#index().resync(list_id);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, resync: list_id ?? "all" }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "subscription_status",
      {
        description:
          "Read-only introspection for the Graph change-notification (webhook) layer. Returns the effective env-derived config (subscriptions on/off, webhook URL, lifetime, renew margin, max ops/cycle, delta interval, My Day scan cadence) and a three-way coverage diff: `dark` (roster lists with no live Graph subscription), `dead` (local records whose Graph subscription is gone — the silent-drift case the reconciler now self-heals), and `orphan` (subscriptions on this Worker's webhook URL that are unwanted or untracked, leaking tenant quota). `summary` has counts; `graph_subs_ours` is -1 when Graph was unreachable, in which case `graph_error` is set and `dark` falls back to roster-without-local-record. Also reports `lifecycle` (how many of our live subs carry a lifecycleNotificationUrl). Pass `include_raw: true` to also dump the raw Graph subscription objects under `graph_raw` (applicationId/creatorId/changeType/expiration per sub; clientState omitted) for deeper diagnostics — omitted by default. Never writes. Config is read from runtime env bindings (what wrangler.jsonc produced), not the file itself.",
        inputSchema: {
          include_raw: z
            .boolean()
            .optional()
            .describe(
              "Include the raw Graph subscription objects (clientState omitted) under `graph_raw`. Off by default; opt in for diagnostics such as spotting a wrong owning application.",
            ),
        },
      },
      async ({ include_raw }): Promise<McpResponse> =>
        instrument("subscription_status", async () => {
          const status = await this.#index().subscriptionStatus({ includeRaw: include_raw === true });
          return {
            content: [{ type: "text", text: JSON.stringify(status) }],
          };
        }),
    );

    this.server.registerTool(
      "recreate_subscriptions",
      {
        description:
          "Tear down and re-mint Graph change-notification subscriptions so they pick up the current creation shape — notably lifecycleNotificationUrl, which cannot be PATCHed onto an existing subscription and is what keeps an Exchange-backed todoTask subscription from going dormant (validating + renewing but never delivering). Clears the local record(s); the next reconcile cycle tears down the now-untracked old Graph subs as orphans and creates fresh ones for the wanted lists (recovery rides the delta poll in the meantime). Pass `list` to recreate one list's subscription (the delivery experiment: recreate one, leave the rest as a control, then watch sync_status.notifications.last_notification_at); omit to recreate the whole fleet. Returns ok + how many local records were cleared.",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Recreate only this list's subscription (alias, display name, or Graph list ID). Omit to recreate every subscription.",
            ),
        },
      },
      async ({ list }): Promise<McpResponse> =>
        instrument("recreate_subscriptions", async () => {
          const list_id = list !== undefined ? await this.resolveList(list) : undefined;
          const r = await this.#index().recreateSubscriptions(list_id);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: true, scope: list_id ?? "all", cleared: r.cleared }),
              },
            ],
          };
        }),
    );

    // -- My Day (opt-in, Substrate endpoint) ---------------------------------
    // Registered unconditionally; each gates at invocation via withSubstrate,
    // which returns my_day_disabled when ENABLE_MY_DAY != "true" and
    // my_day_unavailable when the EXO scope isn't consented/granted. This keeps
    // the tool list stable across the flag (matches create_upload_link).
    this.server.registerTool(
      "add_to_my_day",
      {
        description:
          "Add a Microsoft To Do task to My Day (undocumented Substrate endpoint). Sets the task's CommittedDay. `date` defaults to today in the Worker's configured timezone; pass an explicit YYYY-MM-DD (interpreted in the user's local timezone) to target another day. Also seeds the task's My Day manual-order position (CommittedOrder = now), so it appears at the top of My Day and can be reordered with reorder_my_day_task — re-adding a task therefore bumps it back to the top. Returns the task's current detail (status, importance, dates, etc.) from the same response. Note: committed_day records only the most recent date the task was on My Day (whether or not completed); there is no history beyond that single last-on-My-Day date. Opt-in: requires ENABLE_MY_DAY=true and the Exchange Online Tasks.ReadWrite scope.",
        inputSchema: {
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
          list: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Owning list (alias, display name, or Graph list ID). Optional — resolved from the index when omitted; pass it if the task isn't indexed yet.",
            ),
          date: z
            .string()
            .optional()
            .describe("Target day as YYYY-MM-DD. Defaults to today in the Worker timezone."),
        },
      },
      async ({ task_id, list, date }): Promise<McpResponse> =>
        this.withSubstrate("add_to_my_day", async (sub) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          const day = date ?? todayInTimeZone(this.env.TIMEZONE);
          if (!MY_DAY_DATE_RE.test(day)) {
            return errResponse("invalid_date", { date: day, hint: "Use YYYY-MM-DD." });
          }
          // Seed the My Day manual-order position (CommittedOrder = now) so the
          // freshly-added task lands at the TOP of My Day (highest CommittedOrder)
          // and is immediately reorderable — mirroring how a new task gets an
          // OrderDateTime, and how the To Do app surfaces newly-added My Day items
          // at the top. now() (UTC ISO, ms) is strictly greater than existing past
          // CommittedOrder values, so a re-add also bumps the task to the top.
          const committedOrder = new Date().toISOString();
          // Set CommittedDay AND clear PostponedDay. A task previously removed
          // from My Day carries PostponedDay=that-day; while PostponedDay==today
          // the client suppresses the task from My Day even with CommittedDay set,
          // so adding it back must clear the postpone (what the official client
          // does). CommittedDay is a bare date in the Worker's timezone — the
          // server stores it at UTC midnight and the client renders it correctly.
          const task = await sub.patchTask(list_id, task_id, {
            CommittedDay: day,
            PostponedDay: null,
            CommittedOrder: committedOrder,
          });
          // Write-through into the cache so list_my_day_tasks reflects this add
          // immediately, without waiting for the next background scan. Mirror
          // whatever Substrate echoed back, falling back to the values we sent
          // (Substrate occasionally omits an echoed field).
          await this.#index().updateMyDayFields(task_id, {
            committed_day: task.CommittedDay ? task.CommittedDay.slice(0, 10) : day,
            postponed_day: task.PostponedDay ? task.PostponedDay.slice(0, 10) : null,
            order_datetime: task.OrderDateTime ?? null,
            committed_order: task.CommittedOrder ?? committedOrder,
          });
          const committed_day = committedDatePart(task.CommittedDay);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  list_id,
                  task_id,
                  title: task.Subject ?? null,
                  committed_day,
                  committed_day_raw: task.CommittedDay ?? null,
                  postponed_day_raw: task.PostponedDay ?? null,
                  in_my_day: committed_day === day,
                  ...projectSubstrateTaskDetails(task),
                }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "remove_from_my_day",
      {
        description:
          "Remove a Microsoft To Do task from My Day (undocumented Substrate endpoint) by clearing its CommittedDay. Returns the task's current detail (status, importance, dates, etc.) from the same response. Note: committed_day records only the most recent date the task was on My Day (whether or not completed); there is no history beyond that single last-on-My-Day date. Opt-in: requires ENABLE_MY_DAY=true and the Exchange Online Tasks.ReadWrite scope.",
        inputSchema: {
          task_id: z.string().min(1).describe("Microsoft Graph task id."),
          list: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Owning list (alias, display name, or Graph list ID). Optional — resolved from the index when omitted.",
            ),
        },
      },
      async ({ task_id, list }): Promise<McpResponse> =>
        this.withSubstrate("remove_from_my_day", async (sub) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          const task = await sub.patchTask(list_id, task_id, { CommittedDay: null });
          // Write-through: drop My Day membership from the cache immediately.
          // order_datetime stays (source-list manual order is independent of My
          // Day). Honor whatever PostponedDay Substrate echoed (the app sets
          // PostponedDay=today on removal; mirror it if present, else null).
          await this.#index().updateMyDayFields(task_id, {
            committed_day: null,
            committed_order: null,
            postponed_day: task.PostponedDay ? task.PostponedDay.slice(0, 10) : null,
          });
          const committed_day = committedDatePart(task.CommittedDay);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  list_id,
                  task_id,
                  title: task.Subject ?? null,
                  committed_day,
                  committed_day_raw: task.CommittedDay ?? null,
                  in_my_day: committed_day !== null,
                  ...projectSubstrateTaskDetails(task),
                }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "list_my_day_tasks",
      {
        description:
          "List Microsoft To Do tasks in My Day for a given day (cache-backed, zero live Substrate round-trips). `date` defaults to today in the Worker's configured timezone. Reads the SQLite cache populated by the background My Day Substrate scan (cadence: MY_DAY_SCAN_EVERY_N_CYCLES × DELTA_SYNC_INTERVAL_MIN, default ~hourly) and by write-through on add_to_my_day / remove_from_my_day. Faithful to the To Do app's My Day filter (committed_day matches AND not postponed to that same day). Sort: committed_order DESC (the My Day drag-to-reorder order, mirroring the app), falling back to order_datetime for tasks not yet assigned a My Day order. Response includes cache_as_of (epoch ms of last scan) and stale (true when the scan hasn't completed in ~3× its window). Opt-in: requires ENABLE_MY_DAY=true and the Exchange Online Tasks.ReadWrite scope.",
        inputSchema: {
          date: z
            .string()
            .optional()
            .describe("Day to list as YYYY-MM-DD. Defaults to today in the Worker timezone."),
        },
      },
      async ({ date }): Promise<McpResponse> =>
        // Still gated by withSubstrate so the tool stays opt-in and the
        // my_day_unavailable / EXO-disabled paths return the same shape — even
        // though the read path no longer touches Substrate.
        this.withSubstrate("list_my_day_tasks", async (_sub) => {
          const day = date ?? todayInTimeZone(this.env.TIMEZONE);
          if (!MY_DAY_DATE_RE.test(day)) {
            return errResponse("invalid_date", { date: day, hint: "Use YYYY-MM-DD." });
          }
          const index = this.#index();
          const [{ rows }, scan, lists] = await Promise.all([
            index.queryMyDayForDate(day),
            index.getMyDayScanState(),
            index.listLists().catch(() => [] as ListRow[]),
          ]);
          const nameByList = new Map(lists.map((l) => [l.list_id, l.display_name]));

          const tasks = rows.map((r) => ({
            list_id: r.list_id,
            display_name: nameByList.get(r.list_id) ?? null,
            task_id: r.task_id,
            title: r.title,
            committed_day: r.committed_day,
            committed_day_raw: r.committed_day ? `${r.committed_day}T00:00:00Z` : null,
            committed_order: r.committed_order,
            order_datetime: r.order_datetime,
            postponed_day: r.postponed_day,
            status: r.status,
            importance: r.importance,
            due_date: epochToIso(r.due_at)?.slice(0, 10) ?? null,
            start_date: epochToIso(r.start_at)?.slice(0, 10) ?? null,
            completed_date: epochToIso(r.completed_at) ?? null,
            is_reminder_on: r.is_reminder_on == null ? null : !!r.is_reminder_on,
            reminder_date: epochToIso(r.reminder_at) ?? null,
            has_attachments: r.has_attachments == null ? null : !!r.has_attachments,
            categories: r.categories_json ? (JSON.parse(r.categories_json) as string[]) : [],
            body_preview: r.body_plain ? r.body_plain.slice(0, 200) : null,
            created_date: epochToIso(r.created_at) ?? null,
            last_modified_date: epochToIso(r.modified_at) ?? null,
          }));

          // "stale" = the scan hasn't completed within ~3× the configured
          // sub-cadence (3 windows missed → something is wrong, or the DO has
          // been idle long enough that the cache cannot be trusted).
          const cycleMs = Number(this.env.DELTA_SYNC_INTERVAL_MIN || "15") * 60_000;
          // Floor to match the DO's #myDayScanEveryNCycles(), so the stale
          // window mirrors the cadence the scan actually runs at.
          const everyN = Math.floor(Number(this.env.MY_DAY_SCAN_EVERY_N_CYCLES || "4"));
          const scanWindow =
            (Number.isFinite(cycleMs) ? cycleMs : 15 * 60_000) *
            (Number.isFinite(everyN) && everyN >= 1 ? everyN : 4);
          const ageMs = scan.last_scan_at_ms ? Date.now() - scan.last_scan_at_ms : null;
          const stale = ageMs === null || ageMs > scanWindow * 3;

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  date: day,
                  count: tasks.length,
                  cache_as_of: scan.last_scan_at_ms,
                  cache_status: scan.status,
                  stale,
                  tasks,
                }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "list_tasks_by_manual_order",
      {
        description:
          "List one Microsoft To Do list's tasks in the app's MANUAL (drag-to-reorder) order (undocumented Substrate endpoint). Mirrors the order you get when no explicit Sort is applied to the list in the To Do app — backed by OrderDateTime, returned descending (top of the list first). Each task carries the same Substrate detail block as the My Day tools (status, importance, dates, reminder, categories, body_preview, order_datetime). Note: this is Substrate-shaped detail, not the cached `list_tasks` summary, and `task_id` is the Substrate id (which differs from the Graph id for a task that was moved between lists). One Substrate round-trip per call; capped at `top` (no pagination). Opt-in: requires ENABLE_MY_DAY=true and the Exchange Online Tasks.ReadWrite scope.",
        inputSchema: {
          list: z
            .string()
            .min(1)
            .describe("List alias (from get_list_config), display name, or Graph list ID."),
          status: z
            .enum(["incomplete", "completed", "all"])
            .optional()
            .describe("Which tasks to include. Default 'incomplete' (everything not Completed)."),
          top: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe("Maximum tasks to return. Default 100; max 200."),
        },
      },
      async ({ list, status, top }): Promise<McpResponse> =>
        this.withSubstrate("list_tasks_by_manual_order", async (sub) => {
          const list_id = await this.resolveList(list);
          const limit = top ?? 100;
          const want = status ?? "incomplete";

          const folderTasks = await sub.listFolderTasks(list_id);
          // Substrate returns ALL tasks (incl. completed); filter client-side on
          // the raw Status (PascalCase, e.g. "Completed"). 'all' keeps everything.
          const filtered = folderTasks.filter((t) => {
            const completed = (t.Status ?? "").toLowerCase() === "completed";
            if (want === "completed") return completed;
            if (want === "incomplete") return !completed;
            return true;
          });
          // Manual order = OrderDateTime descending, nulls last (shared comparator,
          // identical to the My Day aggregation).
          filtered.sort((a, b) => compareOrderDateTimeDesc(a.OrderDateTime ?? null, b.OrderDateTime ?? null));
          const truncated = filtered.length > limit;
          const tasks = filtered.slice(0, limit).map((t) => ({
            list_id,
            task_id: t.Id ?? null,
            title: t.Subject ?? null,
            ...projectSubstrateTaskDetails(t),
          }));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  list_id,
                  status: want,
                  count: tasks.length,
                  truncated,
                  tasks,
                }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "reorder_task",
      {
        description:
          "Change a task's MANUAL (drag-to-reorder) position in its list by setting OrderDateTime (undocumented Substrate endpoint). `position`: 'top'/'bottom' (move to the start/end of manual order), 'before'/'after' (relative to `reference_task_id`), 'index' (1-based slot via `index`, 1 = top), or 'set' (explicit `order_datetime`, a debug escape hatch). IMPORTANT: this edits manual order — if the list currently has an explicit Sort applied in the To Do app, the change is not VISIBLE until that sort is removed. Opt-in: requires ENABLE_MY_DAY=true and the Exchange Online Tasks.ReadWrite scope.",
        inputSchema: {
          task_id: z.string().min(1).describe("Microsoft Graph task id of the task to move."),
          list: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Owning list (alias, display name, or Graph list ID). Optional — resolved from the index when omitted; pass it if the task isn't indexed yet.",
            ),
          position: z
            .enum(["top", "bottom", "before", "after", "index", "set"])
            .describe("Where to move the task."),
          reference_task_id: z
            .string()
            .min(1)
            .optional()
            .describe("Required for position 'before'/'after': the task to position relative to (same list)."),
          index: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Required for position 'index': 1-based slot in manual order (1 = top)."),
          order_datetime: z
            .string()
            .min(1)
            .optional()
            .describe("Required for position 'set': explicit OrderDateTime (ISO 8601). Debug escape hatch."),
        },
      },
      async ({ task_id, list, position, reference_task_id, index, order_datetime }): Promise<McpResponse> =>
        this.withSubstrate("reorder_task", async (sub) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }

          // Resolve the new OrderDateTime string for the PATCH.
          let newOrder: string;
          if (position === "set") {
            if (!order_datetime) {
              return errResponse("order_datetime_required", { hint: "Pass order_datetime for position 'set'." });
            }
            if (orderToMs(order_datetime) === null) {
              return errResponse("invalid_order_datetime", { order_datetime, hint: "Use an ISO 8601 timestamp." });
            }
            newOrder = order_datetime;
          } else {
            // Compute relative to the OTHER tasks' OrderDateTime values. Exclude
            // the moving task (by id) so position math isn't off by one, and drop
            // null/unparseable orders (no comparable position). Caveat: the
            // listing's Substrate `.Id` may differ from the Graph `task_id` for a
            // task that was reparented (moved between lists); in that rare case the
            // moving task isn't excluded and 'index' math can be off by one. The
            // edge ops (top/bottom) and value-based before/after are unaffected.
            const folderTasks = await sub.listFolderTasks(list_id);
            const orders = folderTasks
              .filter((t) => t.Id !== task_id)
              .map((t) => orderToMs(t.OrderDateTime ?? null))
              .filter((ms): ms is number => ms !== null);

            let spec: ReorderSpec;
            if (position === "top" || position === "bottom") {
              spec = { kind: position };
            } else if (position === "index") {
              if (index === undefined) {
                return errResponse("index_required", { hint: "Pass index (1-based) for position 'index'." });
              }
              spec = { kind: "index", index };
            } else {
              // before / after
              if (!reference_task_id) {
                return errResponse("reference_required", {
                  position,
                  hint: "Pass reference_task_id for position 'before'/'after'.",
                });
              }
              let ref: SubstrateTask;
              try {
                ref = await sub.getTask(list_id, reference_task_id);
              } catch (e) {
                if (e instanceof SubstrateError && e.status === 404) {
                  return errResponse("reference_not_in_list", { list_id, reference_task_id });
                }
                throw e;
              }
              const referenceMs = orderToMs(ref.OrderDateTime ?? null);
              if (referenceMs === null) {
                return errResponse("reference_has_no_order", {
                  reference_task_id,
                  hint: "The reference task has no manual-order value; move it first (e.g. position 'top').",
                });
              }
              spec = { kind: position, referenceMs };
            }

            const computed = computeReorder(spec, orders);
            if (!computed.ok) {
              return errResponse(computed.reason, {
                hint: "No room between neighbors at millisecond precision; use position 'top'/'bottom' to reset.",
              });
            }
            newOrder = msToOrder(computed.ms);
          }

          const task = await sub.patchTask(list_id, task_id, { OrderDateTime: newOrder });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  list_id,
                  task_id,
                  position,
                  title: task.Subject ?? null,
                  ...projectSubstrateTaskDetails(task),
                  // Echo the value we PATCHed if the response omits it.
                  order_datetime: task.OrderDateTime ?? newOrder,
                }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "reorder_checklist_item",
      {
        description:
          "Change a checklist item's (subtask / 'step') MANUAL drag-to-reorder position within its task by setting the Substrate OrderDateTime (undocumented endpoint). `position`: 'top'/'bottom' (start/end of the step list), 'before'/'after' (relative to `reference_item_id`), 'index' (1-based slot via `index`, 1 = top), or 'set' (explicit `order_datetime`, a debug escape hatch). Returns `ordered_items` — the task's steps in the new order. A step that has never been reordered has no OrderDateTime and sorts in creation order until moved. Opt-in: requires ENABLE_MY_DAY=true and the Exchange Online Tasks.ReadWrite scope (returns my_day_disabled / my_day_unavailable otherwise).",
        inputSchema: {
          task_id: z.string().min(1).describe("Microsoft Graph task id that owns the checklist item."),
          item_id: z.string().min(1).describe("Checklist item id to move (from list_checklist_items)."),
          list: z
            .string()
            .min(1)
            .optional()
            .describe("Owning list (alias, name, or Graph list ID). Optional — resolved from the index via task_id when omitted; pass it if the task isn't indexed yet."),
          position: z
            .enum(["top", "bottom", "before", "after", "index", "set"])
            .describe("Where to move the item."),
          reference_item_id: z
            .string()
            .min(1)
            .optional()
            .describe("Required for position 'before'/'after': the checklist item to position relative to (same task)."),
          index: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Required for position 'index': 1-based slot in step order (1 = top)."),
          order_datetime: z
            .string()
            .min(1)
            .optional()
            .describe("Required for position 'set': explicit OrderDateTime (ISO 8601). Debug escape hatch."),
        },
      },
      async ({ task_id, item_id, list, position, reference_item_id, index, order_datetime }): Promise<McpResponse> =>
        this.withSubstrate("reorder_checklist_item", async (sub) => {
          // The neighbor read is the folder-scoped task GET (steps ride inline as
          // `Subtasks`; there is no standalone subtasks collection), so the folder
          // is REQUIRED — unlike the write PATCH, which is folder-free.
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }

          // Read the task's subtasks once: yields BOTH the neighbor orders AND
          // the reference's order, and lets us return ordered_items for every
          // position (including 'set'). Full 429 budget — this is a write op.
          const subtasks = await sub.listSubtasks(list_id, task_id);

          let newOrder: string;
          if (position === "set") {
            if (!order_datetime) {
              return errResponse("order_datetime_required", { hint: "Pass order_datetime for position 'set'." });
            }
            if (orderToMs(order_datetime) === null) {
              return errResponse("invalid_order_datetime", { order_datetime, hint: "Use an ISO 8601 timestamp." });
            }
            newOrder = order_datetime;
          } else {
            const orders = subtasks
              .filter((s) => s.Id !== item_id)
              .map((s) => orderToMs(s.OrderDateTime ?? null))
              .filter((ms): ms is number => ms !== null);

            let spec: ReorderSpec;
            if (position === "top" || position === "bottom") {
              spec = { kind: position };
            } else if (position === "index") {
              if (index === undefined) {
                return errResponse("index_required", { hint: "Pass index (1-based) for position 'index'." });
              }
              spec = { kind: "index", index };
            } else {
              // before / after
              if (!reference_item_id) {
                return errResponse("reference_required", {
                  position,
                  hint: "Pass reference_item_id for position 'before'/'after'.",
                });
              }
              const ref = subtasks.find((s) => s.Id === reference_item_id);
              if (!ref) {
                return errResponse("reference_not_found", { task_id, reference_item_id });
              }
              const referenceMs = orderToMs(ref.OrderDateTime ?? null);
              if (referenceMs === null) {
                return errResponse("reference_has_no_order", {
                  reference_item_id,
                  hint: "The reference item has no manual-order value; move it first (e.g. position 'top').",
                });
              }
              spec = { kind: position, referenceMs };
            }

            const computed = computeReorder(spec, orders);
            if (!computed.ok) {
              return errResponse(computed.reason, {
                hint: "No room between neighbors at millisecond precision; use position 'top'/'bottom' to reset.",
              });
            }
            newOrder = msToOrder(computed.ms);
          }

          await sub.patchSubtask(task_id, item_id, { OrderDateTime: newOrder });

          // Project the steps in their NEW order (apply newOrder to the moved
          // item locally — no second round-trip). Descending OrderDateTime,
          // nulls last (shared comparator).
          const ordered_items = subtasks
            .map((s) => ({
              item_id: s.Id ?? null,
              display_name: s.Subject ?? null,
              order_datetime: s.Id === item_id ? newOrder : (s.OrderDateTime ?? null),
              is_checked: s.IsCompleted ?? null,
            }))
            .sort((a, b) => compareOrderDateTimeDesc(a.order_datetime, b.order_datetime));

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  list_id,
                  task_id,
                  item_id,
                  position,
                  order_datetime: newOrder,
                  ordered_items,
                }),
              },
            ],
          };
        }),
    );

    this.server.registerTool(
      "reorder_my_day_task",
      {
        description:
          "Change a task's MANUAL position WITHIN My Day for a given day by setting CommittedOrder (undocumented Substrate endpoint). This is the My Day analogue of reorder_task: My Day order (CommittedOrder) is independent of source-list order (OrderDateTime) — reordering here never affects the list, and vice versa. `position`: 'top'/'bottom', 'before'/'after' (relative to `reference_task_id`, which must also be on My Day for the same day), 'index' (1-based, 1 = top), or 'set' (explicit `committed_order`, a debug escape hatch). The task (and any reference) must already be on My Day for `date` (use add_to_my_day first). Neighbors are the day's INCOMPLETE My Day tasks across all lists, read from the SQLite cache (same source as list_my_day_tasks), so the only Substrate round-trip is the write. `date` defaults to today in the Worker timezone. Opt-in: requires ENABLE_MY_DAY=true and the Exchange Online Tasks.ReadWrite scope.",
        inputSchema: {
          task_id: z.string().min(1).describe("Microsoft Graph task id of the task to move."),
          list: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Owning list (alias, display name, or Graph list ID). Optional — resolved from the index when omitted; pass it if the task isn't indexed yet.",
            ),
          position: z
            .enum(["top", "bottom", "before", "after", "index", "set"])
            .describe("Where to move the task within My Day."),
          reference_task_id: z
            .string()
            .min(1)
            .optional()
            .describe("Required for 'before'/'after': a task that is also on My Day for `date`."),
          index: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Required for position 'index': 1-based slot in My Day order (1 = top)."),
          committed_order: z
            .string()
            .min(1)
            .optional()
            .describe("Required for position 'set': explicit CommittedOrder (ISO 8601). Debug escape hatch."),
          date: z
            .string()
            .optional()
            .describe("Day whose My Day order to edit, YYYY-MM-DD. Defaults to today in the Worker timezone."),
        },
      },
      async ({ task_id, list, position, reference_task_id, index, committed_order, date }): Promise<McpResponse> =>
        this.withSubstrate("reorder_my_day_task", async (sub) => {
          const list_id = await this.resolveListForTask(list, task_id);
          if (!list_id) {
            return errResponse("list_required", {
              task_id,
              hint: "Task not found in the index; pass `list` explicitly.",
            });
          }
          const day = date ?? todayInTimeZone(this.env.TIMEZONE);
          if (!MY_DAY_DATE_RE.test(day)) {
            return errResponse("invalid_date", { date: day, hint: "Use YYYY-MM-DD." });
          }

          // 'set' is the debug escape hatch: write the raw value, no neighbor
          // gathering and no membership check (mirrors reorder_task's 'set').
          if (position === "set") {
            if (!committed_order) {
              return errResponse("committed_order_required", { hint: "Pass committed_order for position 'set'." });
            }
            if (orderToMs(committed_order) === null) {
              return errResponse("invalid_committed_order", { committed_order, hint: "Use an ISO 8601 timestamp." });
            }
            const set = await sub.patchTask(list_id, task_id, { CommittedOrder: committed_order });
            await this.#index().updateMyDayFields(task_id, { committed_order });
            return reorderMyDayResponse({ list_id, task_id, date: day, position, task: set, newOrder: committed_order });
          }

          // My Day is a cross-list aggregation. Read the day's set straight from
          // the SQLite cache (queryMyDayForDate already filters to the day and
          // drops postponed tasks) — the SAME source list_my_day_tasks shows, so
          // the reorder is consistent with what the user sees, with zero Substrate
          // reads for neighbor-gathering. The only Substrate round-trip is the
          // PATCH below.
          const { rows } = await this.#index().queryMyDayForDate(day);
          // Membership probe: the mover must be in the day's cached set.
          if (!findMyDayRowById(rows, task_id)) {
            return errResponse("task_not_on_my_day", {
              task_id,
              date: day,
              hint: "Add the task to My Day for this date first (add_to_my_day), pass the correct `date`, or wait for the My Day cache to warm.",
            });
          }
          const neighbors = collectMyDayNeighborOrders(rows, task_id);

          let spec: ReorderSpec;
          if (position === "top" || position === "bottom") {
            spec = { kind: position };
          } else if (position === "index") {
            if (index === undefined) {
              return errResponse("index_required", { hint: "Pass index (1-based) for position 'index'." });
            }
            spec = { kind: "index", index };
          } else {
            // before / after — the reference must also be on My Day for `day`.
            // Read its CommittedOrder from the cached set (it may live in a
            // different list than the moving task).
            if (!reference_task_id) {
              return errResponse("reference_required", {
                position,
                hint: "Pass reference_task_id for position 'before'/'after'.",
              });
            }
            const ref = findMyDayRowById(rows, reference_task_id);
            if (!ref) {
              return errResponse("reference_not_on_my_day", { reference_task_id, date: day });
            }
            const referenceMs = orderToMs(ref.committed_order);
            if (referenceMs === null) {
              return errResponse("reference_has_no_committed_order", {
                reference_task_id,
                hint: "The reference task has no My Day order; move it first (e.g. position 'top').",
              });
            }
            spec = { kind: position, referenceMs };
          }

          const computed = computeReorder(spec, neighbors);
          if (!computed.ok) {
            return errResponse(computed.reason, {
              hint: "No room between neighbors at millisecond precision; use position 'top'/'bottom' to reset.",
            });
          }
          const newOrder = msToOrder(computed.ms);
          const task = await sub.patchTask(list_id, task_id, { CommittedOrder: newOrder });
          // Write-through so list_my_day_tasks reflects the new order immediately,
          // without waiting for the next background scan.
          await this.#index().updateMyDayFields(task_id, { committed_order: newOrder });
          return reorderMyDayResponse({ list_id, task_id, date: day, position, task, newOrder });
        }),
    );
  }

  // Resolve a caller-supplied list identifier (alias, display name, or raw Graph
  // list ID) to a canonical Graph list ID. Aliases (the primary path) resolve
  // from KV config with no roster; display-name resolution reads the DO roster
  // (best-effort — a cold/empty roster simply degrades to raw passthrough).
  private async resolveList(list: string): Promise<string> {
    const config = await loadListsConfig(this.env);
    if (config.aliases[list] !== undefined) return config.aliases[list];
    let roster: ListRow[] = [];
    try {
      roster = await this.#index().listLists();
    } catch (e) {
      log.warn("index_roster_read_failed", { error: String(e) });
    }
    return resolveListId(list, config, roster.map(rowToList));
  }

  // Resolve the owning list for a task-level tool. When `list` is supplied,
  // resolve it normally; when omitted, look the task up in the DO index
  // (findListForTask). Returns null when neither yields a list id — the caller
  // maps that to a "list_required" error.
  private async resolveListForTask(
    list: string | undefined,
    taskId: string,
  ): Promise<string | null> {
    if (list !== undefined) return this.resolveList(list);
    const found = await this.#index()
      .findListForTask(taskId)
      .catch((e) => {
        log.warn("index_find_list_failed", { task_id: taskId, error: String(e) });
        return null;
      });
    return found?.list_id ?? null;
  }

  // Roster source for list_lists/get_list. Reads the DO `lists` table (the
  // authoritative roster). When the index is cold (empty roster), enumerate
  // live from Graph and kick a sync so it warms — returning a clear source.
  private async getRoster(
    graph: GraphClient,
  ): Promise<{ lists: TodoTaskList[]; source: ListsSource }> {
    let rows: ListRow[] = [];
    try {
      rows = await this.#index().listLists();
    } catch (e) {
      log.warn("index_roster_read_failed", { error: String(e) });
    }
    if (rows.length > 0) return { lists: rows.map(rowToList), source: "index" };

    // Cold index: serve live and warm the index for next time.
    const result = await graph.getAllPages(LISTS_URL, TodoTaskListSchema);
    const lists = result.status === 200 ? result.items : [];
    await this.#index()
      .ensureSyncing()
      .catch((e) => log.warn("index_ensure_syncing_failed", { error: String(e) }));
    return { lists, source: "graph_cold" };
  }

  // Tool boundary helper — single pre-flight for "owner has never authorized"
  // plus single GraphError → errResponse mapping. Each new read tool wraps its
  // body with this; whoami pre-dates it and stays inline (no scope creep).
  // Anything other than GraphError rethrows to instrument()'s catch, which
  // maps to errResponse("unexpected_error", { message }) — that's the right
  // shape for ZodError (schema drift, loud) and other unexpected throws.
  protected async withGraph(
    tool: string,
    fn: (graph: GraphClient) => Promise<McpResponse>,
  ): Promise<McpResponse> {
    return instrument(tool, async () => {
      const stored = await loadTokens(this.env);
      if (!stored) {
        return errResponse("not_authenticated", {
          hint: "Visit /authorize via the Claude.ai MCP connector to sign in to Microsoft.",
        });
      }
      try {
        return await fn(new GraphClient(this));
      } catch (e) {
        if (e instanceof GraphError) {
          return errResponse(`graph_${e.status}`, { detail: e.detail ?? "" });
        }
        throw e;
      }
    });
  }

  // Tool boundary helper for the opt-in My Day tools — parallel to withGraph.
  // Gates on the ENABLE_MY_DAY flag (operator intent) AND degrades cleanly when
  // the EXO permission isn't actually consented/granted at runtime: a substrate
  // token-mint that AAD rejects with AADSTS65001 surfaces here as
  // "my_day_unavailable", and a 403 on the resource latches the DO verdict so
  // subsequent calls short-circuit. Builds a SubstrateClient whose token logic
  // lives entirely in the sole-refresher DO (no independent refresh here).
  protected async withSubstrate(
    tool: string,
    fn: (sub: SubstrateClient) => Promise<McpResponse>,
  ): Promise<McpResponse> {
    return instrument(tool, async () => {
      if (!myDayEnabled(this.env)) {
        return errResponse("my_day_disabled", {
          hint: "Set ENABLE_MY_DAY=true on the Worker and re-run /authorize to consent the Exchange Online Tasks scope.",
        });
      }
      const stored = await loadTokens(this.env);
      if (!stored) {
        return errResponse("not_authenticated", {
          hint: "Visit /authorize via the Claude.ai MCP connector to sign in to Microsoft.",
        });
      }
      const ident = await loadIdentity(this.env);
      const sub = new SubstrateClient(
        {
          getSubstrateAccessToken: () => this.#index().getSubstrateAccessToken(),
          forceSubstrateRefresh: () => this.#index().forceSubstrateRefresh(),
        },
        ident?.anchorMailbox ?? null,
      );
      try {
        return await fn(sub);
      } catch (e) {
        // The DO throws a plain Error("my_day_unavailable") across RPC when the
        // EXO scope isn't consented (AADSTS65001). RPC flattens it to a message.
        if (e instanceof Error && e.message.includes("my_day_unavailable")) {
          return this.#myDayUnavailable();
        }
        if (e instanceof SubstrateError) {
          if (e.status === 403) {
            // Scope minted but the resource rejected it — latch so we stop trying.
            await this.#index()
              .markMyDayUnavailable()
              .catch((err) => log.warn("mark_my_day_unavailable_failed", { error: String(err) }));
            return this.#myDayUnavailable(e.detail);
          }
          return errResponse(`substrate_${e.status}`, { detail: e.detail ?? "" });
        }
        throw e;
      }
    });
  }

  #myDayUnavailable(detail?: string): McpResponse {
    return errResponse("my_day_unavailable", {
      detail: detail ?? "",
      hint: "Office 365 Exchange Online Tasks.ReadWrite is not consented/granted. Re-run /authorize, or add the EXO Tasks.ReadWrite permission to the Entra app registration (see DEPLOYMENT.md).",
    });
  }

  // Build a SubstrateClient outside the withSubstrate wrapper (used by move_task,
  // which runs in the Graph context). Mirrors withSubstrate's construction
  // (agent.ts withSubstrate): token logic lives in the sole-refresher DO; this
  // just injects the anchor mailbox. The caller is responsible for the
  // myDayEnabled gate and for swallowing my_day_unavailable / SubstrateError.
  async #buildSubstrateClient(): Promise<SubstrateClient> {
    const ident = await loadIdentity(this.env);
    return new SubstrateClient(
      {
        getSubstrateAccessToken: () => this.#index().getSubstrateAccessToken(),
        forceSubstrateRefresh: () => this.#index().forceSubstrateRefresh(),
      },
      ident?.anchorMailbox ?? null,
    );
  }

  // Best-effort manual order for a task's checklist items: a map of
  // checklistItem.id -> OrderDateTime (the Substrate subtask order Graph can't
  // see), or null when My Day is disabled or Substrate is unavailable/unconsented.
  // NEVER throws — order enrichment is optional; callers fall back to Graph
  // creation order. (Verified live: Graph checklistItem.id == Substrate subtask.id,
  // and Graph task id == Substrate task id for an un-reparented task.)
  async #tryChecklistOrder(
    listId: string,
    taskId: string,
  ): Promise<Map<string, string | null> | null> {
    if (!myDayEnabled(this.env)) return null;
    try {
      const sub = await this.#buildSubstrateClient();
      // fast: skip 429 retries — enrichment is optional, fall back rather than
      // block ~40s on a throttled mailbox.
      const subtasks = await sub.listSubtasks(listId, taskId, { fast: true });
      const map = new Map<string, string | null>();
      for (const s of subtasks) if (s.Id) map.set(s.Id, s.OrderDateTime ?? null);
      return map;
    } catch (e) {
      log.warn("checklist_order_unavailable", { taskId, error: String(e) });
      return null;
    }
  }

  // move_task PRIMARY path: attempt the lossless in-place re-parent. Returns a
  // discriminated result so the handler can branch without exceptions:
  //   { ok: true, task }                         — confirmed moved (re-key cache)
  //   { ok: false, attempted: false, reason }    — no PATCH sent (Substrate
  //                                                 unavailable) → straight to
  //                                                 fallback, no dup risk
  //   { ok: false, attempted: true, reason, task? } — a PATCH WAS sent but the
  //                                                 move isn't confirmed → run
  //                                                 the duplicate-creation guard
  async #reparentViaSubstrate(
    toListId: string,
    taskId: string,
  ): Promise<
    | { ok: true; task: SubstrateTask }
    | { ok: false; attempted: boolean; reason: string; task?: SubstrateTask }
  > {
    try {
      const sub = await this.#buildSubstrateClient();
      const task = await sub.reparentTask(toListId, taskId);
      if (isReparentConfirmed(task, toListId)) return { ok: true, task };
      // 200 that ignored ParentFolderId — a silent no-op. The item likely
      // didn't move, but treat as attempted so the guard re-checks the source.
      log.warn("move_reparent_unconfirmed", {
        taskId,
        toListId,
        parent: task.ParentFolderId ?? null,
      });
      return { ok: false, attempted: true, reason: "reparent_not_confirmed", task };
    } catch (e) {
      // Token mint failed (EXO scope not consented). No PATCH was sent, so no
      // EWS commit could have happened — safe to go straight to the fallback.
      if (e instanceof Error && e.message.includes("my_day_unavailable")) {
        return { ok: false, attempted: false, reason: "my_day_unavailable" };
      }
      // The server saw a write attempt (even a 4xx) — the move MAY have
      // committed, so the guard must run before any fallback create.
      if (e instanceof SubstrateError) {
        log.warn("move_reparent_substrate_error", { status: e.status, detail: e.detail });
        return { ok: false, attempted: true, reason: `substrate_${e.status}` };
      }
      // Network / timeout / dropped response — ambiguous; guard.
      log.warn("move_reparent_failed", { error: String(e) });
      return { ok: false, attempted: true, reason: "reparent_error" };
    }
  }

  // move_task duplicate-creation guard input: is the source task still there?
  // 200 → present; 404 (or the malformed-id 400 the rest of the handler treats
  // as gone) → absent; anything else (5xx / network) → unknown (the helper
  // decideAfterReparentFailure treats unknown conservatively as already-moved).
  async #recheckSource(
    graph: GraphClient,
    fromListId: string,
    taskId: string,
  ): Promise<{ sourcePresent: boolean | "unknown" }> {
    try {
      await graph.getJson(
        `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(fromListId)}/tasks/${encodeURIComponent(taskId)}`,
        TodoTaskSchema,
      );
      return { sourcePresent: true };
    } catch (e) {
      if (e instanceof GraphError) {
        const innerCode = getGraphInnerErrorCode(e.detail);
        if (e.status === 404 || (e.status === 400 && innerCode === "ErrorInvalidIdMalformed")) {
          return { sourcePresent: false };
        }
      }
      log.warn("move_recheck_source_failed", { fromListId, taskId, error: String(e) });
      return { sourcePresent: "unknown" };
    }
  }

  // move_task FALLBACK My-Day carry: read the source's CommittedDay via
  // Substrate (Graph doesn't expose it) BEFORE the source is deleted, then apply
  // it to the destination copy. Best-effort — every failure is swallowed into a
  // reason and never aborts the move.
  async #carryMyDay(
    fromListId: string,
    toListId: string,
    oldTaskId: string,
    newTaskId: string,
  ): Promise<{ carried: boolean; reason?: string }> {
    try {
      const sub = await this.#buildSubstrateClient();
      const src = await sub.getTask(fromListId, oldTaskId);
      const day = committedDatePart(src.CommittedDay);
      if (!day) return { carried: false, reason: "source_not_in_my_day" };
      await sub.patchTask(toListId, newTaskId, { CommittedDay: day, PostponedDay: null });
      return { carried: true };
    } catch (e) {
      log.warn("move_carry_my_day_failed", { error: String(e) });
      return { carried: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  // Singleton TodoIndex DO stub — the cross-list index + sole token refresher.
  // Same instance for every session (idFromName(OWNER_DO_NAME)).
  #index(): DurableObjectStub<TodoIndex> {
    return this.env.TODO_INDEX_DO.get(
      this.env.TODO_INDEX_DO.idFromName(OWNER_DO_NAME),
    );
  }

  // Cross-list DO reads (query_tasks/search_tasks) return empty on a cold
  // index. When the result is empty AND the roster has never synced (a truly
  // cold index, not just an empty filter match), best-effort kick a sync so a
  // first-time caller warms it — mirrors the cold path in list_tasks. Idle/warm
  // indexes (roster present) are left alone, so legitimately-empty filters
  // don't trigger needless sync work.
  async #warmIfEmpty(rowCount: number): Promise<void> {
    if (rowCount > 0) return;
    try {
      const status = await this.#index().syncStatus();
      if (status.totals.lists === 0) await this.#index().ensureSyncing();
    } catch (e) {
      log.warn("index_warm_failed", { error: String(e) });
    }
  }

  // Best-effort DO index propagation for mutations. The DO is the source of
  // truth for DO-served reads (list_tasks/query_tasks/search_tasks), so writes
  // push synchronously — but a propagation failure must NOT fail the tool: the
  // Graph mutation already succeeded and the next delta sync reconciles.
  async #indexUpsertTask(task: TodoTask, listId: string): Promise<void> {
    try {
      await this.#index().upsertTask(task, listId);
    } catch (e) {
      log.warn("index_upsert_task_failed", { task_id: task.id, error: String(e) });
    }
  }
  async #indexDeleteTask(taskId: string): Promise<void> {
    try {
      await this.#index().deleteTask(taskId);
    } catch (e) {
      log.warn("index_delete_task_failed", { task_id: taskId, error: String(e) });
    }
  }
  async #indexSetFlags(
    taskId: string,
    patch: { has_checklist?: boolean; has_attachments?: boolean },
  ): Promise<void> {
    try {
      await this.#index().setTaskFlags(taskId, patch);
    } catch (e) {
      log.warn("index_set_flags_failed", { task_id: taskId, error: String(e) });
    }
  }

  // Checklist cache write-throughs (latency optimization — the self-induced edit
  // also rides delta → re-fetch). Gated: when the cache is off we never write
  // checklist rows (no scan would maintain them). Best-effort like the others.
  async #indexUpsertChecklistItem(
    taskId: string,
    listId: string,
    item: ChecklistItem,
  ): Promise<void> {
    if (!checklistCacheEnabled(this.env)) return;
    try {
      await this.#index().upsertChecklistItem(taskId, listId, item);
    } catch (e) {
      log.warn("index_upsert_checklist_item_failed", { task_id: taskId, error: String(e) });
    }
  }
  async #indexDeleteChecklistItem(taskId: string, itemId: string): Promise<void> {
    if (!checklistCacheEnabled(this.env)) return;
    try {
      await this.#index().deleteChecklistItem(taskId, itemId);
    } catch (e) {
      log.warn("index_delete_checklist_item_failed", { task_id: taskId, error: String(e) });
    }
  }
  async #indexUpsertList(list: TodoTaskList): Promise<void> {
    try {
      await this.#index().upsertList(list);
    } catch (e) {
      log.warn("index_upsert_list_failed", { list_id: list.id, error: String(e) });
    }
  }
  async #indexDeleteList(listId: string): Promise<void> {
    try {
      await this.#index().deleteList(listId);
    } catch (e) {
      log.warn("index_delete_list_failed", { list_id: listId, error: String(e) });
    }
  }

  // TokenProvider — public so graph/client.ts can call them via the interface.
  // Both throw "not_authenticated" if no tokens are stored; the GraphClient
  // does not handle that case (it's an application-level concern, mapped by
  // the calling tool).
  //
  // Phase 5: token refresh is centralized in the singleton DO. The agent reads
  // the stored token from KV and, only when it's near expiry, delegates the
  // refresh to the DO (sole refresher, global single-flight). A fresh token is
  // returned directly — no RPC on the hot path.

  async getAccessToken(): Promise<string> {
    const stored = await loadTokens(this.env);
    if (!stored) throw new Error("not_authenticated");
    if (stored.expires_at > Date.now() + REFRESH_SKEW_MS) return stored.access_token;
    return this.#index().getAccessToken();
  }

  async forceRefresh(): Promise<string> {
    return this.#index().refreshToken();
  }

  // Run link rules against a task and POST the single match (if any) as a
  // linked resource. Microsoft To Do allows exactly one linked resource per
  // task, so this creates at most one and skips (never clobbers) if the task
  // already carries one. Pass a task fetched with $expand=linkedResources so
  // the existing-link check is accurate; for a freshly created task
  // linkedResources is undefined, which correctly counts as zero.
  // Non-fatal: creation failures are logged and returned in `failed`.
  private async applyLinkRules(
    graph: GraphClient,
    list_id: string,
    task: TodoTask,
  ): Promise<{
    created: LinkRuleMatch[];
    skipped: Array<{ match: LinkRuleMatch; reason: string }>;
    failed: Array<{ match: LinkRuleMatch; error: string }>;
  }> {
    const config = await loadLinkRules(this.env);
    if (config.rules.filter((r) => r.enabled).length === 0)
      return { created: [], skipped: [], failed: [] };

    const matches = runLinkRules(config, task);
    if (matches.length === 0) return { created: [], skipped: [], failed: [] };

    let hasLink = (task.linkedResources ?? []).length > 0;

    const created: LinkRuleMatch[] = [];
    const skipped: Array<{ match: LinkRuleMatch; reason: string }> = [];
    const failed: Array<{ match: LinkRuleMatch; error: string }> = [];
    const baseUrl = `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task.id)}/linkedResources`;

    for (const match of matches) {
      if (hasLink) {
        skipped.push({ match, reason: "todo_one_linked_resource_per_task" });
        continue;
      }
      try {
        await graph.postJson(
          baseUrl,
          {
            applicationName: match.applicationName,
            displayName: match.displayName,
            externalId: match.externalId,
            webUrl: match.url,
          },
          LinkedResourceSchema,
        );
        created.push(match);
        hasLink = true;
      } catch (e) {
        // Defense-in-depth: Graph signals the per-task limit with innerError
        // `LinkedResourceSizeExceeded` — treat as skip, not fail.
        if (
          e instanceof GraphError &&
          getGraphInnerErrorCode(e.detail) === "LinkedResourceSizeExceeded"
        ) {
          skipped.push({ match, reason: "todo_one_linked_resource_per_task" });
          continue;
        }
        const error =
          e instanceof GraphError
            ? e.detail
              ? `${e.message}: ${e.detail}`
              : e.message
            : e instanceof Error
              ? e.message
              : String(e);
        failed.push({ match, error });
        log.warn("link_rules_create_failed", { rule_id: match.rule_id, url: match.url, error });
      }
    }

    return { created, skipped, failed };
  }
}
