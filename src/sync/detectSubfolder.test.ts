import { describe, expect, it } from 'vitest';

import { describeDetection, detectSubfolder } from './detectSubfolder';

describe('detectSubfolder', () => {
  it('finds the repo root when the vault maps straight onto it', () => {
    const local = ['habits/Creatine.md', 'Plans/a.md', 'index.md'];
    const remote = ['habits/Creatine.md', 'Plans/a.md', 'index.md', 'README.md'];

    const found = detectSubfolder(local, remote);
    expect(found.subfolder).toBe('');
    expect(found.matched).toBe(3);
    expect(found.confident).toBe(true);
  });

  // The real case this exists for: the vault sits under a prefix, the setting said '' , and so
  // pulls mapped `kpndevroot/habits/Creatine.md` onto a note that does not exist.
  it('finds the prefix when the vault lives under a folder in the repo', () => {
    const local = ['habits/Creatine.md', 'habits/Fish oil intake.md', 'Plans/a.md', 'index.md'];
    const remote = [
      'sync.sh',
      'kpndevroot/habits/Creatine.md',
      'kpndevroot/habits/Fish oil intake.md',
      'kpndevroot/Plans/a.md',
      'kpndevroot/index.md',
    ];

    const found = detectSubfolder(local, remote);
    expect(found.subfolder).toBe('kpndevroot');
    expect(found.matched).toBe(4);
    expect(found.confident).toBe(true);
  });

  it('handles a prefix more than one segment deep', () => {
    const local = ['a.md', 'b.md', 'notes/c.md'];
    const remote = ['vaults/personal/a.md', 'vaults/personal/b.md', 'vaults/personal/notes/c.md'];

    expect(detectSubfolder(local, remote).subfolder).toBe('vaults/personal');
  });

  // Guards the tie-break. Both prefixes explain the tree equally well, and picking the deeper one
  // would bury the vault a level further down on every future push.
  it('prefers the repo root when a nested prefix explains the tree equally well', () => {
    const local = ['a.md'];
    const remote = ['a.md', 'copy/a.md'];

    expect(detectSubfolder(local, remote).subfolder).toBe('');
  });

  it('reports no confidence when two prefixes are close', () => {
    const local = ['a.md', 'b.md', 'c.md', 'd.md'];
    const remote = ['one/a.md', 'one/b.md', 'one/c.md', 'two/a.md', 'two/b.md'];

    const found = detectSubfolder(local, remote);
    expect(found.subfolder).toBe('one');
    expect(found.runnerUp?.subfolder).toBe('two');
    expect(found.confident).toBe(false);
  });

  // Refusing to answer is a real outcome: a fresh repo has nothing to match against, and
  // guessing a prefix there would move a correctly-configured vault for no reason.
  it('finds nothing in an empty repo', () => {
    const found = detectSubfolder(['a.md', 'b.md'], []);
    expect(found.matched).toBe(0);
    expect(found.confident).toBe(false);
    expect(describeDetection(found)).toMatch(/No matching notes/);
  });

  it('finds nothing when the repo holds an unrelated project', () => {
    const found = detectSubfolder(['a.md', 'b.md'], ['src/index.ts', 'package.json']);
    expect(found.matched).toBe(0);
    expect(found.confident).toBe(false);
  });

  // A vault of one or two notes cannot clear MIN_MATCHES, so it has to match in full instead —
  // otherwise a brand-new vault could never be detected at all.
  it('accepts a tiny vault only when every note matches', () => {
    expect(detectSubfolder(['only.md'], ['vault/only.md']).confident).toBe(true);

    const partial = detectSubfolder(['a.md', 'b.md'], ['vault/a.md']);
    expect(partial.subfolder).toBe('vault');
    expect(partial.confident).toBe(false);
  });

  it('is not fooled by a filename that coincides deeper in the tree', () => {
    const local = ['index.md'];
    const remote = ['index.md', 'a/b/c/d/e/f/g/h/i/index.md'];

    expect(detectSubfolder(local, remote).subfolder).toBe('');
  });

  it('describes a confident result with its evidence', () => {
    const found = detectSubfolder(['a.md', 'b.md', 'c.md'], ['v/a.md', 'v/b.md', 'v/c.md']);
    expect(describeDetection(found)).toBe('Vault found at "v" (3 of 3 notes matched).');
  });
});
