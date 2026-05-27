import { z } from "zod";

// config:link_rules — stored as JSON in KV under the key "config:link_rules".
//
// Each rule matches a regex against a task's title (and optionally body), then
// creates a linked resource on the task using the substituted URL and display
// name.
//
// IMPORTANT — Microsoft To Do allows exactly ONE linked resource per task
// (Graph rejects a second with HTTP 400 "Linked Resource already exists" /
// innerError `LinkedResourceSizeExceeded`). Consequently the engine creates at
// most one linked resource per task: rules are evaluated in array order and the
// FIRST rule that matches wins — rule order is the priority. If the task
// already carries any linked resource (a prior rule link, a manually-added one,
// or Outlook's built-in "Open in Outlook" on flagged-email tasks), the engine
// skips rather than replacing it.
//
// Field constraints (enforced at set_link_rules write time):
//   - `pattern` must compile as a valid JS RegExp.
//   - `url_template`, `display_template`, and `external_id_template` use
//     $1, $2, ... for capture groups.
//   - `fields` controls which task text is matched: "title" | "body" | "both".
//     Defaults to "title" when omitted. Within a rule, title is matched before
//     body.

export const LinkRuleSchema = z.object({
  id: z.string().min(1).describe("Stable identifier for the rule (used for logging)."),
  pattern: z.string().min(1).describe("JavaScript RegExp source string (no delimiters)."),
  flags: z.string().default("").describe("RegExp flags (e.g. 'i' for case-insensitive)."),
  url_template: z
    .string()
    .min(1)
    .describe("URL template. Use $1, $2, … for capture groups from the pattern."),
  display_template: z
    .string()
    .optional()
    .describe("Display name template. Defaults to the matched text when omitted."),
  external_id_template: z
    .string()
    .optional()
    .describe(
      "externalId template. Use $1, $2, … for capture groups. Defaults to the matched text when omitted. " +
        "Microsoft To Do requires a linked resource to carry an externalId before it renders the link as a clickable row in the client.",
    ),
  application_name: z
    .string()
    .default("link-rules-engine")
    .describe("applicationName written to the linked resource."),
  fields: z
    .enum(["title", "body", "both"])
    .default("title")
    .describe("Which task field(s) to match the pattern against. Title is matched before body."),
  enabled: z.boolean().default(true).describe("Set false to disable without deleting the rule."),
});
export type LinkRule = z.infer<typeof LinkRuleSchema>;

export const LinkRulesConfigSchema = z.object({
  rules: z.array(LinkRuleSchema).default([]),
});
export type LinkRulesConfig = z.infer<typeof LinkRulesConfigSchema>;

// config:lists — stored as JSON in KV under the key "config:lists".
//
// Two sub-structures:
//   - `patterns`: ordered list of regex patterns matched against a list's
//     display name (emoji and leading/trailing whitespace stripped before
//     matching). First match wins; unmatched lists are "unclassified".
//     Defaults to case-insensitive ("i" flag default).
//   - `aliases`: map of shorthand alias → canonical Graph list ID. Multiple
//     aliases may point to the same list ID. Aliases are resolved before
//     display-name matching in all list-targeting tool parameters.

export const ListPatternSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe(
      "JavaScript RegExp source string matched against the list display name (emoji and surrounding whitespace stripped before matching).",
    ),
  flags: z
    .string()
    .default("i")
    .describe("RegExp flags. Defaults to 'i' (case-insensitive)."),
  type: z
    .enum(["todo", "reference", "excluded"])
    .describe("Classification label assigned when this pattern matches."),
});
export type ListPattern = z.infer<typeof ListPatternSchema>;

export const ListsConfigSchema = z.object({
  patterns: z
    .array(ListPatternSchema)
    .default([])
    .describe("Ordered list of patterns. First match wins."),
  aliases: z
    .record(z.string().min(1), z.string().min(1))
    .default({})
    .describe(
      "Map of alias → Graph list ID. Multiple aliases may point to the same list ID.",
    ),
  overrides: z
    .record(z.string().min(1), z.enum(["todo", "reference", "excluded"]))
    .default({})
    .describe(
      "Map of Graph list ID → classification, pinned so a rename can't silently change a list's class. " +
      "Checked BEFORE name patterns; auto-populated by list_lists the first time a list is classified by a " +
      "pattern, then it follows the immutable ID. Edit via set_list_config.overrides; drop a key to revert a " +
      "list to pattern-based (it re-pins from patterns on the next list_lists).",
    ),
  no_sync: z
    .array(z.string().min(1))
    .default([])
    .describe(
      'Lists to exclude from delta sync, matched by wellknownListName (e.g. "flaggedEmails") or Graph list ID. Not indexed; still listed and readable on-demand. (Note: flaggedEmails is skipped by default regardless — see sync_flagged_emails.)',
    ),
  sync_flagged_emails: z
    .boolean()
    .default(false)
    .describe(
      "Opt in to indexing the flaggedEmails well-known list. Off by default because it is typically huge and not used as a task list; leaving it off conserves the daily rows-written budget and storage.",
    ),
});
export type ListsConfig = z.infer<typeof ListsConfigSchema>;

// config:attachments — stored as JSON in KV under the key "config:attachments".
//
// `max_inline_bytes` is the cutover the web upload (/upload) uses: files at or
// below it attach inline, larger ones (up to 25 MB) via a chunked Graph
// upload-session. Must not exceed GRAPH_INLINE_HARD_LIMIT (3072 KiB), the
// empirically confirmed Graph inline ceiling (Phase 0.5b).

const GRAPH_INLINE_HARD_LIMIT = 3072 * 1024; // 3072 KiB — Graph's confirmed ceiling

export const AttachmentConfigSchema = z.object({
  max_inline_bytes: z
    .number()
    .int()
    .min(1)
    .max(GRAPH_INLINE_HARD_LIMIT)
    .default(GRAPH_INLINE_HARD_LIMIT)
    .describe(
      `Maximum raw file size (bytes) accepted for inline uploads. Hard ceiling: ${GRAPH_INLINE_HARD_LIMIT} bytes (3072 KiB, Graph limit confirmed in Phase 0.5b).`,
    ),
});
export type AttachmentConfig = z.infer<typeof AttachmentConfigSchema>;
