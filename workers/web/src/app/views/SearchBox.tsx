import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { searchText } from "../model.ts";
import { type Route, navigate, replaceRoute } from "../route.ts";
import { debounce } from "../throttle.ts";
import { SearchIcon } from "./icons.tsx";

/** How long typing pauses before the URL follows, so keystrokes don't each re-run the search. */
const TYPING_PAUSE_MS = 150;
const MY_DAY: Route = { view: "smart", list: "my_day" };

const isTextField = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

/**
 * The search box. The URL holds the query (/search?q=): the first character
 * typed away from a search adds one history entry, later ones replace it
 * after a short pause. Enter runs it now (and `onSubmit` closes the sidebar on
 * a phone); Escape clears the box and goes back to the view the search began
 * from. "/" focuses the box when focus isn't in a text field.
 */
export function SearchBox({ route, onSubmit }: { route: Route; onSubmit: () => void }) {
  const routeQ = route.view === "search" ? route.q : "";
  const [text, setText] = useState(routeQ);
  const input = useRef<HTMLInputElement>(null);
  const routeRef = useRef(route);
  routeRef.current = route;
  // The view the search began from, for Escape.
  const origin = useRef<Route | null>(null);

  const update = useMemo(
    () =>
      debounce((q: string) => {
        const r = routeRef.current;
        // A click elsewhere in the pause means the search is over: drop it.
        if (r.view === "search") replaceRoute({ ...r, q, all: false });
      }, TYPING_PAUSE_MS),
    [],
  );
  useEffect(() => () => update.cancel(), [update]);

  // The box follows the URL (back and forward, a link to a search, leaving
  // search), except while a typed change is still on its way to the URL.
  useEffect(() => {
    if (!update.pending()) setText(routeQ);
  }, [routeQ, update]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || isTextField(e.target)) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onChange = (value: string) => {
    setText(value);
    const r = routeRef.current;
    if (r.view === "search") {
      update(value);
    } else if (searchText(value) !== "") {
      origin.current = r;
      navigate({ view: "search", q: value, all: false, includeCompleted: true });
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      update.flush();
      input.current?.blur();
      onSubmit();
    } else if (e.key === "Escape") {
      e.preventDefault(); // the browser's own clear would fire a second change
      update.cancel();
      setText("");
      if (routeRef.current.view === "search") {
        const back = origin.current ?? MY_DAY;
        origin.current = null;
        navigate(back);
      }
    }
  };

  return (
    <div className="side-search">
      <span className="side-search-icon" aria-hidden="true">
        <SearchIcon />
      </span>
      <input
        ref={input}
        type="search"
        className="search-input"
        placeholder="Search"
        aria-label="Search tasks"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
