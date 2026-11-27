import { describe, it, expect } from "vitest";
import { appLinkRules, linkRulesRev } from "@potem/core/api/link-rules";
import { LinkRulesConfigSchema } from "@potem/core/config/schemas";

const cfg = (rules: unknown[]) => LinkRulesConfigSchema.parse({ rules });
const rule = (over: Record<string, unknown>) => ({
  id: "r",
  pattern: "(T\\d{8})",
  url_template: "https://example.com/t/$1",
  external_id_template: "$1",
  ...over,
});

describe("appLinkRules", () => {
  it("sends enabled web rules with defaults filled and no external_id_template", () => {
    expect(appLinkRules(cfg([rule({ id: "a", display_template: "Ticket $1", fields: "both" })]))).toEqual([
      {
        id: "a",
        pattern: "(T\\d{8})",
        flags: "",
        fields: "both",
        url_template: "https://example.com/t/$1",
        display_template: "Ticket $1",
        application_name: "link-rules-engine",
      },
    ]);
    expect(appLinkRules(cfg([rule({ id: "b" })]))[0].display_template).toBeNull();
  });

  it("leaves out each rule the app must not use", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["disabled", { enabled: false }],
      ["scheme chosen by a capture", { url_template: "$1" }],
      ["non-web scheme", { url_template: "obsidian://open?vault=$1" }],
      ["javascript scheme", { url_template: "javascript:alert($1)" }],
    ];
    for (const [label, over] of cases) {
      expect([label, appLinkRules(cfg([rule(over)]))]).toEqual([label, []]);
    }
    expect(appLinkRules(cfg([rule({ url_template: "HTTP://example.com/$1" })]))).toHaveLength(1);
  });
});

describe("linkRulesRev", () => {
  it("is stable for the same rules and changes with any returned field", async () => {
    const base = appLinkRules(cfg([rule({})]));
    const rev = await linkRulesRev(base);
    expect(rev).toMatch(/^[0-9a-f]{16}$/);
    expect(await linkRulesRev(appLinkRules(cfg([rule({})])))).toBe(rev);
    for (const [label, over] of [
      ["pattern", { pattern: "(X\\d+)" }],
      ["flags", { flags: "i" }],
      ["fields", { fields: "body" }],
      ["url", { url_template: "https://example.org/$1" }],
      ["display", { display_template: "T $1" }],
      ["app", { application_name: "Other" }],
    ] as const) {
      expect([label, await linkRulesRev(appLinkRules(cfg([rule(over)])))]).not.toEqual([label, rev]);
    }
    // A change the app never sees doesn't move it.
    expect(await linkRulesRev(appLinkRules(cfg([rule({ external_id_template: "x$1" })])))).toBe(rev);
    expect(await linkRulesRev(appLinkRules(cfg([rule({}), rule({ id: "off", enabled: false })])))).toBe(rev);
  });
});
