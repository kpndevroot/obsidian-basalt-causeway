import { describe, expect, it } from 'vitest';

import { compare, conflictSidecarPath } from './conflict';

describe('compare', () => {
  it('reports mine when the remote already holds our bytes', () => {
    expect(compare('aaa', 'aaa', 'bbb')).toBe('mine');
  });

  it('checks mine before base, so a sync that died after the commit is a no-op on re-run', () => {
    // Local, remote and baseline all agree. If `base` were checked first this would read as
    // "safe to write over" and re-issue a pointless commit every single sync.
    expect(compare('aaa', 'aaa', 'aaa')).toBe('mine');
  });

  it('reports base when the remote still holds what both sides agreed on', () => {
    expect(compare('bbb', 'aaa', 'bbb')).toBe('base');
  });

  it('treats a file absent on both sides as mine, not a mystery', () => {
    expect(compare(null, null, 'bbb')).toBe('mine');
  });

  it('treats a brand-new local file as base — nothing to overwrite', () => {
    expect(compare(null, 'aaa', null)).toBe('base');
  });

  it('treats a local delete of an untouched remote as base', () => {
    expect(compare('bbb', null, 'bbb')).toBe('base');
  });

  it('reports diverged when both sides moved', () => {
    expect(compare('ccc', 'aaa', 'bbb')).toBe('diverged');
  });

  it('reports diverged when we deleted a file they edited', () => {
    expect(compare('ccc', null, 'bbb')).toBe('diverged');
  });
});

/**
 * The same function, called with the vault as the destination. Getting this order backwards
 * silently breaks every incoming file, so it gets its own tests rather than riding on the
 * push cases above.
 */
describe('compare, pulling (destination = the vault)', () => {
  it('treats a brand-new remote file as safe to write', () => {
    // local absent, baseline absent: nobody has overwritten anything.
    expect(compare(null, 'remote', null)).toBe('base');
  });

  it('treats a remote edit to an untouched local file as safe to write', () => {
    expect(compare('agreed', 'remote', 'agreed')).toBe('base');
  });

  it('treats a remote deletion of an untouched local file as safe to apply', () => {
    expect(compare('agreed', null, 'agreed')).toBe('base');
  });

  it('reports mine when the incoming file is the one we just pushed', () => {
    expect(compare('same', 'same', 'older')).toBe('mine');
  });

  it('reports diverged when the local file moved too', () => {
    expect(compare('my edit', 'their edit', 'agreed')).toBe('diverged');
  });
});

describe('conflictSidecarPath', () => {
  it('keeps the extension so the sidecar still opens as a note', () => {
    expect(conflictSidecarPath('notes/Meeting.md', 'a1b2c3d4e5')).toBe('notes/Meeting.conflict-a1b2c3d.md');
  });

  it('appends when the file has no extension', () => {
    expect(conflictSidecarPath('notes/LICENSE', 'a1b2c3d4e5')).toBe('notes/LICENSE.conflict-a1b2c3d');
  });

  it('is not confused by a dot in a folder name', () => {
    expect(conflictSidecarPath('my.folder/note', 'a1b2c3d4e5')).toBe('my.folder/note.conflict-a1b2c3d');
  });
});
