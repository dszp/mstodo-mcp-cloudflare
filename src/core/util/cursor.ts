// Phase 5 — opaque keyset pagination cursor.
//
// query() orders by (modified_at DESC, task_id DESC). The cursor carries the
// last row's sort key so the next page resumes strictly after it (no OFFSET,
// stable under concurrent writes). Encoded as URL-safe base64 of compact JSON;
// values are ASCII (epoch number + Graph task id) so plain btoa/atob suffice.

export interface Cursor {
  modified_at: number | null;
  task_id: string;
}

export function encodeCursor(c: Cursor): string {
  const json = JSON.stringify({ m: c.modified_at, t: c.task_id });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(s: string): Cursor | null {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(b64)) as { m?: unknown; t?: unknown };
    if (
      (typeof parsed.m === "number" || parsed.m === null) &&
      typeof parsed.t === "string"
    ) {
      return { modified_at: parsed.m, task_id: parsed.t };
    }
    return null;
  } catch {
    return null;
  }
}
