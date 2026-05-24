import { z } from "zod";

// Microsoft Graph v1.0 To Do API resource schemas. Read-only surface (Phase 2).
//
// Shape decisions follow the Phase 0.5b empirical findings (see canonical plan
// §Phase 0.5b Findings Appendix), the canonical Graph reference, and the
// project's "evolvable enumeration" hedge:
//
// - `todoTask.body` is `itemBody { content, contentType }` — nested.
// - `todoTask.completedDateTime` (and per docs `dueDateTime`, `reminderDateTime`,
//   `startDateTime`) are `dateTimeTimeZone { dateTime, timeZone }` — nested.
// - `createdDateTime`, `lastModifiedDateTime`, `bodyLastModifiedDateTime` are
//   plain ISO strings (`DateTimeOffset`).
// - `body.contentType`: 0.5b didn't capture values; Graph docs say `text` | `html`.
//   Modeled as `z.string()` to tolerate future values without breaking validation.
// - `wellknownListName`: 0.5b observed `defaultList` + `none`; docs document four
//   members and flag the type as an evolvable enumeration. Widen with `.or(z.string())`.
// - `importance` and `status`: same treatment — Graph docs flag both as evolvable.
// - Attachments are a discriminated union keyed on `@odata.type`. Only
//   `taskFileAttachment` was seen empirically; `taskReferenceAttachment` is
//   modeled permissively for forward-compat per the canonical plan.
//
// All object schemas use `.passthrough()` so that Graph's pervasive `@odata.*`
// annotations (and any future additions) round-trip without being silently
// stripped. The GraphClient (Phase 2 step 3) reads `@odata.etag` off parsed
// objects when it caches conditional-GET responses.

// Graph weak ETag (e.g. `W/"<opaque>"`). Treated as a black-box string.
export const ETagSchema = z.string();

// itemBody — todoTask.body
export const ItemBodySchema = z
  .object({
    content: z.string().nullable().optional(),
    contentType: z.string(),
  })
  .passthrough();
export type ItemBody = z.infer<typeof ItemBodySchema>;

// dateTimeTimeZone — completedDateTime, dueDateTime, reminderDateTime, startDateTime
export const DateTimeTimeZoneSchema = z
  .object({
    dateTime: z.string(),
    timeZone: z.string(),
  })
  .passthrough();
export type DateTimeTimeZone = z.infer<typeof DateTimeTimeZoneSchema>;

// patternedRecurrence — todoTask.recurrence
export const RecurrencePatternSchema = z
  .object({
    type: z.string(),
    interval: z.number().int(),
    month: z.number().int().optional(),
    dayOfMonth: z.number().int().optional(),
    daysOfWeek: z.array(z.string()).optional(),
    firstDayOfWeek: z.string().optional(),
    index: z.string().optional(),
  })
  .passthrough();
export type RecurrencePattern = z.infer<typeof RecurrencePatternSchema>;

export const RecurrenceRangeSchema = z
  .object({
    type: z.string(),
    startDate: z.string(),
    endDate: z.string().optional(),
    numberOfOccurrences: z.number().int().optional(),
    recurrenceTimeZone: z.string().optional(),
  })
  .passthrough();
export type RecurrenceRange = z.infer<typeof RecurrenceRangeSchema>;

export const PatternedRecurrenceSchema = z
  .object({
    pattern: RecurrencePatternSchema,
    range: RecurrenceRangeSchema,
  })
  .passthrough();
export type PatternedRecurrence = z.infer<typeof PatternedRecurrenceSchema>;

// todoTaskList
export const WellknownListNameSchema = z
  .enum(["none", "defaultList", "flaggedEmails", "unknownFutureValue"])
  .or(z.string());
export type WellknownListName = z.infer<typeof WellknownListNameSchema>;

export const TodoTaskListSchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    isOwner: z.boolean().optional(),
    isShared: z.boolean().optional(),
    wellknownListName: WellknownListNameSchema.optional(),
    "@odata.etag": ETagSchema.optional(),
  })
  .passthrough();
