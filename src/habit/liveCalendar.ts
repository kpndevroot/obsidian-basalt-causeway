/**
 * The same calendar, in Live Preview.
 *
 * Reading view gets its grid from a markdown post-processor (`calendar.ts`). Live Preview is
 * CodeMirror and runs no post-processors at all, so without this the mode most people actually read
 * in shows the raw 365-line checklist while every other mode shows a month. Same classifier, same
 * lens, same DOM — a different host, and nothing else.
 *
 * Three things are genuinely new here, and all three come from the document being *live*:
 *
 *   1. There are no sections, so the runs have to be found (`blocks.ts`).
 *   2. A widget that swallows 31 lines makes them uneditable, so it dissolves when the cursor is
 *      inside it.
 *   3. The write is a transaction, never a file write — see `toggle` at the bottom.
 */

import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { Notice, editorLivePreviewField } from 'obsidian';

import { findHabitBlocks } from './blocks';
import { buildGrid } from './grid';
import { isoOf, type CalendarDay, type HabitMonth } from './month';
import { taskMarkerOffset } from './tasks';

export function habitCalendarExtension(enabled: () => boolean): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => build(state, enabled),

    update(value, tr) {
      // Selection matters as much as the document: moving the cursor into a block is what dissolves
      // it. Everything else — a focus change, a viewport scroll — maps the existing set forward and
      // touches no DOM.
      const modeChanged =
        tr.state.field(editorLivePreviewField, false) !==
        tr.startState.field(editorLivePreviewField, false);
      if (!tr.docChanged && !tr.selection && !modeChanged) return value.map(tr.changes);
      return build(tr.state, enabled);
    },

    provide: (field) => EditorView.decorations.from(field),
  });
}

function build(state: EditorState, enabled: () => boolean): DecorationSet {
  if (!enabled()) return Decoration.none;
  // Source mode is the user asking to see the text. `false` as the default rather than a throw:
  // the field is absent in editors Obsidian has not marked, and a missing answer means "not Live
  // Preview", which is the safe reading.
  if (!state.field(editorLivePreviewField, false)) return Decoration.none;

  const blocks = findHabitBlocks(state.doc.toString().split('\n'));
  if (blocks.length === 0) return Decoration.none;

  const ranges: Range<Decoration>[] = [];
  for (const block of blocks) {
    // A block decoration must span whole lines, so both ends come from the document's own line
    // boundaries. Arithmetic on offsets is how this throws and takes the editor with it.
    // CodeMirror counts lines from 1; `blocks.ts` indexes the array we split, from 0.
    const from = state.doc.line(block.startLine + 1).from;
    const to = state.doc.line(block.endLine + 1).to;
    if (touchesSelection(state, from, to)) continue;

    ranges.push(
      Decoration.replace({ block: true, widget: new HabitWidget(block.month) }).range(from, to),
    );
  }

  return Decoration.set(ranges, true);
}

/**
 * Whether the cursor — or any part of a selection — is inside this block.
 *
 * The reveal has to be scoped to the block's own lines and nothing wider. Too eager and the grid
 * vanishes whenever the cursor is anywhere in the note; too lazy and a day can never be edited by
 * hand. A cursor at `to` is inside (it sits at the end of the last day); a cursor on the following
 * line starts at `to + 1` and is not.
 */
function touchesSelection(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

class HabitWidget extends WidgetType {
  constructor(private readonly month: HabitMonth) {
    super();
  }

  /**
   * Content equality, not identity — and this is what makes the feature usable rather than merely
   * correct. `build` runs on every keystroke and hands back fresh widgets; without this, typing one
   * character anywhere in a year's tracker would tear down and rebuild all twelve grids.
   */
  eq(other: HabitWidget): boolean {
    const a = this.month;
    const b = other.month;
    return (
      a.year === b.year &&
      a.month === b.month &&
      a.offset === b.offset &&
      a.days.length === b.days.length &&
      a.days.every((day, index) => {
        const theirs = b.days[index];
        return theirs !== undefined && day.day === theirs.day && day.checked === theirs.checked;
      })
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const el = buildGrid(this.month, (day) => toggle(view, this.month, day));
    // Without this, pressing a day puts the cursor into the block — which dissolves the grid out
    // from under the click, so the tick appears to do nothing at all.
    el.addEventListener('mousedown', (event) => event.preventDefault());
    return el;
  }

  /** Keep the editor out of the widget's own events, for the same reason. */
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Tick a day by dispatching a one-character change.
 *
 * Emphatically *not* `Vault#process`. Inside CodeMirror the document is the live buffer, and writing
 * the file underneath it races the editor's own state — the edit would arrive back as an external
 * modification and fight whatever the user typed next. A transaction is also what makes undo work
 * the way a user expects: one Cmd+Z, one day.
 *
 * The date guard is `taskMarkerOffset`, the same rule reading view writes through. It matters more
 * here, not less: the document can have moved under a grid that a pending re-render has not caught
 * up with yet.
 */
function toggle(view: EditorView, month: HabitMonth, day: CalendarDay): void {
  if (day.line === null) return;

  const iso = isoOf(month, day.day);
  const line = view.state.doc.line(day.line + 1);
  const at = taskMarkerOffset(line.text, iso);
  if (at === null) {
    new Notice(`Basalt Causeway: could not tick ${iso} — that line has changed.`);
    // Thrown so `buildGrid` reverts the cell it has already painted.
    throw new Error('refused');
  }

  view.dispatch({
    changes: {
      from: line.from + at,
      to: line.from + at + 1,
      insert: line.text[at] === ' ' ? 'x' : ' ',
    },
  });
}
