// GET /api/v1/link-rules — the owner's enabled link rules, read-only, so the
// app can mark matches in titles and notes before the server has made the
// task's link (docs/SYNC-API.md section 4.7). The server stays the authority:
// it alone creates links, after a write that changes a title or body.
import { loadLinkRules } from "../config/loader";
import type { LinkRulesConfig } from "../config/schemas";
import type { AppEnv } from "../ports";
import { json } from "./respond";

export type AppLinkRule = {
  id: string;
  pattern: string;
  flags: string;
  fields: "title" | "body" | "both";
  url_template: string;
  display_template: string | null;
  application_name: string;
};

// A rule the app may use: enabled, and its template fixes an http or https
// scheme. A template that starts with a capture ($1) or another scheme is left
// out: the app could otherwise be handed a URL whose scheme the typed text
// chose. external_id_template is the server's dedupe key and isn't sent.
const WEB_TEMPLATE = /^https?:\/\//i;

export function appLinkRules(config: LinkRulesConfig): AppLinkRule[] {
  return config.rules
    .filter((r) => r.enabled && WEB_TEMPLATE.test(r.url_template))
    .map((r) => ({
      id: r.id,
      pattern: r.pattern,
      flags: r.flags,
      fields: r.fields,
      url_template: r.url_template,
      display_template: r.display_template ?? null,
      application_name: r.application_name,
    }));
}

// A digest of exactly what the route returns, so it changes when and only
// when the app's copy is out of date. Derived, not stored: no write path
// (set_link_rules, a hand edit of KV) can forget to bump it.
export async function linkRulesRev(rules: AppLinkRule[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(rules));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function currentLinkRules(env: AppEnv): Promise<{ rev: string; rules: AppLinkRule[] }> {
  const rules = appLinkRules(await loadLinkRules(env));
  return { rev: await linkRulesRev(rules), rules };
}

export async function linkRulesRoute(_url: URL, env: AppEnv): Promise<Response> {
  return json(await currentLinkRules(env));
}
