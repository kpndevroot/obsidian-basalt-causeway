import { describe, expect, it } from 'vitest';

import { readHabitMonth } from './month';
import { isListItemLine, readTaskEntries, taskMarkerOffset, toggleTaskLine } from './tasks';

const BLOCK = [
  '- [ ] 2026-01-01 · Thu',
  '- [x] 2026-01-02 · Fri',
  '- [ ] 2026-01-03 · Sat',
];

describe('readTaskEntries', () => {
  it('numbers every line from where the block starts in the file', () => {
    const entries = readTaskEntries(BLOCK, 12);

    expect(entries.map((entry) => entry.line)).toEqual([12, 13, 14]);
  });

  it('reads the tick and the text with the marker off', () => {
    const entries = readTaskEntries(BLOCK, 0);

    expect(entries[0]).toEqual({ line: 0, checked: false, text: '2026-01-01 · Thu' });
    expect(entries[1]).toEqual({ line: 1, checked: true, text: '2026-01-02 · Fri' });
  });

  it('reads an uppercase tick as ticked', () => {
    expect(readTaskEntries(['- [X] 2026-01-01 · Thu'], 0)[0]?.checked).toBe(true);
  });

  it('accepts the other bullet characters', () => {
    expect(readTaskEntries(['* [ ] 2026-01-01', '+ [ ] 2026-01-02'], 0)).toHaveLength(2);
    expect(readTaskEntries(['* [ ] 2026-01-01'], 0)[0]?.text).toBe('2026-01-01');
  });

  // Blank lines are the section's own padding. Counting them would poison every block that ends
  // with one, which is most of them.
  it('ignores blank lines rather than treating them as items', () => {
    expect(readTaskEntries([...BLOCK, '', '  '], 0)).toHaveLength(3);
  });

  it('gives a plain bullet an empty text, so the date rule rejects the block', () => {
    expect(readTaskEntries(['- just a note'], 0)[0]?.text).toBe('');
  });

  it('gives a line that is not a list item an empty text', () => {
    expect(readTaskEntries(['some prose'], 4)[0]).toEqual({ line: 4, checked: false, text: '' });
  });

  // A tracker is a flat list. A day with sub-items is some other document, and it must fail rather
  // than quietly render as a month.
  it('refuses to read a nested item as a day', () => {
    const nested = readTaskEntries(['- [ ] 2026-01-01 · Thu', '    - [ ] 2026-01-02 · Fri'], 0);

    expect(nested[1]?.text).toBe('');
  });

  it('feeds readHabitMonth a real month end to end', () => {
    const lines = Array.from(
      { length: 31 },
      (_, index) => `- [ ] 2026-01-${String(index + 1).padStart(2, '0')} · Thu`,
    );
    const month = readHabitMonth(readTaskEntries(lines, 7));

    expect(month?.days).toHaveLength(31);
    expect(month?.days[0]?.line).toBe(7);
    expect(month?.days[30]?.line).toBe(37);
  });
});

describe('isListItemLine', () => {
  it('accepts a task, a plain bullet and every bullet character', () => {
    expect(isListItemLine('- [ ] 2026-01-01 · Thu')).toBe(true);
    expect(isListItemLine('- just a note')).toBe(true);
    expect(isListItemLine('* a')).toBe(true);
    expect(isListItemLine('+ a')).toBe(true);
  });

  it('accepts a line still carrying its CRLF return', () => {
    expect(isListItemLine('- [ ] 2026-01-01 · Thu\r')).toBe(true);
  });

  // What ends a run in `blocks.ts` — headings, prose, blanks and nested items all stop it.
  it('rejects anything that is not a top-level item', () => {
    expect(isListItemLine('## January 2026')).toBe(false);
    expect(isListItemLine('some prose')).toBe(false);
    expect(isListItemLine('')).toBe(false);
    expect(isListItemLine('    - [ ] 2026-01-02 · Fri')).toBe(false);
    expect(isListItemLine('1. an ordered item')).toBe(false);
  });
});

describe('taskMarkerOffset', () => {
  it('points at the checkbox character itself', () => {
    const line = '- [ ] 2026-01-01 · Thu';
    const at = taskMarkerOffset(line, '2026-01-01');

    expect(at).toBe(3);
    expect(line[at!]).toBe(' ');
  });

  it('follows the marker when the item is indented or oddly spaced', () => {
    const line = '  *  [x]  2026-01-01 · Thu';

    expect(line[taskMarkerOffset(line, '2026-01-01')!]).toBe('x');
  });

  // The same guard `toggleTaskLine` leans on, and the one the CodeMirror write leans on directly.
  it('refuses a line that is no longer the expected day', () => {
    expect(taskMarkerOffset('- [ ] 2026-01-02 · Fri', '2026-01-01')).toBeNull();
  });

  it('refuses a line that is no longer a task', () => {
    expect(taskMarkerOffset('## January 2026', '2026-01-01')).toBeNull();
  });
});

describe('toggleTaskLine', () => {
  const file = ['# Habit', '', ...BLOCK].join('\n');

  it('ticks an unticked day and leaves every other line alone', () => {
    const updated = toggleTaskLine(file, 2, '2026-01-01');

    expect(updated?.split('\n')[2]).toBe('- [x] 2026-01-01 · Thu');
    expect(updated?.split('\n')[3]).toBe('- [x] 2026-01-02 · Fri');
  });

  it('unticks a ticked day', () => {
    expect(toggleTaskLine(file, 3, '2026-01-02')?.split('\n')[3]).toBe('- [ ] 2026-01-02 · Fri');
  });

  it('keeps the indent, the bullet and the spacing exactly as they were', () => {
    const odd = '  *  [ ]  2026-01-01 · Thu';

    expect(toggleTaskLine(odd, 0, '2026-01-01')).toBe('  *  [x]  2026-01-01 · Thu');
  });

  it('keeps a CRLF line ending intact', () => {
    const crlf = ['- [ ] 2026-01-01 · Thu\r', '- [ ] 2026-01-02 · Fri\r'].join('\n');

    expect(toggleTaskLine(crlf, 0, '2026-01-01')?.split('\n')[0]).toBe('- [x] 2026-01-01 · Thu\r');
  });

  // The guard that makes the write safe. Between the render and the tap the note may have been
  // edited or pulled by a sync; writing the line blind would tick a different day.
  it('refuses a line that is no longer the day the cell was drawn as', () => {
    expect(toggleTaskLine(file, 2, '2026-01-09')).toBeNull();
  });

  it('refuses a line that is no longer a task', () => {
    expect(toggleTaskLine(file, 0, '2026-01-01')).toBeNull();
  });

  it('refuses a line past the end of a file that has shrunk', () => {
    expect(toggleTaskLine(file, 99, '2026-01-01')).toBeNull();
  });
});
