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
    expect(() => assertNoSecrets(['.obsidian/plugins/basalt-causeway/data.json'], '', '.obsidian')).toThrow(/never published/);
  });

  it('sees through the subfolder prefix', () => {
    expect(() => assertNoSecrets(['vault/.obsidian/app.json'], 'vault', '.obsidian')).toThrow(/never published/);
  });

  // The UI normalizes the subfolder, but a hand-edited data.json does not — and an un-normalized
  // "vault/" built the prefix "vault//", which matches nothing, silently turning the last line
  // of defence into a no-op.
  it('normalizes a subfolder with stray slashes before un-mapping', () => {
    expect(() => assertNoSecrets(['vault/.obsidian/app.json'], 'vault/', '.obsidian')).toThrow(/never published/);
    expect(() => assertNoSecrets(['vault/.obsidian/app.json'], '/vault/', '.obsidian')).toThrow(/never published/);
  });

  it('allows a note whose name merely starts with the same letters', () => {
    expect(() => assertNoSecrets(['.obsidian-notes/tips.md', 'notes/a.md'], '', '.obsidian')).not.toThrow();
  });

  // The whole reason this takes `configDir` rather than assuming `.obsidian`. A vault opened
  // with an overridden config folder keeps its token in `<configDir>/plugins/.../data.json`,
  // and the old hardcoded prefix list did not match it — so the last line of defence let the
  // token through on exactly the vaults that had moved it.
  it('guards a renamed config folder, which is where the token actually lives', () => {
    expect(() =>
      assertNoSecrets(['.my-config/plugins/basalt-causeway/data.json'], '', '.my-config'),
    ).toThrow(/never published/);
  });

  // The corollary: `.obsidian` is not magic once the user has moved it. Guarding it anyway
  // would be a rule nobody asked for, quietly refusing to publish a real folder of notes.
  it('does not guard .obsidian when that is not the config folder', () => {
    expect(() => assertNoSecrets(['.obsidian/notes.md'], '', '.my-config')).not.toThrow();
  });

  // Regression, from a real leak. A vault can contain another vault, and the prefix form of this
  // check (`startsWith('.obsidian/')`) only ever guarded the config folder at the vault *root* —
  // so this exact path reached a public repo with a live token in it.
  it('guards a config folder nested inside the vault, not just the one at the root', () => {
    expect(() =>
      assertNoSecrets(['kpndevroot/.obsidian/plugins/basalt-causeway/data.json'], '', '.obsidian'),
    ).toThrow(/never published/);
  });

  it('guards a nested config folder however deep it sits', () => {
    expect(() => assertNoSecrets(['a/b/c/.obsidian/app.json'], '', '.obsidian')).toThrow(
      /never published/,
    );
    expect(() => assertNoSecrets(['team/notes/.git/config'], '', '.obsidian')).toThrow(
      /never published/,
    );
  });

  // The segment match must not degrade into a substring match: these are ordinary notes whose
  // folder names merely contain the forbidden name.
  it('allows folders whose names merely contain the forbidden one', () => {
    expect(() =>
      assertNoSecrets(['notes/.obsidian-backup/a.md', 'my.obsidian/b.md', 'x/github/c.md'], '', '.obsidian'),
    ).not.toThrow();
  });
});
