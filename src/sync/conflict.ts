/**
 * The three-way compare, lifted from Basalt's `src/sync/editQueue.ts` so both ends of the
 * loop classify divergence the same way and a user gets one mental model, not two.
 *
 * Sides are git blob shas, or `null` for "the file is absent here". Absent is a real state,
 * not a missing value: a create has no base, a delete has no local side, and both must
 * compare correctly rather than fall through to `diverged`.
 */

export type Freshness =
  | 'mine' // remote already equals local — nothing to do in either direction
  | 'base' // remote still equals the baseline both sides agreed on — safe to write over
  | 'diverged'; // remote is neither — both sides moved

/**
 * `mine` is checked *before* `base`, exactly as `editQueue` does, and the order is
 * load-bearing. After a sync that died between `createCommit` and the local baseline write,
 * a re-run finds a remote that already equals local; answering `mine` makes that re-run a
 * no-op instead of a duplicate commit. Checking `base` first would let an unchanged file
 * (where local === base === remote) read as `base` and re-issue a pointless write.
 *
 * `remote === mine` also covers `null === null`: a file deleted locally and already gone
 * remotely is `mine`, not a diverged mystery.
 */
export function compare(remote: string | null, mine: string | null, base: string | null): Freshness {
  if (remote === mine) return 'mine';
  if (remote === base) return 'base';
  return 'diverged';
}

/**
 * Where a conflicting remote version gets parked. The local file is never touched, so the
 * user's own work is always the one still open in the editor; the remote version arrives as
 * a sibling they can diff and delete.
 *
 * Basalt indexes every `.md` in the repo, so the sidecar is deliberately *not* pushed back —
 * `plan.ts` skips it via the exclude set — or it would land on the phone as a real note.
 */
export function conflictSidecarPath(path: string, commitSha: string): string {
  const shortSha = commitSha.slice(0, 7);
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot <= slash) return `${path}.conflict-${shortSha}`;
  return `${path.slice(0, dot)}.conflict-${shortSha}${path.slice(dot)}`;
}
