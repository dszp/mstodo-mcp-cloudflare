import { useEffect, useState } from "react";
import type { Loader } from "./loader.ts";
import { msUntilNextDay } from "./model.ts";

/**
 * Today in the server's zone, as YYYY-MM-DD. Changes at midnight there: a
 * timer runs to the next midnight (re-armed on every tick), and the date is
 * checked again whenever the page becomes visible, since timers stall while a
 * device sleeps.
 */
export function useToday(loader: Pick<Loader, "today" | "info">): string {
  const [today, setToday] = useState(() => loader.today());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const zone = () => loader.info()?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tick = () => {
      clearTimeout(timer);
      setToday(loader.today());
      timer = setTimeout(tick, msUntilNextDay(zone(), new Date()));
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loader]);
  return today;
}
