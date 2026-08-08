/**
 * Finding the trackers in a document, with no sections to go on.
 *
 * The reading-view path never needs this: Obsidian hands a post-processor one block at a time and
 * `getSectionInfo` says where it starts. CodeMirror has no such notion — a `StateField` sees one
 * flat document and must decide for itself where a checklist begins and ends.
 *
 * So a run is a maximal stretch of *consecutive list-item lines*. That is a slightly different rule
 * from the section the post-processor gets, and deliberately the safer one in both directions: a
 * heading or a paragraph between two months splits them into two runs rather than poisoning one, and
 * each run still has to pass `readHabitMonth` in full — same 28-day floor, same single-month rule,
 * same date pattern. Nothing here can turn a list into a month that the other host would refuse.
 *
 * Pure. No CodeMirror, no DOM.
 */

import { readHabitMonth, type HabitMonth } from './month';
import { isListItemLine, readTaskEntries } from './tasks';

export type HabitBlock = {
  /** 0-based index of the run's first line, into the same array that was passed in. */
  startLine: number;
  /** 0-based index of the run's last line. Inclusive — a block is never empty. */
  endLine: number;
  month: HabitMonth;
};

/**
 * Every run of lines in `lines` that is a whole month, in document order.
 *
 * A year's tracker yields twelve, which is the case worth keeping in mind: this walks the document
 * once per call and a caller may call it on every keystroke, so it stays a regex per line and
 * nothing more. The expensive part of a rebuild is DOM, and that is the widget's `eq` to prevent —
 * not this.
 */
export function findHabitBlocks(lines: readonly string[]): HabitBlock[] {
  const blocks: HabitBlock[] = [];
  let start: number | null = null;

  const close = (end: number) => {
    if (start === null) return;
    const month = readHabitMonth(readTaskEntries(lines.slice(start, end + 1), start));
    if (month) blocks.push({ startLine: start, endLine: end, month });
    start = null;
  };

  lines.forEach((raw, index) => {
    if (isListItemLine(raw)) {
      if (start === null) start = index;
      return;
    }
    close(index - 1);
  });
  close(lines.length - 1);

  return blocks;
}
