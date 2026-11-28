// Wires the edit path together, once per page: the outbox sends through the
// BFF's one write route, the store shows what is pending, sign-out drops the
// unsent edits, and refused edits become notices for the UI to show.

import type { Mutation, Op, SendResult } from "../sync/mutation.ts";
import { type Cancel, type Outbox, createOutbox } from "../sync/outbox.ts";
import type { MirrorStore } from "../sync/store.ts";
import { type BffFetch, SignedOutError } from "./api.ts";
import { type Edits, createEdits, defaultListId } from "./edits.ts";
import type { Loader } from "./loader.ts";
import type { SessionClient } from "./session.ts";

/** localStorage key for this browser's client_id (SYNC-API §5.1). Not sensitive. */
export const CLIENT_ID_KEY = "potem.client_id";

/** POST sync/mutations got an answer other than 2xx. */
export class MutationsHttpError extends Error {
  constructor(readonly status: number) {
    super(`sync/mutations answered ${status}`);
    this.name = "MutationsHttpError";
  }
}

// The BFF refuses these before forwarding (400 bad JSON, 403 a missing
// X-Potem or an Origin other than WEB_ORIGIN, 413 over 256 KiB, 415 wrong
// content type), and the server's 400 is a body it can't parse: the same
// request can never succeed, so the outbox splits the batch instead. A 403
// means the deployment is misconfigured; as permanent it surfaces as a notice
// rather than retrying unseen. A timeout (bffFetch's 30 s) is not here: it
// throws a TimeoutError and the outbox retries it.
const PERMANENT = new Set([400, 403, 413, 415]);

/** Posts one batch. Resolves with the §5.3 body; throws on any other answer. */
export async function sendMutations(bff: BffFetch, clientId: string, batch: readonly Mutation[]): Promise<SendResult> {
  const res = await bff("sync/mutations", { method: "POST", body: JSON.stringify({ client_id: clientId, mutations: batch }) });
  if (!res.ok) throw new MutationsHttpError(res.status);
  return (await res.json()) as SendResult;
}

/** An edit the server refused or partly skipped, or that could never be sent. */
export interface Notice {
  id: number;
  op: Op;
  sid: string;
  /**
   * The §5.3 error, the outbox's "refused" / "too_large", the page's
   * "no_default_list", or "superseded" for an applied edit some of whose
   * fields a newer edit had already set.
   */
  error: string;
  /** For "superseded": the fields that weren't kept. */
  fields?: string[];
  /** A refused note's text, so the notice can offer to copy it: the edit is gone, the words needn't be. */
  recoverText?: string;
}

export interface Notices {
  list(): readonly Notice[];
  /** Shows a notice for an edit the page itself couldn't make (e.g. no default list to add to). */
  add(n: Omit<Notice, "id">): void;
  subscribe(fn: () => void): () => void;
  dismiss(id: number): void;
}

export interface Editing {
  outbox: Outbox;
  edits: Edits;
  notices: Notices;
  /** Gives the store today's date again; the app calls it when its today changes (midnight, a wake). */
  refreshContext(): void;
  /** How many edits sign-out dropped unsent; null while signed in. */
  discarded(): number | null;
}

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

export interface EditingDeps {
  bff: BffFetch;
  store: MirrorStore;
  loader: Pick<Loader, "pullAfter" | "today">;
  session: Pick<SessionClient, "onSignedOut">;
  /** localStorage, or null when the browser has none. */
  storage: KeyValueStorage | null;
  random?: () => string;
  now?: () => Date;
  schedule?: (fn: () => void, ms: number) => Cancel;
}

// The stored id, or a new one saved for next time. Storage can throw (blocked
// site data, a full quota); the page then uses an id of its own.
function clientId(storage: KeyValueStorage | null, random: () => string): string {
  try {
    const kept = storage?.getItem(CLIENT_ID_KEY);
    if (kept && kept.startsWith("web-")) return kept;
  } catch {
    /* unreadable: make one */
  }
  const id = `web-${random()}`;
  try {
    storage?.setItem(CLIENT_ID_KEY, id);
  } catch {
    /* unwritable: this page keeps it */
  }
  return id;
}

