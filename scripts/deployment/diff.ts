// Compares a fresh render against the one last deployed from this machine, so the
// deploy command can show an operator what a changed workers/server/wrangler.example.jsonc default
// is about to do to their deployment. Erasable TypeScript only: this runs on bare Node.
import type { WranglerConfig } from "./render.ts";

// `main` and `$schema` are paths relative to the render directory, so they differ
// between machines without meaning anything. Every other top-level key is compared,
// including ones the example gains later, so a new key never goes unseen.
const IGNORED = new Set(["main", "$schema"]);

export const FIRST_DEPLOY_LINE = "first deploy from this machine: no last-deployed.json";

// JSON with object keys sorted at every depth, so key order never reads as a change.
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function compare(label: string, prev: unknown, next: unknown, out: Map<string, string>): void {
  const had = prev !== undefined;
  const has = next !== undefined;
  if (!had && !has) return;
  if (!had) out.set(label, `${label}: added ${stable(next)}`);
  else if (!has) out.set(label, `${label}: removed ${stable(prev)}`);
  else if (stable(prev) !== stable(next)) out.set(label, `${label}: ${stable(prev)} → ${stable(next)}`);
}

export function diffRenders(prev: WranglerConfig | null, next: WranglerConfig): string[] {
  if (prev === null) return [FIRST_DEPLOY_LINE];
  const changes = new Map<string, string>();
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (IGNORED.has(key)) continue;
    if (key === "vars") {
      const before = isRecord(prev.vars) ? prev.vars : {};
      const after = isRecord(next.vars) ? next.vars : {};
      for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
        compare(`vars.${name}`, before[name], after[name], changes);
      }
      continue;
    }
    compare(key, prev[key], next[key], changes);
  }
  return [...changes.keys()].sort().map((label) => changes.get(label) as string);
}

// What a first deploy from this machine sends, for the confirmation to show: each
// var, then every top-level key holding an object or array (bindings, routes,
// triggers, flags), so a binding kind the example gains later is listed too.
// migrations is history, not configuration. Nothing here is secret: secrets are
// never in the render.
export function deployedContent(config: WranglerConfig): string[] {
  const out: string[] = [];
  const vars = isRecord(config.vars) ? config.vars : {};
  for (const name of Object.keys(vars).sort()) out.push(`vars.${name}: ${stable(vars[name])}`);
  for (const key of Object.keys(config).sort()) {
    if (key === "vars" || key === "migrations" || IGNORED.has(key)) continue;
    const v = config[key];
    if (typeof v === "object" && v !== null) out.push(`${key}: ${stable(v)}`);
  }
  return out;
}
