import { describe, expect, it } from 'vitest';

import { isoOf, readHabitMonth, todayCell, type TaskEntry } from './month';

/** A month's worth of generated rows, as `habitDays` in Basalt writes them. */
function januaryEntries(days = 31, checked: readonly number[] = []): TaskEntry[] {
  const weekdays = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'];
  return Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    return {
      line: 10 + index,
      checked: checked.includes(day),
      text: `2026-01-${String(day).padStart(2, '0')} · ${weekdays[index % 7]}`,
    };
  });
}

describe('readHabitMonth', () => {
  it('reads a generated month as a calendar', () => {
    const month = readHabitMonth(januaryEntries(31, [1, 5]));

    expect(month?.year).toBe(2026);
    expect(month?.month).toBe(0);
    expect(month?.days).toHaveLength(31);
    expect(month?.days[0]).toEqual({ line: 10, day: 1, checked: true });
  });

  // January 2026 opens on a Thursday, which is the fourth Monday-first column.
  it('places the 1st under its real weekday', () => {
    expect(readHabitMonth(januaryEntries())?.offset).toBe(3);
  });

  // The offset describes the 1st, not the first line present — a month trimmed by hand in Obsidian
  // must still line its days up under the right weekdays.
  it('offsets from the 1st even when the file starts partway into the month', () => {
    const trimmed = januaryEntries().slice(2);
    const month = readHabitMonth(trimmed);

    expect(month?.offset).toBe(3);
    expect(month?.days[0]?.day).toBe(3);
  });

  it('reads a short February as a whole month', () => {
    const february: TaskEntry[] = Array.from({ length: 28 }, (_, index) => ({
      line: index,
      checked: false,
      text: `2025-02-${String(index + 1).padStart(2, '0')} · Sat`,
    }));

    expect(readHabitMonth(february)?.days).toHaveLength(28);
  });

  it('accepts a day whose weekday suffix was deleted', () => {
    const entries = januaryEntries();
    entries[0] = { line: 10, checked: false, text: '2026-01-01' };

    expect(readHabitMonth(entries)).not.toBeNull();
  });

  it('carries a null line through as an unplaceable day', () => {
    const entries = januaryEntries();
    entries[4] = { ...entries[4]!, line: null };

    expect(readHabitMonth(entries)?.days[4]?.line).toBeNull();
  });

  // The whole point of the threshold: an ordinary to-do list must keep looking like one.
  it('refuses a short list, however well dated', () => {
    expect(readHabitMonth(januaryEntries(27))).toBeNull();
  });

  it('refuses a list carrying a plain item among the days', () => {
    const entries = januaryEntries();
    entries[9] = { line: 19, checked: false, text: '' };

    expect(readHabitMonth(entries)).toBeNull();
  });

  it('refuses a task that merely mentions a date', () => {
    const entries = januaryEntries();
    entries[9] = { line: 19, checked: false, text: 'email Ana about 2026-01-10' };

    expect(readHabitMonth(entries)).toBeNull();
  });

  it('refuses a list that spans two months', () => {
    const entries = januaryEntries();
    entries[30] = { line: 40, checked: false, text: '2026-02-01 · Sun' };

    expect(readHabitMonth(entries)).toBeNull();
  });

  it('refuses the same month in two different years', () => {
    const entries = januaryEntries();
    entries[30] = { line: 40, checked: false, text: '2027-01-31 · Sun' };

    expect(readHabitMonth(entries)).toBeNull();
  });
});

describe('todayCell', () => {
  const month = readHabitMonth(januaryEntries())!;

  it('names the day when today falls in this month', () => {
    expect(todayCell(month, new Date(2026, 0, 14, 9))).toBe(14);
  });

  it('names nothing when today is another month', () => {
    expect(todayCell(month, new Date(2026, 1, 14, 9))).toBeNull();
  });

  it('names nothing for the same month a year later', () => {
    expect(todayCell(month, new Date(2027, 0, 14, 9))).toBeNull();
  });
});

describe('isoOf', () => {
  const month = readHabitMonth(januaryEntries())!;

  it('zero-pads to the spelling the file uses', () => {
    expect(isoOf(month, 5)).toBe('2026-01-05');
    expect(isoOf(month, 31)).toBe('2026-01-31');
  });
});
