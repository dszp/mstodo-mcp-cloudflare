import { z } from "zod";
import { log } from "../log";

// Phase 2 step 3 — typed Microsoft Graph wrapper.
// Phase 3 step 1 — generalized to support mutations (POST, PATCH, DELETE).
//
// Responsibilities:
//   - Attach Bearer tokens via an injected TokenProvider (decouples GraphClient
//     from the McpAgent class — the agent implements this interface).
//   - On 401, force one refresh + retry once. Single-flight discipline lives on
//     the TokenProvider (the McpAgent), not here.
//   - On 429, honor Retry-After (clamped to a Worker-friendly ceiling) and retry
//     once. Beyond the budget, surface as GraphError(429).
//   - On 5xx and any other non-2xx/304, throw GraphError carrying the status +
//     a truncated body for diagnostics.
//   - On 200/201, Zod-validate the JSON body. For conditional GETs, pull the
//     resource-level `@odata.etag` off the parsed body (Graph emits it inline;
//     the schemas in graph/types.ts use `.passthrough()` so it survives parse),
//     falling back to the response `ETag` header if for some reason it's not on
//     the body.
//   - Mutations: postJson (POST, returns 201), patchJson (PATCH, returns 200,
//     optional If-Match), deleteResource (DELETE, returns 204, optional If-Match).
//     Content-Type: application/json is added automatically when a body is present.

export interface TokenProvider {
  // Return a valid access token, refreshing proactively if near expiry.
  // Throws if no tokens are stored (e.g. owner has never visited /authorize).
  getAccessToken(): Promise<string>;
  // Force a refresh regardless of current token freshness. Called by GraphClient
  // on a 401 response. Throws if no refresh token is available.
  forceRefresh(): Promise<string>;
}

export type ConditionalGetResult<T> =
  | { status: 304 }
  | { status: 200; etag: string | undefined; body: T };

export class GraphError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

const MAX_429_RETRIES = 1;
// Workers don't have a hard per-request wall clock but long suspensions are
// expensive and risk client-side timeouts. 30 s is the largest delay we'll
// honor; longer Retry-After values get clamped down.
const RETRY_AFTER_CAP_MS = 30_000;

export class GraphClient {
  constructor(private readonly tokens: TokenProvider) {}

  async getJson<T>(
    url: string,
    schema: z.ZodType<T>,
    opts: { headers?: Record<string, string> } = {},
  ): Promise<T> {
    const res = await this.fetchWithRetry(url, opts.headers ?? {});
    if (res.status === 304) {
      // Caller used getJson but the upstream returned 304 — almost certainly
      // because they smuggled an If-None-Match in opts.headers. Surface as a
      // typed error instead of parsing an empty body and producing a confusing
      // Zod failure downstream.
      throw new GraphError(304, "unexpected_304_for_unconditional_get");
    }
    const json = (await res.json()) as unknown;
    return schema.parse(json);
  }

  async getJsonConditional<T>(
    url: string,
    schema: z.ZodType<T>,
    etag?: string,
  ): Promise<ConditionalGetResult<T>> {
    const headers: Record<string, string> = {};
    if (etag) headers["if-none-match"] = etag;
    const res = await this.fetchWithRetry(url, headers);
    if (res.status === 304) return { status: 304 };
    const json = (await res.json()) as unknown;
    const body = schema.parse(json);
    // Graph emits the resource ETag inline as `@odata.etag`; schemas in
    // graph/types.ts type it as an optional string, and .passthrough() also
    // preserves it on any future schema that forgets to declare it.
    const fromBody = (body as { "@odata.etag"?: unknown })["@odata.etag"];
    const headerEtag = res.headers.get("etag") ?? undefined;
    return {
      status: 200,
      etag: typeof fromBody === "string" ? fromBody : headerEtag,
      body,
    };
  }

  // Follow an OData paginated collection (`{ value: T[], @odata.nextLink? }`)
  // until exhausted. The first request is conditional on `etag`; subsequent
  // nextLink requests are unconditional (the collection ETag scopes only the
  // first response). Returns a discriminated result so callers can tell a 304
  // ("nothing changed since etag") from a 200 with the full flattened items.
  //
  // No page cap — non-delta collections (`/me/todo/lists`, `/me/todo/lists/{id}/tasks`)
  // are bounded by user behavior, not accumulated changes. The Phase 5 delta
  // follower has different semantics and lives elsewhere.
  async getAllPages<T>(
    firstUrl: string,
    itemSchema: z.ZodType<T>,
    etag?: string,
  ): Promise<{ status: 304 } | { status: 200; etag: string | undefined; items: T[] }> {
    const pageSchema = z
      .object({
        "@odata.context": z.string().optional(),
        "@odata.nextLink": z.string().optional(),
        value: z.array(itemSchema),
      })
      .passthrough();

    const first = await this.getJsonConditional(firstUrl, pageSchema, etag);
    if (first.status === 304) return { status: 304 };

    const items: T[] = [...first.body.value];
    let nextLink = first.body["@odata.nextLink"];
    while (nextLink) {
      const page = await this.getJson(nextLink, pageSchema);
      items.push(...page.value);
      nextLink = page["@odata.nextLink"];
    }
    return { status: 200, etag: first.etag, items };
  }

