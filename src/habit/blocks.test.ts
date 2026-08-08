import { describe, expect, it } from 'vitest';

import { findHabitBlocks } from './blocks';

/** A month of generated rows, as `habitDays` in Basalt writes them. */
function monthLines(year: number, month: number, days: number): string[] {
  return Array.from(
    { length: days },
    (_, index) =>
      `- [ ] ${year}-${String(month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')} · Thu`,
  );
}

const JANUARY = monthLines(2026, 1, 31);
const FEBRUARY = monthLines(2026, 2, 28);

describe('findHabitBlocks', () => {
  it('finds a month sitting under its heading', () => {
    const doc = ['# Creatine', '', '## January 2026', '', ...JANUARY, ''];
    const blocks = findHabitBlocks(doc);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.startLine).toBe(4);
    expect(blocks[0]?.endLine).toBe(34);
    expect(blocks[0]?.month.days).toHaveLength(31);
  });

  // The case that matters: a year's tracker is twelve of these in one document.
  it('finds every month of a year separately', () => {
    const doc: string[] = ['# Creatine', ''];
    for (let month = 1; month <= 12; month++) {
      doc.push(`## 2026-${month}`, '', ...monthLines(2026, month, 28), '');
    }

    expect(findHabitBlocks(doc)).toHaveLength(12);
  });

  it('reports lines that index straight back into the array it was given', () => {
    const doc = ['prose', ...JANUARY];
    const block = findHabitBlocks(doc)[0];

    expect(doc[block!.startLine]).toBe('- [ ] 2026-01-01 · Thu');
    expect(doc[block!.endLine]).toBe('- [ ] 2026-01-31 · Thu');
  });

  it('carries the source line of each day, offset into the document', () => {
    const block = findHabitBlocks(['# Habit', '', ...JANUARY])[0];

    expect(block?.month.days[0]?.line).toBe(2);
    expect(block?.month.days[30]?.line).toBe(32);
  });

  // A heading between two months splits them rather than poisoning one — which is the one place
  // this rule is kinder than the section the post-processor gets, and safe because each half still
  // has to pass the full month test.
  it('splits two months separated by a heading', () => {
    const doc = [...JANUARY, '', '## February 2026', '', ...FEBRUARY];
    const blocks = findHabitBlocks(doc);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.month.month).toBe(0);
    expect(blocks[1]?.month.month).toBe(1);
  });

  it('splits two months separated only by a blank line', () => {
    expect(findHabitBlocks([...JANUARY, '', ...FEBRUARY])).toHaveLength(2);
  });

  // Two months run together with no separator are one run, and one run cannot be two months.
  it('finds nothing when two months are not separated at all', () => {
    expect(findHabitBlocks([...JANUARY, ...FEBRUARY])).toEqual([]);
  });

  it('finds a month that ends at the last line of the document', () => {
    const blocks = findHabitBlocks(JANUARY);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.endLine).toBe(30);
  });

  it('finds nothing in a document with no lists', () => {
    expect(findHabitBlocks(['# Notes', '', 'Some prose.', ''])).toEqual([]);
  });

  it('finds nothing in an ordinary short checklist', () => {
    expect(findHabitBlocks(['- [ ] milk', '- [x] bread', '- [ ] eggs'])).toEqual([]);
  });

  // The same strictness the post-processor applies, reached by a different route: a plain bullet in
  // the run yields an empty text, which cannot be a date.
  it('refuses a month with a plain bullet among the days', () => {
    const doc = [...JANUARY.slice(0, 10), '- a note to self', ...JANUARY.slice(10)];

    expect(findHabitBlocks(doc)).toEqual([]);
  });

  it('refuses a run that is one day short of a month', () => {
    expect(findHabitBlocks(monthLines(2026, 1, 27))).toEqual([]);
  });

  it('reads a month whose days are already ticked', () => {
    const ticked = JANUARY.map((line, index) =>
      index < 5 ? line.replace('- [ ]', '- [x]') : line,
    );
    const block = findHabitBlocks(ticked)[0];

    expect(block?.month.days.filter((day) => day.checked)).toHaveLength(5);
  });
});
