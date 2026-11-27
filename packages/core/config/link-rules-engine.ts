import type { LinkRulesConfig } from "./schemas";

// Per-call limits documented in canonical plan §Sharp edges §Regex DoS.
const BODY_CAP_BYTES = 8 * 1024; // 8 KB — bound regex work on long bodies
const BUDGET_MS = 50; // total wall-clock budget across all rules per call

export interface LinkRuleMatch {
  url: string;
  displayName: string;
  externalId: string;
  applicationName: string;
  rule_id: string;
}

// Substitute $1, $2, ... capture groups into a template string.
function applyTemplate(template: string, match: RegExpMatchArray): string {
  return template.replace(/\$(\d+)/g, (_, n: string) => match[Number(n)] ?? "");
}

// Run enabled link rules against a task's fields and return the single linked
// resource to create, or [] if nothing matches.
//
// Microsoft To Do allows exactly ONE linked resource per task, so this returns
// at most one match: rules are evaluated in array order and the FIRST rule that
// matches wins (rule order is the priority). Within a rule, title is matched
// before body. The return type stays an array (length 0 or 1) so callers can
// iterate uniformly.
//
// Pure function — no I/O. Caller is responsible for loading LinkRulesConfig
// via loadLinkRules(), for skipping tasks that already carry a linked resource,
// and for writing the returned match as a linked resource.
export function runLinkRules(
  config: LinkRulesConfig,
  task: { title?: string; body?: { content?: string | null } },
): LinkRuleMatch[] {
  const deadline = Date.now() + BUDGET_MS;

  const title = task.title ?? "";
  // Truncate body at BODY_CAP_BYTES before matching to bound worst-case regex work.
  const rawBody = task.body?.content ?? "";
  const body = rawBody.length > BODY_CAP_BYTES ? rawBody.slice(0, BODY_CAP_BYTES) : rawBody;

  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    if (Date.now() >= deadline) break; // budget exhausted — skip remaining rules

    let regex: RegExp;
    try {
      // No 'g' flag: we only need the first match (with capture groups) per field.
      regex = new RegExp(rule.pattern, rule.flags.replace(/g/g, ""));
    } catch {
      // Invalid pattern shouldn't survive set_link_rules validation, but skip
      // gracefully rather than crashing the whole engine if one slips through.
      continue;
    }

    const texts: string[] =
      rule.fields === "title" ? [title]
      : rule.fields === "body" ? [body]
      : [title, body]; // "both" — title first, then body

    for (const text of texts) {
      const m = text.match(regex);
      if (!m) continue;

      const url = applyTemplate(rule.url_template, m);
      if (!url) continue;

      const displayName = rule.display_template
        ? applyTemplate(rule.display_template, m)
        : m[0]; // default: the matched text itself

      // externalId is what makes the To Do client render the linked resource
      // as a clickable row. Default to the matched text (same fallback as
      // displayName) so every rule-created link renders unless overridden.
      const externalId = rule.external_id_template
        ? applyTemplate(rule.external_id_template, m)
        : m[0];

      // First match wins — return immediately (one linked resource per task).
      return [
        {
          url,
          displayName,
          externalId,
          applicationName: rule.application_name,
          rule_id: rule.id,
        },
      ];
    }
  }

  return [];
}
