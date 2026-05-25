import { describe, it, expect } from "vitest";
import {
  authScopes,
  myDayEnabled,
  decodeJwtClaims,
  buildAnchorMailbox,
  SCOPES,
  EXO_TASKS_SCOPE,
  SUBSTRATE_SCOPES,
} from "../src/auth/microsoft";
import {
  assertSubstrateUrl,
  redactSubstrateUrl,
  extractTasks,
  SubstrateError,
  SubstrateTaskSchema,
} from "../src/graph/substrate-client";

// Minimal Env stub — these helpers only read ENABLE_MY_DAY.
const env = (enableMyDay?: string): Env => ({ ENABLE_MY_DAY: enableMyDay }) as unknown as Env;

// Build a JWT-shaped string with the given payload claims (base64url, no sig needed).
function fakeJwt(claims: Record<string, unknown>): string {
  const b64url = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`;
}

describe("myDayEnabled", () => {
  it("is true only for the string 'true' (case-insensitive)", () => {
    expect(myDayEnabled(env("true"))).toBe(true);
    expect(myDayEnabled(env("TRUE"))).toBe(true);
  });
  it("is false for 'false', empty, or undefined", () => {
    expect(myDayEnabled(env("false"))).toBe(false);
    expect(myDayEnabled(env(""))).toBe(false);
    expect(myDayEnabled(env(undefined))).toBe(false);
  });
});

describe("authScopes", () => {
  it("requests Graph scopes only when My Day is off", () => {
    expect(authScopes(env("false"))).toBe(SCOPES);
    expect(authScopes(env("false"))).not.toContain(EXO_TASKS_SCOPE);
  });
  it("adds the Exchange Online Tasks scope when My Day is on (single combined consent)", () => {
    const scopes = authScopes(env("true"));
    expect(scopes).toContain("Tasks.ReadWrite");
    expect(scopes).toContain("User.Read");
    expect(scopes).toContain(EXO_TASKS_SCOPE);
  });
});

describe("substrate scope constant", () => {
  it("carries offline_access so refresh-token rotation continues on EXO mints", () => {
    expect(SUBSTRATE_SCOPES).toContain(EXO_TASKS_SCOPE);
    expect(SUBSTRATE_SCOPES).toContain("offline_access");
  });
});

describe("decodeJwtClaims", () => {
  it("extracts the tid claim from a token payload", () => {
    const jwt = fakeJwt({ tid: "tenant-123", oid: "user-abc" });
    const claims = decodeJwtClaims(jwt);
    expect(claims?.tid).toBe("tenant-123");
    expect(claims?.oid).toBe("user-abc");
  });
  it("returns null for a malformed token", () => {
    expect(decodeJwtClaims("not-a-jwt")).toBeNull();
    expect(decodeJwtClaims("")).toBeNull();
    expect(decodeJwtClaims("a.!!!notbase64!!!.c")).toBeNull();
  });
});

describe("buildAnchorMailbox", () => {
  it("formats OID:{oid}@{tid}", () => {
    expect(buildAnchorMailbox("user-abc", "tenant-123")).toBe("OID:user-abc@tenant-123");
  });
});

describe("assertSubstrateUrl (Bearer-token host pin)", () => {
  it("accepts the canonical substrate base", () => {
    expect(() =>
      assertSubstrateUrl("https://substrate.office.com/todob2/api/v1/taskfolders/F/tasks/T"),
    ).not.toThrow();
  });
  it("rejects a non-substrate host (token-exfil attempt)", () => {
    expect(() => assertSubstrateUrl("https://evil.example.com/todob2")).toThrow(SubstrateError);
  });
  it("rejects a look-alike suffix host", () => {
    expect(() => assertSubstrateUrl("https://substrate.office.com.evil.com/x")).toThrow(
      SubstrateError,
    );
  });
  it("rejects non-https on the substrate host", () => {
    expect(() => assertSubstrateUrl("http://substrate.office.com/x")).toThrow(SubstrateError);
  });
});

describe("redactSubstrateUrl", () => {
  it("drops the query string (the $filter carries task dates)", () => {
    expect(
      redactSubstrateUrl(
        "https://substrate.office.com/todob2/api/v1/taskfolders/F/tasks?$filter=CommittedDay%20eq%20'2026-05-25'",
      ),
    ).toBe("https://substrate.office.com/todob2/api/v1/taskfolders/F/tasks");
  });
});

describe("SubstrateTaskSchema", () => {
  it("parses leniently — reads CommittedDay and passes the rest through", () => {
    const t = SubstrateTaskSchema.parse({
      Id: "AAMkAD123",
      Subject: "Buy milk",
      CommittedDay: "2026-05-25",
      SomeOtherOutlookField: 42,
    });
    expect(t.CommittedDay).toBe("2026-05-25");
    expect(t.Id).toBe("AAMkAD123");
    expect((t as Record<string, unknown>).SomeOtherOutlookField).toBe(42);
  });
  it("accepts a null CommittedDay (task not in My Day)", () => {
    expect(SubstrateTaskSchema.parse({ Id: "x", CommittedDay: null }).CommittedDay).toBeNull();
  });
});

describe("extractTasks (tolerant folder-tasks envelope)", () => {
  it("reads a lowercase OData `value` array", () => {
    const out = extractTasks({ value: [{ Id: "a", CommittedDay: "2026-05-25T00:00:00Z" }] });
    expect(out.map((t) => t.Id)).toEqual(["a"]);
  });
  it("reads a PascalCase `Value` array", () => {
    expect(extractTasks({ Value: [{ Id: "b" }] }).map((t) => t.Id)).toEqual(["b"]);
  });
  it("reads a bare top-level array", () => {
    expect(extractTasks([{ Id: "c" }]).map((t) => t.Id)).toEqual(["c"]);
  });
  it("returns [] for an empty-folder envelope with no array (the live 500 case)", () => {
    expect(extractTasks({})).toEqual([]);
    expect(extractTasks(null)).toEqual([]);
  });
  it("skips malformed items rather than throwing", () => {
    const out = extractTasks({ value: [{ Id: "ok" }, 42, "nope", { Id: "ok2" }] });
    expect(out.map((t) => t.Id)).toEqual(["ok", "ok2"]);
  });
});
