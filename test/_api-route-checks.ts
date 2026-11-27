// The /api/v1 routes through a host's whole OAuth front: a real /api/v1 token
// from the authorization flow, the resource server's challenge, the grant
// gate, and the index behind ownerIndex (the TodoIndex DO over RPC on
// Workers, the in-process IndexCore on Node). Run by
// test/api-routes.test.ts and test-node/api-routes.test.ts.
import { expect } from "vitest";
import { storeLinkRules } from "../src/core/config/loader";
import { LinkRulesConfigSchema } from "../src/core/config/schemas";
import { ownerIndex } from "../src/core/owner-index";
import type { AppEnv } from "../src/core/ports";
import { VERSION } from "../src/core/version";
import { ORIGIN, oauthClient } from "../test-node/_oauth-client";

const task = (id: string, title: string) =>
  ({ id, title, status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" }) as never;

export async function runApiRouteChecks(env: AppEnv, fetchFn: (req: Request) => Promise<Response>) {
  const index = ownerIndex(env);
  await index.upsertList({ id: "L1", displayName: "One" } as never);
  await index.upsertTask(task("T1", "pay the invoice"), "L1");
  await index.upsertTask(task("T2", "call the bank"), "L1");

  const client = oauthClient(fetchFn);
  const get = (path: string, token?: string) =>
    client.send(path, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const check = async (label: string, res: Response, status: number) => {
    expect([label, res.status]).toEqual([label, status]);
    if (res.headers.get("content-type")?.includes("json")) {
      expect([`${label}: cache-control`, res.headers.get("cache-control")]).toEqual([`${label}: cache-control`, "no-store"]);
    }
    return res;
  };

  // Before sign-in: /sync/info says only which server this is; every other
  // route asks for a token and names the /api/v1 metadata.
  const probe = await check("info without token", await get("/api/v1/sync/info"), 200);
  const probeBody = (await probe.json()) as Record<string, unknown>;
  expect(Object.keys(probeBody)).toEqual(["server_id"]);
  for (const path of ["/api/v1/sync/changes", "/api/v1/tasks/x", "/api/v1/search?q=x", "/api/v1/link-rules", "/api/v1/nope"]) {
    const res = await check(`${path} without token`, await get(path), 401);
    expect([path, res.headers.get("www-authenticate")]).toEqual([
      path,
      `Bearer realm="OAuth", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/v1"`,
    ]);
  }
  await check("info with a bad token", await get("/api/v1/sync/info", "u:g:bogus"), 401);

  const { access_token: token, refresh_token, clientId } = await client.connect(`${ORIGIN}/api/v1`);

  // /sync/info with a token: the whole picture, with the owner's address as a hint.
  const info = (await (await check("info with token", await get("/api/v1/sync/info", token), 200)).json()) as Record<
    string,
    unknown
  >;
  expect(info).toMatchObject({
    server_id: probeBody.server_id,
    account: { name: "Owner", email_hint: "t…@example.com" },
    version: VERSION,
    capabilities: { source: "graph" },
  });
  expect(JSON.stringify(info)).not.toContain("test-owner@");

  // Link rules: the app's copy, and the rev /sync/info carries for it.
  const rules = async () =>
    (await (await check("link rules", await get("/api/v1/link-rules", token), 200)).json()) as {
      rev: string;
      rules: Array<{ id: string }>;
    };
  const none = await rules();
  expect(none.rules).toEqual([]);
  expect(info.link_rules_rev).toBe(none.rev);
  await storeLinkRules(
    env,
    LinkRulesConfigSchema.parse({
      rules: [
        { id: "web", pattern: "(T\\d{8})", url_template: "https://example.com/$1" },
        { id: "off", pattern: "x", url_template: "https://example.com/", enabled: false },
        { id: "app", pattern: "(y)", url_template: "obsidian://$1" },
      ],
    }),
  );
  const some = await rules();
  expect(some.rules.map((r) => r.id)).toEqual(["web"]);
  expect(some.rev).not.toBe(none.rev);
  const info2 = (await (await get("/api/v1/sync/info", token)).json()) as { link_rules_rev: string };
  expect(info2.link_rules_rev).toBe(some.rev);
  // Stored rules that don't parse: /sync/info still answers, with no rev.
  await env.TODO_CACHE.put("config:link_rules", JSON.stringify({ rules: [{ id: 1 }] }));
  const info3 = (await (await check("info with bad rules", await get("/api/v1/sync/info", token), 200)).json()) as {
    link_rules_rev: string | null;
  };
  expect(info3.link_rules_rev).toBeNull();
  await env.TODO_CACHE.delete("config:link_rules");

  // The feed, then the same cursor again: caught up.
  const page = (await (await check("changes", await get("/api/v1/sync/changes?scope=all", token), 200)).json()) as {
    cursor: string;
    has_more: boolean;
    changes: Array<{ kind: string; id: string; data: { title?: string } }>;
  };
  const t1 = page.changes.find((c) => c.kind === "task" && c.data.title === "pay the invoice");
  expect(["T1 in the feed", Boolean(t1)]).toEqual(["T1 in the feed", true]);
  const again = (await (await get(`/api/v1/sync/changes?cursor=${page.cursor}`, token)).json()) as { changes: unknown[] };
  expect(["caught up", again.changes.length]).toEqual(["caught up", 0]);

  // Cursor and parameter errors.
  const err = async (label: string, path: string, status: number, error: string) => {
    const res = await check(label, await get(path, token), status);
    expect([label, await res.json()]).toEqual([label, { error }]);
  };
  await err("cursor from another epoch", "/api/v1/sync/changes?cursor=ffff.1", 410, "cursor_reset");
  await err("malformed cursor", "/api/v1/sync/changes?cursor=nope", 400, "bad_cursor");
  await err("unknown scope", "/api/v1/sync/changes?scope=some", 400, "bad_scope");
  await err("non-numeric limit", "/api/v1/sync/changes?limit=ten", 400, "bad_limit");

  // One task by sid; an unknown sid.
  const one = (await (await check("task by sid", await get(`/api/v1/tasks/${t1!.id}`, token), 200)).json()) as {
    id: string;
    data: { title: string };
  };
  expect([one.id, one.data.title]).toEqual([t1!.id, "pay the invoice"]);
  await err("unknown sid", "/api/v1/tasks/00000000-0000-0000-0000-000000000000", 404, "not_found");

  // Search answers with tasks by sid. The query is plain text: a stray quote
  // is literal, not an FTS syntax error, and a word matches as a prefix.
  const found = (await (await check("search", await get("/api/v1/search?q=invoice", token), 200)).json()) as {
    results: Array<{ kind: string; id: string }>;
  };
  expect(found.results.map((r) => [r.kind, r.id])).toEqual([["task", t1!.id]]);
  // "NOT" and "OR" are words to find, not operators, so those match nothing.
  for (const [q, hits] of [['"pay', 1], ["invo", 1], ["pay NOT", 0], ["bank OR invoice", 0], ["pay\u0000ment", 0], ["pay\u0000", 1]] as const) {
    const res = await check(`search ${q}`, await get(`/api/v1/search?q=${encodeURIComponent(q)}`, token), 200);
    const ids = ((await res.json()) as { results: Array<{ id: string }> }).results.map((r) => r.id);
    expect([q, ids]).toEqual([q, hits ? [t1!.id] : []]);
  }
  await err("empty query", "/api/v1/search?q=", 400, "bad_query");

  await err("unknown route", "/api/v1/nope", 404, "not_found");

  // The /mcp resource refuses this token.
  await check("/api/v1 token on /mcp", await get("/mcp", token), 401);

  // The grant gate: after revoke_all_connections the token is refused on
  // every route, and its refresh is refused.
  await index.revokeAllGrants();
  for (const path of ["/api/v1/sync/changes", "/api/v1/sync/info"]) {
    const res = await check(`${path} after revocation`, await get(path, token), 401);
    expect([path, ((await res.json()) as { error: string }).error]).toEqual([path, "invalid_token"]);
  }
  const refused = await client.send(
    "/token",
    client.form({ grant_type: "refresh_token", refresh_token, client_id: clientId }),
  );
  expect(["refresh after revocation", refused.status]).toEqual(["refresh after revocation", 400]);
  // The unauthenticated probe still answers.
  await check("info without token after revocation", await get("/api/v1/sync/info"), 200);
}
