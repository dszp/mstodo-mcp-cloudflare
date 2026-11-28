// Attachment downloads. An attachment link is a plain navigation to
// /bff/api/attachments/<id>, which bffFetch's refresh-and-retry can't cover:
// an access token that ran out would end in a failed download. So a click
// checks the session first (refreshing a due token), then starts the download.

import type { SessionClient } from "./session.ts";

/** Starts a download of `href` saved as `name`. */
export type SaveFile = (href: string, name: string) => void;

/**
 * Makes sure the session is usable, then calls `save`. A session that is over
 * downloads nothing (the signed-out flow has run); a check that can't reach
 * the BFF still lets the download try.
 */
export async function openAttachment(
  session: Pick<SessionClient, "ensureFresh">,
  href: string,
  name: string,
  save: SaveFile,
): Promise<void> {
  let ok = true;
  try {
    ok = await session.ensureFresh();
  } catch (e) {
    console.warn("session check before download failed", e);
  }
  if (ok) save(href, name);
}

/** A SaveFile that clicks a detached `<a download>`, as the original link would have. */
export function saveWithAnchor(doc: Document): SaveFile {
  return (href, name) => {
    const a = doc.createElement("a");
    a.href = href;
    a.download = name;
    a.click();
  };
}
