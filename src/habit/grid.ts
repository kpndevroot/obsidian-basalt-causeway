/**
 * The month, as DOM. One renderer, two hosts.
 *
 * Reading view reaches this through a markdown post-processor and writes with `Vault#process`;
 * Live Preview reaches it through a CodeMirror widget and writes by dispatching a transaction.
 * Those two write paths have nothing in common and must not be merged — but the *grid* must be the
 * same object in both, or a tracker would look like two different notes depending on which mode you
 * happened to be in. So the write arrives as a callback and everything else lives here.
 *
 * The only DOM in this feature. `calendar.ts` and `liveCalendar.ts` are hosts, not renderers.
 */

import { isoOf, todayCell, type CalendarDay, type HabitMonth } from './month';

/**
 * Apply one day's tick.
 *
 * Rejecting means the write was refused or failed, and the cell reverts — so a host must let its
 * failure escape rather than swallowing it, or the grid keeps showing a tick the file never took.
 */
export type GridToggle = (day: CalendarDay, iso: string) => void | Promise<void>;

/** Monday-first, matching the ISO week the generated dates run against. */
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

export function buildGrid(month: HabitMonth, onToggle?: GridToggle): HTMLElement {
  const root = createDiv({ cls: 'basalt-habit' });

  /**
   * Read once, at build. A note left open across midnight keeps yesterday outlined until something
   * rebuilds the grid — visible only as an outline, never as a wrong write, because a tap writes
   * the day the *cell* owns and not "today".
   */
  const today = todayCell(month, new Date());

  // No month name. A generated tracker carries `## January 2026` as a real heading directly above
  // this, which is what fills the outline pane — printing it again would say the same thing twice.
  // What the heading cannot say is the count, so that is all this row adds.
  const count = root.createDiv({ cls: 'basalt-habit-head' }).createSpan();

  const grid = root.createDiv({ cls: 'basalt-habit-grid' });
  for (const label of WEEKDAYS) grid.createDiv({ cls: 'basalt-habit-weekday', text: label });

  // The leading blanks, as a grid offset rather than as empty elements: the 1st simply starts in
  // its own column and the rows fall out. `offset` is 0-based, CSS columns are 1-based.
  grid.style.setProperty('--basalt-habit-offset', String(month.offset + 1));

  const cells = month.days.map((day, index) => ({
    day,
    checked: day.checked,
    el: grid.createEl('button', {
      cls: index === 0 ? 'basalt-habit-day basalt-habit-first' : 'basalt-habit-day',
      text: String(day.day),
      // The full date, not "5": a year's tracker has twelve 5ths, and a bare day number leaves a
      // screen reader no way to tell January's from July's.
      attr: { type: 'button', role: 'checkbox', 'aria-label': isoOf(month, day.day) },
    }),
  }));

  const paint = (cell: (typeof cells)[number]) => {
    cell.el.toggleClass('is-checked', cell.checked);
    cell.el.setAttribute('aria-checked', String(cell.checked));
  };
  // One function for both, because the count above the grid has to agree with the squares below it,
  // and a second copy of the rule is exactly how those two drift apart.
  const paintCount = () => {
    count.setText(`${cells.filter((cell) => cell.checked).length} / ${cells.length}`);
  };

  for (const cell of cells) {
    if (cell.day.day === today) cell.el.addClass('is-today');
    paint(cell);

    // Drawn and not pressable, rather than hidden: the file says that day exists, and silently
    // dropping it would be a lie. Likewise with no write available at all.
    if (!onToggle || cell.day.line === null) {
      cell.el.disabled = true;
      continue;
    }

    /**
     * Paint first, write second, revert if the write is refused.
     *
     * Optimistic because the alternative is a checkbox that does nothing for as long as the write
     * takes, and this is the only interaction the grid has. In Live Preview the host's write is
     * synchronous and the widget is rebuilt from the new document immediately, so the optimistic
     * paint is replaced by an identical one and nothing flickers; in reading view the round trip
     * through the vault is what this is covering for.
     */
    cell.el.addEventListener('click', () => {
      cell.checked = !cell.checked;
      paint(cell);
      paintCount();

      void Promise.resolve()
        .then(() => onToggle(cell.day, isoOf(month, cell.day.day)))
        .catch(() => {
          cell.checked = !cell.checked;
          paint(cell);
          paintCount();
        });
    });
  }
  paintCount();

  return root;
}