export type TodoTaskList = z.infer<typeof TodoTaskListSchema>;

// checklistItem
export const ChecklistItemSchema = z
  .object({
    id: z.string(),
    displayName: z.string().optional(),
    isChecked: z.boolean().optional(),
    createdDateTime: z.string().optional(),
    // null when not checked, ISO string when checked
    checkedDateTime: z.string().nullable().optional(),
  })
  .passthrough();
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

// linkedResource — webUrl may be absent for native-app sources per the Graph
// docs ("Some linkedResource objects are not associated with any web URLs").
export const LinkedResourceSchema = z
  .object({
    id: z.string(),
    applicationName: z.string().optional(),
    displayName: z.string().optional(),
    externalId: z.string().nullable().optional(),
    webUrl: z.string().nullable().optional(),
  })
  .passthrough();
export type LinkedResource = z.infer<typeof LinkedResourceSchema>;

// Attachments — discriminated union on `@odata.type`.
// `contentBytes` is only present on $value GETs of an individual taskFileAttachment;
// list responses omit it.
export const TaskFileAttachmentSchema = z
  .object({
    "@odata.type": z.literal("#microsoft.graph.taskFileAttachment"),
    id: z.string(),
    name: z.string().optional(),
    contentType: z.string().nullable().optional(),
    size: z.number().int().optional(),
    lastModifiedDateTime: z.string().optional(),
    contentBytes: z.string().optional(),
  })
  .passthrough();
export type TaskFileAttachment = z.infer<typeof TaskFileAttachmentSchema>;

// taskReferenceAttachment was not observed in Phase 0.5b probes; shape modeled
// from the attachmentBase inherited surface only. Phase 3 should tighten when a
// real sample is available.
export const TaskReferenceAttachmentSchema = z
  .object({
    "@odata.type": z.literal("#microsoft.graph.taskReferenceAttachment"),
    id: z.string(),
    name: z.string().optional(),
    contentType: z.string().nullable().optional(),
    size: z.number().int().optional(),
    lastModifiedDateTime: z.string().optional(),
  })
  .passthrough();
export type TaskReferenceAttachment = z.infer<typeof TaskReferenceAttachmentSchema>;

export const AttachmentSchema = z.discriminatedUnion("@odata.type", [
  TaskFileAttachmentSchema,
  TaskReferenceAttachmentSchema,
]);
export type Attachment = z.infer<typeof AttachmentSchema>;

// todoTask
export const ImportanceSchema = z.enum(["low", "normal", "high"]).or(z.string());
export type Importance = z.infer<typeof ImportanceSchema>;

export const TaskStatusSchema = z
  .enum(["notStarted", "inProgress", "completed", "waitingOnOthers", "deferred"])
  .or(z.string());
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TodoTaskSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    body: ItemBodySchema.optional(),
    bodyLastModifiedDateTime: z.string().optional(),
    categories: z.array(z.string()).optional(),
    status: TaskStatusSchema.optional(),
    importance: ImportanceSchema.optional(),
    isReminderOn: z.boolean().optional(),
    hasAttachments: z.boolean().optional(),
    createdDateTime: z.string().optional(),
    lastModifiedDateTime: z.string().optional(),
    completedDateTime: DateTimeTimeZoneSchema.nullable().optional(),
    dueDateTime: DateTimeTimeZoneSchema.nullable().optional(),
    reminderDateTime: DateTimeTimeZoneSchema.nullable().optional(),
    startDateTime: DateTimeTimeZoneSchema.nullable().optional(),
    recurrence: PatternedRecurrenceSchema.nullable().optional(),
    // Inline expansions via $expand=checklistItems,linkedResources,attachments
    checklistItems: z.array(ChecklistItemSchema).optional(),
    linkedResources: z.array(LinkedResourceSchema).optional(),
    attachments: z.array(AttachmentSchema).optional(),
    "@odata.etag": ETagSchema.optional(),
  })
  .passthrough();
export type TodoTask = z.infer<typeof TodoTaskSchema>;