  // POST a JSON body and validate the 201 Created response with a Zod schema.
  async postJson<T>(url: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const res = await this.fetchWithRetry(url, {}, "POST", JSON.stringify(body));
    const json = (await res.json()) as unknown;
    return schema.parse(json);
  }

  // PATCH a JSON body and validate the 200 OK response with a Zod schema.
  // Supply `ifMatch` to send an If-Match header for optimistic concurrency.
  async patchJson<T>(
    url: string,
    body: unknown,
    schema: z.ZodType<T>,
    opts: { ifMatch?: string } = {},
  ): Promise<T> {
    const extraHeaders: Record<string, string> = {};
    if (opts.ifMatch) extraHeaders["if-match"] = opts.ifMatch;
    const res = await this.fetchWithRetry(url, extraHeaders, "PATCH", JSON.stringify(body));
    const json = (await res.json()) as unknown;
    return schema.parse(json);
  }

  // DELETE a resource. Expects 204 No Content; throws GraphError on any other status.
  // Supply `ifMatch` to send an If-Match header for optimistic concurrency.
  async deleteResource(url: string, opts: { ifMatch?: string } = {}): Promise<void> {
    const extraHeaders: Record<string, string> = {};
    if (opts.ifMatch) extraHeaders["if-match"] = opts.ifMatch;
    await this.fetchWithRetry(url, extraHeaders, "DELETE");
    // 204 body is empty — nothing to parse or validate.
  }

  private async fetchWithRetry(
    url: string,
    extraHeaders: Record<string, string>,
    method: string = "GET",
    body?: string,
  ): Promise<Response> {
    // Defense-in-depth: every request below carries the owner's Bearer token, so
    // pin the host before we attach it (the delta/collection followers chase
    // server-provided @odata.nextLink/deltaLink — a hostile or malformed link
    // must never be able to send the token off to a non-Graph host).
    assertGraphUrl(url);
    let retried401 = false;
    let retried429 = 0;
    let token = await this.tokens.getAccessToken();
    while (true) {
      const headers: Record<string, string> = {
        ...extraHeaders,
        authorization: `Bearer ${token}`,
      };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
      }
      const res = await fetch(url, { method, headers, body });
      if (res.status === 401 && !retried401) {
        retried401 = true;
        log.warn("graph_401_refresh", { url: redactUrl(url) });
        token = await this.tokens.forceRefresh();
        continue;
      }
      if (res.status === 429 && retried429 < MAX_429_RETRIES) {
        retried429 += 1;
        const retryAfter = res.headers.get("retry-after");
        const delayMs = parseRetryAfter(retryAfter);
        log.warn("graph_429_retry", {
          url: redactUrl(url),
          retryAfter,
          delayMs,
          attempt: retried429,
        });
        await sleep(delayMs);
        continue;
      }
      if (res.status >= 500) {
        const detail = await safeText(res);
        throw new GraphError(res.status, `graph_${res.status}`, detail);
      }
      if (!res.ok && res.status !== 304) {
        const detail = await safeText(res);
        throw new GraphError(res.status, `graph_${res.status}`, detail);
      }
      return res;
    }
  }
}

// The only host GraphClient may ever talk to. Call sites build URLs from a fixed
// graph.microsoft.com base, but server-provided continuation links are followed
// verbatim; pinning the host keeps the Bearer token from leaking if Graph ever
// returns (or an attacker injects) a foreign link. The Entra token endpoint is
// fetched directly in auth/microsoft.ts, not through GraphClient, so it is
// unaffected by this guard.
const GRAPH_HOST = "graph.microsoft.com";

export function assertGraphUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GraphError(0, "graph_url_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== GRAPH_HOST) {
    throw new GraphError(0, "graph_url_host_rejected", `${parsed.protocol}//${parsed.host}`);
  }
}

// Strip the query string (and fragment) before logging a Graph URL. Delta and
// collection links carry `$skiptoken`/`$deltatoken` continuation tokens that
// resume a feed — opaque, but sensitive enough to keep out of logs. The path
// alone is enough to identify the resource for diagnostics.
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "<unparseable-url>";
  }
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 1000;
  // Retry-After is either delta-seconds (an integer) or an HTTP-date.
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  }
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), RETRY_AFTER_CAP_MS));
  }
  return 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return "";
  }
}
