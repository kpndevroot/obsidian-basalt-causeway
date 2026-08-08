/**
 * The checklist as the *file* has it — read from source lines, never from the rendered list.
 *
 * A post-processor is handed HTML, so scraping the `<li>`s is the obvious move and the wrong one.
 * By then Obsidian has already resolved wikilinks, stripped the marker and rewritten the text, and
 * — fatally — the DOM carries no reliable line number, which is the one thing the write needs. The
 * section info the post-processor also receives (`getSectionInfo`) hands back the raw text and the
 * line the block starts at, and every day's absolute line falls out of that by counting.
 *
 * So the DOM is used for exactly one thing: deciding *where* to put the grid. Everything the grid
 * says, and everything the tap writes, comes from the source.
 *
 * Pure. No DOM, no `obsidian` import.
 */

import type { TaskEntry } from './month';

/**
 * A top-level list item: up to three spaces of indent, a bullet, then the rest.
 *
 * Three because that is CommonMark's limit before a line stops being a list item — and capping it
 * there is what makes a *nested* item fail to match, which is what we want. A tracker is a flat
 * list; a list with sub-items under a day is some other document, and matching loosely would let it
 * through as a poisoned entry rather than a rejection.
 */
const ITEM_RE = /^ {0,3}[-*+] {1,4}(.*)$/;

/** The checkbox, once the bullet is off: `[ ] 2026-01-05 · Mon`. */
const TASK_RE = /^\[([ xX])\] +(.*)$/;

/**
 * The same item, split around its marker so a write can find the one character it owns.
 *
 * `[^\n]` rather than `.` for the tail: `.` excludes `\r` as well as `\n`, so on a CRLF file the
 * anchored `$` could never be reached and every write would be refused.
 */
const MARKER_RE = /^( {0,3}[-*+] {1,4}\[)([ xX])(\] +)([^\n]*)$/;

/**
 * Whether a line is a top-level list item at all — the only thing a caller with no sections to go
 * on can use to find where a checklist starts and stops. See `blocks.ts`.
 */
export function isListItemLine(raw: string): boolean {
  return ITEM_RE.test(raw.replace(/\r$/, ''));
}

/**
 * Every line of a block as `(source line, ticked, text)` — the shape `readHabitMonth` needs.
 *
 * Anything that is not a ticked-or-unticked top-level item yields an entry with an empty text,
 * which can never match a date and so rejects the whole block. That is the same trick Basalt's
 * token walker uses: a mixed list is refused by the date rule rather than by a special case here.
 *
 * @param lines The block's own lines, already sliced out of the file.
 * @param lineStart The absolute line number `lines[0]` sits at, so the returned lines are the
 *   file's own and can be handed straight to `toggleTaskLine`.
 */
export function readTaskEntries(lines: readonly string[], lineStart: number): TaskEntry[] {
  const entries: TaskEntry[] = [];

  lines.forEach((raw, offset) => {
    // Blank lines are the section's own padding, not items — counting them would poison every
    // block that happens to end with one.
    if (raw.trim() === '') return;

    const line = lineStart + offset;
    // A CRLF file leaves a `\r` on every line, and `.` does not match one — without this the item
    // pattern fails on all of them and no tracker in such a vault is ever a month. Dropped rather
    // than matched around, because nothing downstream of here writes: the text is read for its date
    // and then discarded. `toggleTaskLine` keeps the `\r`, because that one does write.
    const item = ITEM_RE.exec(raw.replace(/\r$/, ''));
    const task = item ? TASK_RE.exec(item[1] ?? '') : null;

    entries.push({
      line,
      checked: (task?.[1] ?? ' ') !== ' ',
      // Empty for a plain bullet or a stray line — neither can ever look like a day.
      text: task?.[2] ?? '',
    });
  });

  return entries;
}

/**
 * Where in `line` the checkbox character sits, or `null` to refuse the write.
 *
 * `expectDate` is the guard, and it is the reason this takes a date at all rather than just a
 * position. The grid was drawn from a snapshot; between the render and the tap the note may have
 * been edited on the desktop, pulled by a sync, or shifted by a line inserted above. Writing line
 * 47 blind would then tick a different day — a wrong write in a file the user trusts, and one the
 * user would likely never notice. So the line must still *be* the day the cell claims.
 *
 * An offset rather than a rewritten line, because the two hosts need different things from it:
 * reading view rewrites the file's text (`toggleTaskLine`, below), while Live Preview dispatches a
 * one-character change at a document position and must never rewrite anything. Both are then the
 * same rule applied twice, not two rules.
 */
export function taskMarkerOffset(line: string, expectDate: string): number | null {
  const m = MARKER_RE.exec(line);
  if (!m) return null;
  if (!(m[4] ?? '').startsWith(expectDate)) return null;
  return (m[1] ?? '').length;
}

/**
 * Flip one day's checkbox in the whole file's text, or `null` to refuse.
 *
 * Returning `null` rather than throwing keeps this usable inside `Vault#process`, whose callback
 * must hand back a string: the caller returns the input unchanged and reports the refusal.
 *
 * Spliced around the marker rather than rebuilt from the match, so the indent, the bullet, the
 * spacing and the trailing text — including a `\r`, in a file with CRLF endings — come back out
 * exactly as they went in.
 */
export function toggleTaskLine(text: string, line: number, expectDate: string): string | null {
  const lines = text.split('\n');
  const current = lines[line];
  if (current === undefined) return null;

  const at = taskMarkerOffset(current, expectDate);
  if (at === null) return null;

  lines[line] = `${current.slice(0, at)}${current[at] === ' ' ? 'x' : ' '}${current.slice(at + 1)}`;
  return lines.join('\n');
}
