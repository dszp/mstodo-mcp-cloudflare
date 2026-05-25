import { describe, it, expect } from "vitest";
import { runLinkRules } from "../src/config/link-rules-engine";
import { LinkRulesConfigSchema, type LinkRulesConfig } from "../src/config/schemas";

// Parse through the schema so defaults (flags, fields, max_links_per_task,
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
  max_links_per_task: 1,
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
