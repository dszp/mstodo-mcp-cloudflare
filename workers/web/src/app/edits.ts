// The web client's edits: each action builds one SYNC-API §5.2 mutation (two
// for a task added in My Day) and hands it to the outbox. The outbox sends
// them; the store's overlay shows them until the server answers.
//
// Field shapes are the feed's (§4.2): due as a bare date in the owner's zone,
// reminder as { on, at }, body as { type, content }. Completing sends status
// alone; the server stamps the owner's date (§6).

import type { Mutation } from "../sync/mutation.ts";
import type { Outbox } from "../sync/outbox.ts";
import type { MirrorStore } from "../sync/store.ts";
import type { Loader } from "./loader.ts";
import type { Route } from "./route.ts";

export interface Edits {
  /** Creates a task where `where` shows it (§4.10). Returns its sid, or null for a blank title. */
  addTask(title: string, where: Route): string | null;
  setCompleted(sid: string, done: boolean): void;
  setImportant(sid: string, on: boolean): void;
  /** A blank title does nothing. */
  rename(sid: string, title: string): void;
  /** Throws, sending nothing, unless the task's note is plain text or empty. */
  setNotes(sid: string, text: string): void;
  /** `date` is YYYY-MM-DD in the owner's zone; null clears it. */
  setDue(sid: string, date: string | null): void;
  /** `instant` is UTC ISO 8601; null turns the reminder off. */
  setReminder(sid: string, instant: string | null): void;
  setMyDay(sid: string, on: boolean): void;
  move(sid: string, listId: string): void;
  remove(sid: string): void;
  /** Returns the new step's sid, or null for a blank title. */
  addStep(taskSid: string, title: string): string | null;
  setStepChecked(stepSid: string, on: boolean): void;
  /** A blank title does nothing. */
  renameStep(stepSid: string, title: string): void;
  removeStep(stepSid: string): void;
}

// The outbox, or a wrapper that drops the edit (after sign-out).
type Enqueue = { enqueue(m: Parameters<Outbox["enqueue"]>[0]): unknown };
type Store = Pick<MirrorStore, "task" | "baseTask" | "lists">;

/** The sid of the list whose wellknown is defaultList, or null before the lists load. */
export function defaultListId(store: Pick<MirrorStore, "lists">): string | null {
  return store.lists().find((l) => l.wellknown === "defaultList")?.id ?? null;
}

// Only a text body (or none) is editable. An HTML body (a flagged email, or a
// note formatted in To Do) would lose its formatting if sent back as text, and
// a type this client doesn't know is left alone for the same reason.
const editableBody = (body: { type: string } | null | undefined) => body == null || body.type === "text";

export function createEdits(
  outbox: Enqueue,
  store: Store,
  loader: Pick<Loader, "today">,
  // New task and step sids are made on the device (SYNC-API §2).
  newSid: () => string = () => crypto.randomUUID(),
): Edits {
  const send = (m: Omit<Mutation, "id" | "at">) => void outbox.enqueue(m);
  const update = (sid: string, fields: Record<string, unknown>) => send({ op: "task.update", sid, fields });
  const stepUpdate = (sid: string, fields: Record<string, unknown>) => send({ op: "step.update", sid, fields });

  const defaultList = (): string => {
    const id = defaultListId(store);
    if (id === null) throw new Error("no default list to add the task to");
    return id;
  };

  return {
    addTask(title, where) {
      const t = title.trim();
      if (t === "") return null;
      // §4.10, "A task created here gets".
      const fields: Record<string, unknown> = { list_id: where.view === "list" ? where.id : defaultList(), title: t };
      const smart = where.view === "smart" ? where.list : null;
      if (smart === "important") fields["importance"] = "high";
      if (smart === "planned") fields["due"] = loader.today();
      const sid = newSid();
      send({ op: "task.create", sid, fields });
      if (smart === "my_day") send({ op: "myday.add", sid });
      return sid;
    },

    setCompleted: (sid, done) => update(sid, { status: done ? "completed" : "notStarted" }),

    setImportant: (sid, on) => update(sid, { importance: on ? "high" : "normal" }),

    rename(sid, title) {
      const t = title.trim();
      if (t !== "") update(sid, { title: t });
    },

    setNotes(sid, text) {
      const shown = store.task(sid);
      if (shown === undefined) throw new Error(`no task ${sid} to edit`);
      // Both the shown task and the server's copy: no path may send a body
      // over an HTML note.
      if (!editableBody(shown.body) || !editableBody(store.baseTask(sid)?.body)) {
        throw new Error("this note is HTML; edit it in the app");
      }
      update(sid, { body: { type: "text", content: text } });
    },

    setDue: (sid, date) => update(sid, { due: date }),

    // { on: false, at: null } is the feed's shape for no reminder; the server
    // turns the reminder off and clears its time.
    setReminder: (sid, instant) =>
      update(sid, { reminder: instant === null ? { on: false, at: null } : { on: true, at: instant } }),

    setMyDay: (sid, on) => send({ op: on ? "myday.add" : "myday.remove", sid }),

    move: (sid, listId) => send({ op: "task.move", sid, fields: { list_id: listId } }),

    remove: (sid) => send({ op: "task.delete", sid }),

    addStep(taskSid, title) {
      const t = title.trim();
      if (t === "") return null;
      const sid = newSid();
      send({ op: "step.create", sid, fields: { task_id: taskSid, title: t, checked: false } });
      return sid;
    },

    setStepChecked: (stepSid, on) => stepUpdate(stepSid, { checked: on }),

    renameStep(stepSid, title) {
      const t = title.trim();
      if (t !== "") stepUpdate(stepSid, { title: t });
    },

    removeStep: (stepSid) => send({ op: "step.delete", sid: stepSid }),
  };
}
