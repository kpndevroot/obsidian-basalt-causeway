import { describe, expect, it } from 'vitest';

import {
  appendHistory,
  isNoOp,
  summarizeEntry,
  trimChanges,
  type SyncChange,
  type SyncHistoryEntry,
} from './history';

function entry(over: Partial<SyncHistoryEntry> = {}): SyncHistoryEntry {
  return {
    at: 1_000,
    outcome: 'ok',
    pushed: { added: 0, changed: 0, deleted: 0 },
    pulled: { written: 0, deleted: 0 },
    commitSha: null,
    conflicts: 0,
    ...over,
  };
}

describe('appendHistory', () => {
  it('puts the newest run first', () => {
    const first = entry({ at: 1 });
    const second = entry({ at: 2 });
    expect(appendHistory([first], second).map((e) => e.at)).toEqual([2, 1]);
  });

  // data.json is rewritten on every persist and parsed on every load, so an unbounded log would
  // make both slower for the rest of the vault's life.
  it('caps the log and drops the oldest runs', () => {
    let history: SyncHistoryEntry[] = [];
    for (let i = 1; i <= 10; i += 1) history = appendHistory(history, entry({ at: i }), 3);

    expect(history.map((e) => e.at)).toEqual([10, 9, 8]);
  });

  it('does not mutate the array it is given', () => {
    const original = [entry({ at: 1 })];
    appendHistory(original, entry({ at: 2 }));
    expect(original).toHaveLength(1);
  });

  it('keeps nothing when the limit is zero', () => {
    expect(appendHistory([entry()], entry(), 0)).toEqual([]);
  });
});

describe('summarizeEntry', () => {
  it('names both directions when both moved', () => {
    const e = entry({ pushed: { added: 2, changed: 1, deleted: 0 }, pulled: { written: 3, deleted: 1 } });
    expect(summarizeEntry(e)).toBe('Pushed 2 added, 1 changed · Pulled 3 written, 1 deleted');
  });

  it('omits the zero counts rather than printing them', () => {
    const e = entry({ pushed: { added: 0, changed: 0, deleted: 4 } });
    expect(summarizeEntry(e)).toBe('Pushed 4 deleted');
  });

  // The most common outcome, and the one worth distinguishing from a failure at a glance.
  it('says so when a run had nothing to do', () => {
    expect(summarizeEntry(entry())).toBe('Already up to date');
  });

  it('appends the conflict count without hiding what moved', () => {
    const e = entry({ pulled: { written: 1, deleted: 0 }, conflicts: 213 });
    expect(summarizeEntry(e)).toBe('Pulled 1 written · 213 conflict(s)');
  });

  it('reports a failure with its reason instead of counts', () => {
    const e = entry({ outcome: 'error', error: 'Too many files changed on GitHub' });
    expect(summarizeEntry(e)).toBe('Failed — Too many files changed on GitHub');
  });

  it('survives a failure recorded without a reason', () => {
    expect(summarizeEntry(entry({ outcome: 'error' }))).toBe('Failed — unknown error');
  });
});

describe('trimChanges', () => {
  const push = (path: string): SyncChange => ({ direction: 'push', op: 'modify', path });
  const pull = (path: string): SyncChange => ({ direction: 'pull', op: 'modify', path });

  it('keeps everything when the list already fits', () => {
    const changes = [push('a.md'), pull('b.md')];
    expect(trimChanges(changes, 10)).toEqual({ changes, changesTruncated: 0 });
  });

  // A first sync or a post-reset sync moves the whole vault. Recording 200 paths × 50 runs would
  // be megabytes rewritten on every persist to describe a bulk operation nobody reads in detail.
  it('caps the list and reports how many were dropped', () => {
    const changes = Array.from({ length: 25 }, (_, i) => push(`note-${i}.md`));
    const trimmed = trimChanges(changes, 20);

    expect(trimmed.changes).toHaveLength(20);
    expect(trimmed.changesTruncated).toBe(5);
  });

  // A push is what you just did; a pull is what happened to you. If only one survives the cap,
  // the surprising one is the one worth keeping.
  it('keeps pulled paths ahead of pushed ones when trimming', () => {
    const changes = [push('p1.md'), push('p2.md'), pull('incoming.md'), push('p3.md')];
    const trimmed = trimChanges(changes, 2);

    expect(trimmed.changes[0]).toEqual(pull('incoming.md'));
    expect(trimmed.changesTruncated).toBe(2);
  });

  it('does not mutate its input', () => {
    const changes = [push('a.md'), pull('b.md'), push('c.md')];
    trimChanges(changes, 1);
    expect(changes).toHaveLength(3);
    expect(changes[0]).toEqual(push('a.md'));
  });
});

describe('isNoOp', () => {
  it('is true only for a successful run that moved nothing', () => {
    expect(isNoOp(entry())).toBe(true);
    expect(isNoOp(entry({ pushed: { added: 1, changed: 0, deleted: 0 } }))).toBe(false);
    expect(isNoOp(entry({ pulled: { written: 1, deleted: 0 } }))).toBe(false);
    // A failure moved nothing either, but calling it a no-op would hide it.
    expect(isNoOp(entry({ outcome: 'error', error: 'boom' }))).toBe(false);
  });
});