function createNotices(): Notices {
  let items: readonly Notice[] = [];
  let next = 1;
  const watchers = new Set<() => void>();
  const notify = () => {
    for (const fn of [...watchers]) fn();
  };
  return {
    list: () => items,
    subscribe(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    add(n) {
      items = [...items, { id: next++, ...n }];
      notify();
    },
    dismiss(id) {
      const kept = items.filter((n) => n.id !== id);
      if (kept.length === items.length) return;
      items = kept;
      notify();
    },
  };
}

/**
 * Sends waiting edits as soon as the browser is back online, rather than at
 * the end of a backoff. Returns a function that stops watching.
 */
export function watchOnline(outbox: Pick<Outbox, "flush">, target: EventTarget): () => void {
  const onOnline = () => void outbox.flush();
  target.addEventListener("online", onOnline);
  return () => target.removeEventListener("online", onOnline);
}

/** How long an explicit sign-out waits for unsent edits to go before it signs out anyway. */
export const SIGN_OUT_FLUSH_MS = 3_000;

/**
 * Sends what is unsent, giving up after `ms`: sign-out calls it first, so an
 * edit made just before pressing Sign out isn't lost to the discard. Never
 * rejects.
 */
export function flushWithin(
  outbox: Pick<Outbox, "flush">,
  ms: number = SIGN_OUT_FLUSH_MS,
  schedule: (fn: () => void, ms: number) => Cancel = platformSchedule,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const cancel = schedule(resolve, ms);
    outbox.flush().then(
      () => {
        cancel();
        resolve();
      },
      () => {
        cancel();
        resolve();
      },
    );
  });
}

const platformSchedule = (fn: () => void, ms: number): Cancel => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export function createEditing(deps: EditingDeps): Editing {
  const { bff, store, loader, session } = deps;
  const random = deps.random ?? (() => crypto.randomUUID());
  const id = clientId(deps.storage, random);

  const outbox = createOutbox({
    send: (batch) => sendMutations(bff, id, batch),
    // Not reload(): a pull already in flight may predate the server's write.
    pull: () => loader.pullAfter(),
    now: deps.now ?? (() => new Date()),
    random,
    schedule: deps.schedule ?? platformSchedule,
    isSignedOut: (err) => err instanceof SignedOutError,
    isPermanent: (err) => err instanceof MutationsHttpError && PERMANENT.has(err.status),
  });

  // The store's PendingContext. The default list is kept through a resync's
  // clear(), which empties the lists for a moment.
  let today: string | null = null;
  let defaultList = "";
  const push = () => store.setPending(outbox.pending(), { today: (today = loader.today()), defaultListId: defaultList });
  const refreshContext = () => {
    const nextDefault = defaultListId(store) ?? defaultList;
    if (loader.today() === today && nextDefault === defaultList) return;
    defaultList = nextDefault;
    push();
  };
  defaultList = defaultListId(store) ?? "";
  push();
  outbox.subscribe(push);
  store.subscribe("lists", refreshContext);

  // Registered before the app renders, so the count is set before the
  // signed-out screen reads it. endSession has already cleared and sealed the
  // store, and seal() drops the overlay, so discarding after it shows nothing
  // different on screen.
  let discarded: number | null = null;
  session.onSignedOut(() => {
    discarded = outbox.discard();
  });
  // After sign-out an edit has nowhere to go (the store is sealed and the
  // outbox stopped); queuing it would only miscount what was lost.
  const guarded = { enqueue: (m: Parameters<Outbox["enqueue"]>[0]) => (discarded === null ? outbox.enqueue(m) : null) };

  const notices = createNotices();
  outbox.onRejected((m, r) => {
    const body = m.op === "task.update" ? (m.fields?.["body"] as { content?: unknown } | null | undefined) : undefined;
    const text = typeof body?.content === "string" ? body.content : undefined;
    notices.add({ op: m.op, sid: m.sid, error: r.error, ...(text !== undefined && { recoverText: text }) });
  });
  outbox.onSuperseded((m, fields) => notices.add({ op: m.op, sid: m.sid, error: "superseded", fields }));

  return {
    outbox,
    edits: createEdits(guarded, store, loader, random),
    notices,
    refreshContext,
    discarded: () => discarded,
  };
}
