/**
 * The commit-message convention, deliberately parallel to Basalt's `(via Basalt)` suffix in
 * `src/github/commitMessages.ts`. `(via Obsidian)` makes provenance readable in `git log`
 * from either device, and lets a future Basalt build tell "my own push came back" from
 * "the desktop changed something".
 *
 * One message per sync, not per file — the Trees API commits the whole batch at once, which
 * is the point of choosing it.
 */

export type ChangeCounts = {
  added: number;
  changed: number;
  deleted: number;
};

/**
 * `2026-07-30 14:02`, device-local. Hardcoded rather than `Intl`, for the same reason
 * Basalt's `commitTimestamp` is: these strings land in the repo's history and must not vary
 * with the machine's system locale.
 */
export function commitTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `vault: 3 changed, 1 added, 1 deleted (via Obsidian) 2026-07-30 14:02` */
export function pushMessage(counts: ChangeCounts, now: number = Date.now()): string {
  const parts: string[] = [];
  if (counts.changed > 0) parts.push(`${counts.changed} changed`);
  if (counts.added > 0) parts.push(`${counts.added} added`);
  if (counts.deleted > 0) parts.push(`${counts.deleted} deleted`);
  const summary = parts.length > 0 ? parts.join(', ') : 'no changes';
  return `vault: ${summary} (via Obsidian) ${commitTimestamp(now)}`;
}
