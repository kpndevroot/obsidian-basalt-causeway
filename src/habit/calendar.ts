/**
 * A month of a habit, drawn as the calendar it is.
 *
 * The note is a plain checklist — thirty-odd `- [ ] 2026-01-05 · Mon` lines — which is right for the
 * *file*: it renders anywhere, GitHub diffs it one line at a time, and ticking a day is one
 * character. But thirty rows is the wrong shape for a *reader*. A habit is a thing you want to see
 * the shape of: which days you kept, where the gap is, how this week compares to last. A calendar
 * says that at a glance and a list never does. Basalt already draws it that way on the phone; this
 * is the same view on the desktop, so a tracker does not look like two different notes.
 *
 * The **reading-view** host. Live Preview is CodeMirror, which runs no post-processors at all, and
 * is served by `liveCalendar.ts` — same classifier, same grid, a different way of finding the block
 * and a different way of writing it back.
 *
 * Nothing here changes the file's shape. The write is still one character on one line.
 */

import { Notice, type App, type MarkdownPostProcessor, type MarkdownPostProcessorContext } from 'obsidian';

import { buildGrid } from './grid';
import { readHabitMonth, type HabitMonth } from './month';
import { readTaskEntries, toggleTaskLine } from './tasks';

/**
 * The post-processor. Takes the enablement as a thunk rather than a boolean, so toggling the
 * setting takes effect on the next render instead of at the next Obsidian restart.
 */
export function habitCalendarProcessor(app: App, enabled: () => boolean): MarkdownPostProcessor {
  return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    if (!enabled()) return;

    // Top-level lists only. A nested `ul` is part of some other document's structure, and its
    // parent list has already failed the date rule by the time we would reach it.
    const lists = Array.from(el.querySelectorAll('ul')).filter((ul) => ul.parentElement === el);
    if (lists.length === 0) return;

    // Null outside a real note — a hover popover, an export, an embed rendered without a section.
    // No section means no line numbers, and a grid whose taps cannot be written is worse than the
    // list it replaced.
    const section = ctx.getSectionInfo(el);
    if (!section || !ctx.sourcePath) return;

    const lines = section.text.split('\n').slice(section.lineStart, section.lineEnd + 1);
    const entries = readTaskEntries(lines, section.lineStart);
    const month = readHabitMonth(entries);
    if (!month) return;

    for (const ul of lists) {
      // The one check that ties the source back to this particular list. If the counts disagree,
      // the block we parsed is not the block being rendered — leave it alone rather than draw a
      // grid whose cells point at lines that belong to something else.
      if (ul.querySelectorAll(':scope > li').length !== entries.length) continue;
      ul.replaceWith(renderMonth(month, app, ctx.sourcePath));
      return;
    }
  };
}

/**
 * The grid, wired to a vault write.
 *
 * `buildGrid` paints the cell before this resolves and reverts it if this rejects, so a refusal has
 * to escape — swallowing it would leave the grid showing a tick the file never took.
 */
function renderMonth(month: HabitMonth, app: App, sourcePath: string): HTMLElement {
  return buildGrid(month, async (day, iso) => {
    // Bound before the closure so the null check narrows it, and the write below needs no cast.
    const line = day.line;
    if (line === null) return;

    try {
      const file = app.vault.getFileByPath(sourcePath);
      if (!file) throw new Error('this note is no longer in the vault');

      // `process` rather than read-then-modify: it is the one form that cannot lose a concurrent
      // edit made between the two halves, and a tracker is exactly the file a sync writes under you.
      let refused = false;
      await app.vault.process(file, (data) => {
        const updated = toggleTaskLine(data, line, iso);
        if (updated === null) {
          refused = true;
          return data;
        }
        return updated;
      });
      if (refused) throw new Error('that line has changed since this note was rendered');
    } catch (err) {
      new Notice(
        `Basalt Causeway: could not tick ${iso} — ${err instanceof Error ? err.message : String(err)}.`,
      );
      throw err;
    }
  });
}
