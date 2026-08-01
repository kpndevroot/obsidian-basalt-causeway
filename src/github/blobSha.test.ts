import { describe, expect, it } from 'vitest';

import { gitBlobSha } from './blobSha';

describe('gitBlobSha', () => {
  // These are `git hash-object` outputs. They are the contract with Basalt: if this file
  // ever stops producing them, every note on both devices reads as permanently diverged.
  it('matches git for the empty blob', () => {
    expect(gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('matches git for a short text blob', () => {
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('matches git for a blob crossing a 512-bit block boundary', () => {
    expect(gitBlobSha('x'.repeat(1000))).toBe('14c7dfdd4258dec5c0e9d2e919bd249bd674be1f');
  });

  it('hashes the byte length, not the character count', () => {
    // 'é' is two UTF-8 bytes, so the git header is `blob 2\0` — a character count would
    // write `blob 1\0` and produce a hash git has never seen.
    expect(gitBlobSha('é')).toBe(gitBlobSha(new Uint8Array([0xc3, 0xa9])));
  });

  it('is NUL-safe', () => {
    const withNul = new Uint8Array([0x61, 0x00, 0x62]);
    expect(gitBlobSha(withNul)).not.toBe(gitBlobSha(new Uint8Array([0x61, 0x62])));
  });
});
