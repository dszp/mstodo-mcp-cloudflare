// The change feed's wire types (docs/SYNC-API.md section 4): what a client
// receives. They import nothing, so a client can type-check against them
// without pulling in the server's runtime or its platform globals.

export type FeedScope = "active" | "all";

export interface FeedStep {
  id: string;
  title: string | null;
  checked: boolean;
  checked_at: string | null;
  created_at: string | null;
  order: string | null;
}
export interface FeedLink {
  id: string;
  url: string | null;
  title: string | null;
  app: string | null;
  external_id: string | null;
}
export interface FeedAttachment {
  id: string;
  name: string | null;
  size: number | null;
  content_type: string | null;
}
export interface FeedTask {
  list_id: string | null;
  title: string;
  status: string;
  body: { type: string; content: string } | null;
  importance: string | null;
  categories: string[];
  due: string | null;
  start: string | null;
  reminder: { on: boolean; at: string | null };
  // A bare date, like due and start: To Do keeps completion at date granularity.
  completed_at: string | null;
  recurrence: unknown;
  created_at: string | null;
  modified_at: string | null;
  order: string | null;
  my_day: { committed_day: string | null; committed_order: string | null; postponed_day: string | null };
  // false until the per-task sub-resource scan has fetched steps, links and
  // attachment details for this task (section 1.1).
  subresources_complete: boolean;
  steps: FeedStep[];
  links: FeedLink[];
  attachments: FeedAttachment[];
}
export interface FeedList {
  name: string | null;
  // The list's sync setting (section 1.2). Excluded lists never appear.
  sync: "todo" | "reference";
  wellknown: string | null;
  is_owner: boolean | null;
  is_shared: boolean | null;
  // The To Do sidebar, read from Substrate (section 10.4); all null until
  // read, and always null on a server without Substrate. group_id is the
  // list_group's sid. sort_key is the sidebar position as Substrate sends it
  // (an ISO date-time string; null for the default list).
  group_id: string | null;
  sort_key: string | null;
  // Theme color and background image, as Substrate sends them (undocumented
  // formats, passed through unchanged).
  theme: { color: string | null; background: string | null };
  // The app's background image for the list (section 4.8): a theme image's
  // id, kept by this server rather than To Do. null when none is set.
  image_id: string | null;
  // How the app shows that image on this list; null for the app's default.
  image_style: ImageStyle | null;
}
export interface FeedListGroup {
  name: string | null;
  sort_key: string | null;
}
// An uploaded theme image (section 4.8). width, height and brightness are as
// the app sent them; the server doesn't decode images.
export interface FeedThemeImage {
  content_type: string;
  size: number;
  width: number;
  height: number;
  brightness: number | null;
  created_at: string;
}
// The smart lists whose themes the app keeps here. Tasks isn't one: it is the
// default list, whose image is that list's own image_id.
export const SMART_LISTS = ["my_day", "important", "planned", "all", "completed"] as const;
export type SmartList = (typeof SMART_LISTS)[number];
// How a picture is shown where it is used (section 4.8): the point kept in
// view when cropped to fill, a zoom, a wash (negative: white, positive: dark)
// and a blur. Per use, so one image can be cropped differently on two lists.
export interface ImageStyle {
  focus_x: number;
  focus_y: number;
  zoom: number;
  shade: number;
  blur: number;
  // The shade in dark mode; null means use `shade`.
  shade_dark: number | null;
  // How opaque task cards are over the background, light mode; null means 1.
  card_opacity: number | null;
  // The same in dark mode; null means use `card_opacity`.
  card_opacity_dark: number | null;
}
export type SmartListTheme = { color: string | null; image_id: string | null; image_style: ImageStyle | null };
export interface FeedAppSettings {
  smart_lists: Record<SmartList, SmartListTheme | null>;
}
export type FeedKind = "task" | "list" | "list_group" | "theme_image" | "app_settings";
export type FeedChange =
  | { kind: "task"; id: string; seq: number; deleted: false; data: FeedTask; field_clock: Record<string, number> }
  | { kind: "list"; id: string; seq: number; deleted: false; data: FeedList }
  | { kind: "list_group"; id: string; seq: number; deleted: false; data: FeedListGroup }
  | { kind: "theme_image"; id: string; seq: number; deleted: false; data: FeedThemeImage }
  | { kind: "app_settings"; id: string; seq: number; deleted: false; data: FeedAppSettings }
  | { kind: FeedKind; id: string; seq: number; deleted: true };

export interface FeedPage {
  cursor: string;
  has_more: boolean;
  changes: FeedChange[];
  backfill: { remaining: number };
}
export type FeedResult =
  | { ok: true; page: FeedPage }
  | { ok: false; error: "cursor_reset" | "cursor_expired" | "bad_cursor" | "bad_scope" };
