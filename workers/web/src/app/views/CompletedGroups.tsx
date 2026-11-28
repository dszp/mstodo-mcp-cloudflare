import type { TaskRow } from "../model.ts";
import { ChevronIcon } from "./icons.tsx";

type Section = Extract<TaskRow, { kind: "section" }>;

/**
 * A heading between tasks: a group of Completed (Today, a week, a month) with
 * its count, or a list's "Completed" section, which opens and closes.
 */
export function SectionHeading({ section, open, onToggle }: { section: Section; open: boolean; onToggle: () => void }) {
  if (!section.toggle) {
    return (
      <h3 className="section-heading completed-group">
        <span>{section.label}</span>
        <span className="section-count">{section.count}</span>
      </h3>
    );
  }
  return (
    <h3 className="section-heading">
      <button type="button" className="section-toggle" aria-expanded={open} onClick={onToggle}>
        <span className="section-chevron">
          <ChevronIcon />
        </span>
        {section.label} <span className="section-count">{section.count}</span>
      </button>
    </h3>
  );
}

/** The line above Completed's groups: how many tasks it holds. */
export function CompletedSummary({ count }: { count: number }) {
  return <p className="completed-summary">{count === 1 ? "1 completed" : `${count} completed`}</p>;
}
