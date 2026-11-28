import { linkify } from "../model.ts";

/**
 * Untrusted text as text nodes, with its http:, https: and mailto: URLs as
 * links that open in a new tab and send no referrer. Nothing in the text can
 * become an element or an attribute other than a checked href.
 */
export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((part, i) =>
        part.href === undefined ? (
          part.text
        ) : (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
          </a>
        ),
      )}
    </>
  );
}
