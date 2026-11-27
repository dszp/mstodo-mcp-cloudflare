import { describe, it, expect } from "vitest";
import { deployedContent, diffRenders } from "../diff.ts";
import type { WranglerConfig } from "../render.ts";

const base = (): WranglerConfig => ({
  $schema: "../../../../node_modules/wrangler/config-schema.json",
  main: "../../../../workers/server/src/hosts/cloudflare/worker.ts",
  name: "example-potem",
  account_id: "0123456789abcdef0123456789abcdef",
  compatibility_date: "2026-01-01",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: true,
  preview_urls: false,
  vars: { DELTA_SYNC_INTERVAL_MIN: "15", TIMEZONE: "UTC" },
  kv_namespaces: [{ binding: "TODO_CACHE", id: "0123" }],
  migrations: [{ tag: "v1", new_sqlite_classes: ["TodoIndex"] }],
  triggers: { crons: ["*/15 * * * *"] },
});

describe("diffRenders", () => {
  it("reports a first deploy when there is no previous render", () => {
    expect(diffRenders(null, base())).toEqual(["first deploy from this machine: no last-deployed.json"]);
  });

  it("returns nothing for identical renders", () => {
    expect(diffRenders(base(), base())).toEqual([]);
  });

  it("ignores main and $schema", () => {
    const next = { ...base(), main: "../elsewhere/worker.ts", $schema: "../elsewhere/schema.json" };
    expect(diffRenders(base(), next)).toEqual([]);
  });

  it("reports a changed var with old and new values", () => {
    const next = base();
    next.vars = { DELTA_SYNC_INTERVAL_MIN: "30", TIMEZONE: "UTC" };
    expect(diffRenders(base(), next)).toEqual(['vars.DELTA_SYNC_INTERVAL_MIN: "15" → "30"']);
  });

  it("reports added and removed vars", () => {
    const next = base();
    next.vars = { DELTA_SYNC_INTERVAL_MIN: "15", NEW_VAR: "b" };
    expect(diffRenders(base(), next)).toEqual(['vars.NEW_VAR: added "b"', 'vars.TIMEZONE: removed "UTC"']);
  });

  it("reports an added migration tag under migrations", () => {
    const next = base();
    next.migrations = [...(next.migrations as unknown[]), { tag: "v2", new_sqlite_classes: ["Other"] }];
    const lines = diffRenders(base(), next);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("migrations");
    expect(lines[0]).toContain('"tag":"v2"');
  });

  it("ignores object key order inside a compared value", () => {
    const next = base();
    next.triggers = { crons: ["*/15 * * * *"] };
    next.kv_namespaces = [{ id: "0123", binding: "TODO_CACHE" }];
    expect(diffRenders(base(), next)).toEqual([]);
  });

  it("reports added and removed top-level keys", () => {
    const next = base();
    delete next.routes;
    next.routes = [{ pattern: "example.test", custom_domain: true }];
    delete next.workers_dev;
    expect(diffRenders(base(), next)).toEqual([
      'routes: added [{"custom_domain":true,"pattern":"example.test"}]',
      "workers_dev: removed true",
    ]);
  });

  it("compares a top-level key outside the listed set", () => {
    const prev = { ...base(), observability: { enabled: true } };
    const next = { ...base(), observability: { enabled: false } };
    expect(diffRenders(prev, next)).toEqual(['observability: {"enabled":true} → {"enabled":false}']);
  });

  it("sorts lines by key", () => {
    const next = base();
    next.name = "example-other";
    next.compatibility_date = "2026-02-02";
    next.vars = { DELTA_SYNC_INTERVAL_MIN: "30", TIMEZONE: "UTC" };
    const keys = diffRenders(base(), next).map((l) => l.split(":")[0]);
    expect(keys).toEqual(["compatibility_date", "name", "vars.DELTA_SYNC_INTERVAL_MIN"]);
  });
});

describe("deployedContent", () => {
  it("lists each var and every structured top-level key except paths and migrations", () => {
    expect(deployedContent(base())).toEqual([
      'vars.DELTA_SYNC_INTERVAL_MIN: "15"',
      'vars.TIMEZONE: "UTC"',
      'compatibility_flags: ["nodejs_compat"]',
      'kv_namespaces: [{"binding":"TODO_CACHE","id":"0123"}]',
      'triggers: {"crons":["*/15 * * * *"]}',
    ]);
  });
});
