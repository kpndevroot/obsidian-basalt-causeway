/**
 * Reading a dated checklist as a month, so the reader can draw it as a calendar.
 *
 * A near-verbatim port of Basalt's `src/markdown/habitCalendar.ts`, and deliberately so: the two
 * apps must agree to the day about which lists are trackers, or a habit note would be a grid on the
 * phone and a 365-row list on the desktop. Keep them in step — the date pattern and the 28-day
 * threshold are the contract, not an implementation detail. If one side loosens, both do.
 *
 * The note itself stays a plain checklist — `- [ ] 2026-01-05 · Mon`, one line a day, which Obsidian
 * renders as an ordinary list and GitHub diffs one day at a time. This module is *only* about
 * presentation: given the items of one list, decide whether they are a run of dated days in a single
 * month, and if so hand back the shape a grid needs.
 *
 * Pure. No DOM, no `obsidian` import.
 */

/** One entry of a list, as the caller already has it: its source line and whether it is ticked. */
export type TaskEntry = { line: number | null; checked: boolean; text: string };

export type CalendarDay = {
  /** Absolute source line, for the write. Null where the line could not be placed — not tappable. */
  line: number | null;
  /** Day of the month, 1-based. */
  day: number;
  checked: boolean;
};

export type HabitMonth = {
  year: number;
  /** 0-based, as `Date` counts them. */
  month: number;
  /** Monday-based column of the 1st: 0 for a Monday, 6 for a Sunday. The grid's leading blanks. */
  offset: number;
  /** In date order, one per day present. */
  days: CalendarDay[];
};

/**
 * `2026-01-05 · Mon` — the leading date of a generated habit row.
 *
 * Anchored to the start, so an ordinary task that merely *mentions* a date ("- [ ] email Ana about
 * 2026-01-05") is not mistaken for a calendar day. The trailing weekday is optional: a user editing
 * the file may well delete it, and the date alone is enough to place the box.
 */
const DATED_TASK_RE = /^(\d{4})-(\d{2})-(\d{2})(?:\s|$)/;

/**
 * How many dated days a list needs before it counts as a month.
 *
 * February is the shortest month there is, so anything below this cannot be a whole one — and a
 * *partial* month is exactly the case we would rather draw as a list than guess at.
 */
const MIN_DAYS_FOR_A_MONTH = 28;

/**
 * The month a list of task items describes, or `null` if it is not one.
 *
 * Deliberately strict — a list that is *nearly* a calendar is rendered as a list, because the cost
 * of a false positive is an ordinary checklist silently redrawn as a grid the user never asked for:
 *
 *   * every item must be a dated task, and
 *   * they must all fall in the same month, and
 *   * there must be at least `MIN_DAYS_FOR_A_MONTH` of them.
 *
 * The last rule is what keeps a three-item to-do list that happens to start with dates looking like
 * a to-do list. A month is only a month when it is most of one.
 */
export function readHabitMonth(entries: readonly TaskEntry[]): HabitMonth | null {
  if (entries.length < MIN_DAYS_FOR_A_MONTH) return null;

  const days: CalendarDay[] = [];
  let year = -1;
  let month = -1;

  for (const entry of entries) {
    const m = DATED_TASK_RE.exec(entry.text);
    if (!m) return null;

    const entryYear = Number(m[1]);
    const entryMonth = Number(m[2]) - 1;
    const day = Number(m[3]);

    if (year === -1) {
      year = entryYear;
      month = entryMonth;
    } else if (entryYear !== year || entryMonth !== month) {
      return null;
    }

    days.push({ line: entry.line, day, checked: entry.checked });
  }

  // Built from the 1st rather than from the first *listed* day: a file whose January starts at the
  // 3rd — a month the user trimmed by hand — must still put the 3rd under Saturday.
  const first = new Date(year, month, 1, 12);
  const offset = (first.getDay() + 6) % 7;

  return { year, month, offset, days };
}

/**
 * Which cell is today, or `null` when today is in a different month.
 *
 * Takes its clock as an argument so the caller owns the staleness question rather than this module
 * reaching for a global one.
 */
export function todayCell({ year, month }: HabitMonth, now: Date): number | null {
  return now.getFullYear() === year && now.getMonth() === month ? now.getDate() : null;
}

/**
 * `2026-01-05` for one cell.
 *
 * Built from the month's own year and month rather than re-parsed out of the line, so the string the
 * write checks against is the same one the grid drew — see `toggleTaskLine`. Noon again, for the
 * same daylight-saving reason as above.
 */
export function isoOf(month: HabitMonth, day: number): string {
  const date = new Date(month.year, month.month, day, 12);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
