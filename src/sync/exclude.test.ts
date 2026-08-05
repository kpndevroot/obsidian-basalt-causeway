import { describe, expect, it } from 'vitest';

import { compileExclude, defaultExclude } from './exclude';

describe('compileExclude with the defaults', () => {
  const excluded = compileExclude(defaultExclude('.obsidian'));

  // The reason this whole module exists: data.json holds the GitHub token in plaintext and
  // lives inside the vault being published.
  it('excludes the plugin data file holding the token', () => {
    expect(excluded('.obsidian/plugins/basalt-causeway/data.json')).toBe(true);
  });

  it('excludes everything under .obsidian, however deep', () => {
    expect(excluded('.obsidian/app.json')).toBe(true);
    expect(excluded('.obsidian/themes/some/theme.css')).toBe(true);
  });

  it('excludes .trash and .git', () => {
    expect(excluded('.trash/deleted note.md')).toBe(true);
    expect(excluded('.git/config')).toBe(true);
  });

  // A vault can contain another vault. The root-anchored `.obsidian/**` missed the nested copy,
  // and the plugin's own data.json — token included — was published from one.
  it('excludes a config folder nested inside the vault, not just the root one', () => {
    expect(excluded('kpndevroot/.obsidian/plugins/basalt-causeway/data.json')).toBe(true);
    expect(excluded('a/b/c/.obsidian/app.json')).toBe(true);
    expect(excluded('team/notes/.git/config')).toBe(true);
    expect(excluded('archive/.trash/old.md')).toBe(true);
  });

  it('excludes conflict sidecars so they never reach the phone as real notes', () => {
    expect(excluded('notes/Meeting.conflict-a1b2c3d.md')).toBe(true);
  });

  it('matches bare patterns against the basename at any depth', () => {
    expect(excluded('.DS_Store')).toBe(true);
    expect(excluded('deep/nested/folder/.DS_Store')).toBe(true);
    expect(excluded('drafts/scratch.tmp')).toBe(true);
  });

  it('publishes ordinary notes and attachments', () => {
    expect(excluded('Daily/2026-07-30.md')).toBe(false);
    expect(excluded('attachments/diagram.png')).toBe(false);
    // A note that merely mentions the folder name is not in it.
    expect(excluded('notes/obsidian tips.md')).toBe(false);
  });
});

describe('compileExclude patterns', () => {
  it('treats * as not crossing a slash', () => {
    const excluded = compileExclude(['drafts/*.md']);
    expect(excluded('drafts/one.md')).toBe(true);
    expect(excluded('drafts/nested/one.md')).toBe(false);
  });

  it('treats ** as crossing slashes', () => {
    const excluded = compileExclude(['drafts/**']);
    expect(excluded('drafts/nested/deep/one.md')).toBe(true);
  });

  it('escapes regex metacharacters in literal segments', () => {
    const excluded = compileExclude(['notes/a+b.md']);
    expect(excluded('notes/a+b.md')).toBe(true);
    expect(excluded('notes/aab.md')).toBe(false);
  });

  it('ignores blank lines and comments so a hand-edited list cannot exclude everything', () => {
    const excluded = compileExclude(['', '   ', '# a comment', '*.tmp']);
    expect(excluded('note.md')).toBe(false);
    expect(excluded('note.tmp')).toBe(true);
  });
});
