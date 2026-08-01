import { describe, expect, it } from 'vitest';

import { pushMessage } from './commitMessages';

const NOON = new Date(2026, 6, 30, 14, 2, 0).getTime();

describe('pushMessage', () => {
  it('summarises the whole batch in one message', () => {
    expect(pushMessage({ changed: 3, added: 1, deleted: 1 }, NOON)).toBe(
      'vault: 3 changed, 1 added, 1 deleted (via Obsidian) 2026-07-30 14:02',
    );
  });

  it('omits the categories that are empty', () => {
    expect(pushMessage({ changed: 1, added: 0, deleted: 0 }, NOON)).toBe(
      'vault: 1 changed (via Obsidian) 2026-07-30 14:02',
    );
  });

  // The marker is the contract with Basalt's own `(via Basalt)` suffix: provenance stays
  // readable in `git log` from either device.
  it('always carries the (via Obsidian) marker', () => {
    expect(pushMessage({ changed: 0, added: 0, deleted: 0 }, NOON)).toContain('(via Obsidian)');
  });
});
