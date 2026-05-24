import { AttachmentConfigSchema, LinkRulesConfigSchema, ListsConfigSchema, type AttachmentConfig, type LinkRulesConfig, type ListsConfig } from "./schemas";

const LINK_RULES_KEY = "config:link_rules";

// Load and validate link rules from KV. Returns the parsed config, or a
// default empty-rules config if the key is absent. Throws a ZodError on
// schema violations (surfaced loudly — config drift should not be silent).
//
// No in-memory memoization: each tool invocation runs inside a fresh DO
// request context, so memoization across calls is not meaningful. Within a
// single request, callers may cache the return value themselves.
export async function loadLinkRules(env: Env): Promise<LinkRulesConfig> {
  const raw = await env.TODO_CACHE.get(LINK_RULES_KEY, "json");
  if (raw === null) return { rules: [] };
  return LinkRulesConfigSchema.parse(raw);
}

// Persist validated link rules to KV.
export async function storeLinkRules(env: Env, config: LinkRulesConfig): Promise<void> {
  await env.TODO_CACHE.put(LINK_RULES_KEY, JSON.stringify(config));
}

const ATTACHMENT_CONFIG_KEY = "config:attachments";

// Load and validate attachment config from KV. Returns defaults when absent.
export async function loadAttachmentConfig(env: Env): Promise<AttachmentConfig> {
  const raw = await env.TODO_CACHE.get(ATTACHMENT_CONFIG_KEY, "json");
  if (raw === null) return AttachmentConfigSchema.parse({});
  return AttachmentConfigSchema.parse(raw);
}

// Persist validated attachment config to KV.
export async function storeAttachmentConfig(env: Env, config: AttachmentConfig): Promise<void> {
  await env.TODO_CACHE.put(ATTACHMENT_CONFIG_KEY, JSON.stringify(config));
}

const LISTS_CONFIG_KEY = "config:lists";

// Load and validate lists config from KV. Returns defaults (empty patterns and
// aliases) when absent.
export async function loadListsConfig(env: Env): Promise<ListsConfig> {
  const raw = await env.TODO_CACHE.get(LISTS_CONFIG_KEY, "json");
  if (raw === null) return ListsConfigSchema.parse({});
  return ListsConfigSchema.parse(raw);
}

// Persist validated lists config to KV.
export async function storeListsConfig(env: Env, config: ListsConfig): Promise<void> {
  await env.TODO_CACHE.put(LISTS_CONFIG_KEY, JSON.stringify(config));
}
