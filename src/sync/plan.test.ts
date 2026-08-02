import { describe, expect, it } from 'vitest';

import { assertNoSecrets, buildPushPlan, type LocalFile } from './plan';

function file(path: string, sha: string, extra: Partial<LocalFile> = {}): LocalFile {
  return { path, sha, size: 100, binary: false, ...extra };
}

const MAX = 25 * 1024 * 1024;

describe('buildPushPlan', () => {
  it('adds a file neither side has seen', () => {
    const plan = buildPushPlan({ local: [file('a.md', 'sha1')], remote: {}, baseline: {}, maxFileBytes: MAX });
    expect(plan.ops).toEqual([{ op: 'add', path: 'a.md', binary: false }]);
    expect(plan.counts).toEqual({ added: 1, changed: 0, deleted: 0 });
  });

  it('modifies a file the remote still holds at the agreed version', () => {
    const plan = buildPushPlan({
      local: [file('a.md', 'new')],
      remote: { 'a.md': 'old' },
      baseline: { 'a.md': 'old' },
      maxFileBytes: MAX,
    });
    expect(plan.ops).toEqual([{ op: 'modify', path: 'a.md', binary: false }]);
  });

  it('writes nothing when the remote already has our bytes', () => {
    const plan = buildPushPlan({
      local: [file('a.md', 'same')],
      remote: { 'a.md': 'same' },
      baseline: { 'a.md': 'old' },
      maxFileBytes: MAX,
    });
    expect(plan.ops).toEqual([]);
  });

  it('deletes a path the baseline says we published and the vault no longer has', () => {
    const plan = buildPushPlan({
      local: [],
      remote: { 'gone.md': 'old' },
      baseline: { 'gone.md': 'old' },
      maxFileBytes: MAX,
    });
    expect(plan.ops).toEqual([{ op: 'delete', path: 'gone.md', binary: false }]);
  });

  // The single most destructive thing this planner could get wrong: a first sync against an
  // existing repo proposing to delete every file the vault does not happen to contain.
  it('never deletes a remote path that was not in the baseline', () => {
    const plan = buildPushPlan({
      local: [file('note.md', 'sha1')],
      remote: { 'README.md': 'r1', '.github/workflows/ci.yml': 'r2' },
      baseline: {},
      maxFileBytes: MAX,
    });
    expect(plan.ops).toEqual([{ op: 'add', path: 'note.md', binary: false }]);
    expect(plan.counts.deleted).toBe(0);
  });

  it('reports a conflict instead of overwriting a remote that moved', () => {
    const plan = buildPushPlan({
      local: [file('a.md', 'local')],
      remote: { 'a.md': 'theirs' },
      baseline: { 'a.md': 'old' },
      maxFileBytes: MAX,
    });
    expect(plan.ops).toEqual([]);
    expect(plan.conflicts).toEqual([{ path: 'a.md', remoteSha: 'theirs', localSha: 'local' }]);
  });

  it('reports a conflict rather than deleting a file they edited after we removed it', () => {
    const plan = buildPushPlan({
      local: [],
      remote: { 'a.md': 'theirs' },
      baseline: { 'a.md': 'old' },
      maxFileBytes: MAX,
    });
    expect(plan.ops).toEqual([]);
    expect(plan.conflicts).toEqual([{ path: 'a.md', remoteSha: 'theirs', localSha: null }]);
  });

  it('skips an oversized file instead of sending a body GitHub will reject', () => {
    const plan = buildPushPlan({
      local: [file('big.mov', 'sha1', { size: 30 * 1024 * 1024, binary: true })],
      remote: {},
      baseline: {},
      maxFileBytes: MAX,
    });
    expect(plan.ops).toEqual([]);
    expect(plan.skipped).toEqual([{ path: 'big.mov', reason: 'too-large', size: 30 * 1024 * 1024 }]);
  });

  it('carries the binary flag through, since binaries need a blob upload first', () => {
    const plan = buildPushPlan({
      local: [file('img.png', 'sha1', { binary: true })],
      remote: {},
      baseline: {},
      maxFileBytes: MAX,
    });
    expect(plan.ops).toEqual([{ op: 'add', path: 'img.png', binary: true }]);
  });

  it('does nothing when a local delete has already reached the remote', () => {
    const plan = buildPushPlan({ local: [], remote: {}, baseline: { 'a.md': 'old' }, maxFileBytes: MAX });
    expect(plan.ops).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it('handles a rename as one delete plus one add in a single plan', () => {
    const plan = buildPushPlan({
      local: [file('new.md', 'sha1')],
      remote: { 'old.md': 'sha1' },
      baseline: { 'old.md': 'sha1' },
      maxFileBytes: MAX,
    });
    expect(plan.ops).toEqual([
      { op: 'add', path: 'new.md', binary: false },
      { op: 'delete', path: 'old.md', binary: false },
    ]);
  });
});

describe('assertNoSecrets', () => {
  it('throws when a plugin config path reaches the tree builder', () => {
    expect(() => assertNoSecrets(['.obsidian/plugins/basalt-causeway/data.json'], '')).toThrow(/never published/);
  });

  it('sees through the subfolder prefix', () => {
    expect(() => assertNoSecrets(['vault/.obsidian/app.json'], 'vault')).toThrow(/never published/);
  });

  it('allows a note whose name merely starts with the same letters', () => {
    expect(() => assertNoSecrets(['.obsidian-notes/tips.md', 'notes/a.md'], '')).not.toThrow();
  });
});
