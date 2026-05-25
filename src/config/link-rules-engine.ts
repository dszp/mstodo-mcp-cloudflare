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

// Run all enabled link rules against a task's fields. Returns the set of
// linked resources to create, deduped by URL across all rules.
//
// Pure function — no I/O. Caller is responsible for loading LinkRulesConfig
// via loadLinkRules() and for writing the returned matches as linked resources.
export function runLinkRules(
  config: LinkRulesConfig,
  task: { title?: string; body?: { content?: string | null } },
): LinkRuleMatch[] {
  const deadline = Date.now() + BUDGET_MS;
  const seenUrls = new Set<string>(); // cross-rule URL dedup
  const results: LinkRuleMatch[] = [];

  const title = task.title ?? "";
  // Truncate body at BODY_CAP_BYTES before matching to bound worst-case regex work.
  const rawBody = task.body?.content ?? "";
  const body = rawBody.length > BODY_CAP_BYTES ? rawBody.slice(0, BODY_CAP_BYTES) : rawBody;

  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    if (Date.now() >= deadline) break; // budget exhausted — skip remaining rules

    // Ensure the global flag is set so matchAll() iterates through all matches.
    // Preserve user flags; don't double-add 'g'.
    const flags = rule.flags.includes("g") ? rule.flags : `${rule.flags}g`;
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, flags);
    } catch {
      // Invalid pattern shouldn't survive set_link_rules validation, but skip
      // gracefully rather than crashing the whole engine if one slips through.
      continue;
    }

    const texts: string[] =
      rule.fields === "title" ? [title]
      : rule.fields === "body" ? [body]
      : [title, body]; // "both" — title first, then body

    let ruleCount = 0; // tracks matches produced by this rule across all fields

    outer: for (const text of texts) {
      for (const m of text.matchAll(regex)) {
        if (Date.now() >= deadline) break outer;
        if (ruleCount >= rule.max_links_per_task) break;

        const url = applyTemplate(rule.url_template, m);
        if (!url || seenUrls.has(url)) continue;

        const displayName = rule.display_template
          ? applyTemplate(rule.display_template, m)
          : m[0]; // default: the matched text itself

        // externalId is what makes the To Do client render the linked resource
        // as a clickable row. Default to the matched text (same fallback as
        // displayName) so every rule-created link renders unless overridden.
        const externalId = rule.external_id_template
          ? applyTemplate(rule.external_id_template, m)
          : m[0];

        seenUrls.add(url);
        results.push({
          url,
          displayName,
          externalId,
          applicationName: rule.application_name,
          rule_id: rule.id,
        });
        ruleCount++;
      }
    }
  }

  return results;
}
