import { describe, it, expect } from "vitest";
import { runLinkRules } from "../src/config/link-rules-engine";
import { LinkRulesConfigSchema, type LinkRulesConfig } from "../src/config/schemas";

// Parse through the schema so defaults (flags, fields, application_name,
// enabled) are applied exactly as they are at runtime.
const cfg = (rules: unknown[]): LinkRulesConfig =>
  LinkRulesConfigSchema.parse({ rules });

const autotaskRule = {
  id: "autotask-ticket",
  pattern: "(T\\d{8}\\.\\d{4}(?:\\.\\d{3})?)",
  url_template:
    "https://ww3.autotask.net/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketNumber=$1",
  display_template: "Ticket $1",
  external_id_template: "$1",
  application_name: "Autotask",
  fields: "both",
};

const obsidianRule = {
  id: "obsidian-note",
  pattern: "https://o\\.dszp\\.app/n/([A-Za-z0-9_-]{21})",
  url_template: "https://o.dszp.app/n/$1",
  display_template: "Note: $1",
  external_id_template: "$1",
  application_name: "Obsidian",
  fields: "both",
};

describe("runLinkRules externalId", () => {
  it("populates externalId from external_id_template (the rendering fix)", () => {
    const matches = runLinkRules(cfg([autotaskRule]), {
      title: "Test todo for ticket T20260524.0001",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      displayName: "Ticket T20260524.0001",
      externalId: "T20260524.0001",
      applicationName: "Autotask",
      url: expect.stringContaining("TicketNumber=T20260524.0001"),
    });
  });

  it("defaults externalId to the matched text when external_id_template is omitted", () => {
    const { external_id_template: _omit, ...ruleWithoutTemplate } = autotaskRule;
    const matches = runLinkRules(cfg([ruleWithoutTemplate]), {
      body: { content: "see T20260524.0001 for details" },
    });
    expect(matches).toHaveLength(1);
    // Pattern is the whole capture group, so matched text === ticket number.
    expect(matches[0].externalId).toBe("T20260524.0001");
  });
});

describe("runLinkRules one-linked-resource-per-task", () => {
  it("returns at most one match even when several would match", () => {
    // Body contains both an Autotask ticket and an Obsidian link.
    const matches = runLinkRules(cfg([autotaskRule, obsidianRule]), {
      body: {
        content:
          "ref T20260524.0001 and https://o.dszp.app/n/6cfFQ5GUYAZiHdAUBqsy2 too",
      },
    });
    expect(matches).toHaveLength(1);
  });

  it("first rule in array order wins (rule order is the priority)", () => {
    const both = {
      body: {
        content:
          "ref T20260524.0001 and https://o.dszp.app/n/6cfFQ5GUYAZiHdAUBqsy2 too",
      },
    };
    // Autotask first → Autotask wins.
    expect(runLinkRules(cfg([autotaskRule, obsidianRule]), both)[0].applicationName).toBe(
      "Autotask",
    );
    // Obsidian first → Obsidian wins.
    expect(runLinkRules(cfg([obsidianRule, autotaskRule]), both)[0].applicationName).toBe(
      "Obsidian",
    );
  });

  it("matches title before body within a rule", () => {
    const matches = runLinkRules(cfg([autotaskRule]), {
      title: "ticket T20260101.1111",
      body: { content: "other ticket T20260524.0001" },
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].externalId).toBe("T20260101.1111"); // from title
  });

  it("returns [] when no rule matches", () => {
    expect(runLinkRules(cfg([autotaskRule]), { title: "nothing here" })).toEqual([]);
  });

  it("skips disabled rules", () => {
    const matches = runLinkRules(cfg([{ ...autotaskRule, enabled: false }]), {
      title: "ticket T20260524.0001",
    });
    expect(matches).toEqual([]);
  });
});
