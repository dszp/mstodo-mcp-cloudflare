import type { MouseEvent, ReactNode } from "react";
import { type Route, formatRoute, navigate } from "../route.ts";

/** A same-page link: a plain click navigates without a reload; a modified click opens a tab as usual. */
export function RouteLink({
  to,
  children,
  className,
  current,
  onNavigate,
}: {
  to: Route;
  children: ReactNode;
  className?: string;
  current?: boolean;
  onNavigate?: () => void;
}) {
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
    onNavigate?.();
  };
  return (
    <a href={formatRoute(to)} onClick={onClick} className={className} aria-current={current ? "page" : undefined}>
      {children}
    </a>
  );
}
