/**
 * A record of what each sync actually did.
 *
 * A sync is mostly invisible: it fires on a timer or a keystroke lull, reports one `Notice` that
 * vanishes in a few seconds, and leaves nothing behind but a commit sha the user never sees. When
 * something is wrong — edits not arriving, a subfolder mapped to the wrong prefix, a run that
 * threw at 3am — there is no way to answer "what has this thing been doing?" after the fact.
 * That question is the whole reason this module exists.
 *
 * Kept in `data.json` beside the baseline, and **bounded**: `data.json` is rewritten on every
 * persist and read on every load, so an unbounded log would make both slower forever. Newest
 * first, so the interesting end is the cheap end to read and the trim is a truncation.
 *
 * Pure — the caller supplies the clock, so the tests are deterministic.
 */

/**
 * One file a sync moved, vault-relative and direction-tagged.
 *
 * Push paths are un-prefixed back to vault-relative before they land here: the repo-relative
 * form differs by the subfolder, and a list mixing the two spellings of the same note is worse
 * than no list.
 */
export type SyncChange = {
  direction: 'push' | 'pull';
  op: 'add' | 'modify' | 'delete';
  path: string;
};

/**
 * Per-run cap on recorded paths. A first sync, or one after a baseline reset, moves the whole
 * vault — 200+ paths × 50 runs would be megabytes rewritten on every persist, to describe a
 * bulk operation whose detail nobody reads. Ordinary syncs move a handful and are unaffected.
 */
export const CHANGE_LIMIT = 20;

export type SyncHistoryEntry = {
  /** Epoch ms, supplied by the caller rather than read here, to keep this module pure. */
  at: number;
  outcome: 'ok' | 'error';
  /** What went to the repo. */
  pushed: { added: number; changed: number; deleted: number };
  /** What was applied to the vault. */
  pulled: { written: number; deleted: number };
  /** The commit this sync created, or null when there was nothing to push. */
  commitSha: string | null;
  /** Unresolved divergences as of this run. */
  conflicts: number;
  /** Set only when `outcome` is 'error'. */
  error?: string;
  /**
   * Which files moved, up to `CHANGE_LIMIT`. Optional so a `data.json` written before this
   * existed still loads, and so the counts above stay the source of truth for *how many* —
   * they are never truncated, and `changes` may be.
   */
  changes?: SyncChange[];
  /** How many paths were dropped by the cap. 0 or absent means the list is complete. */
  changesTruncated?: number;
};

/**
 * How many runs to keep. Enough to cover a few days of ordinary use — long enough that a problem
 * noticed on Monday is still explainable — without letting `data.json` grow without limit.
 */
export const HISTORY_LIMIT = 50;

/**
 * Cap the recorded paths, reporting how many were dropped.
 *
 * Pulls are listed before pushes when trimming: a push is what you just did, a pull is what
 * happened to you. If only one of the two fits, the surprising one is the one worth keeping.
 */
export function trimChanges(
  changes: readonly SyncChange[],
  limit: number = CHANGE_LIMIT,
): { changes: SyncChange[]; changesTruncated: number } {
  if (changes.length <= limit) return { changes: [...changes], changesTruncated: 0 };
  const ordered = [
    ...changes.filter((c) => c.direction === 'pull'),
    ...changes.filter((c) => c.direction === 'push'),
  ];
  return { changes: ordered.slice(0, limit), changesTruncated: changes.length - limit };
}

/** Newest first, capped. Returns a new array; never mutates the one passed in. */
export function appendHistory(
  history: readonly SyncHistoryEntry[],
  entry: SyncHistoryEntry,
  limit: number = HISTORY_LIMIT,
): SyncHistoryEntry[] {
  if (limit <= 0) return [];
  return [entry, ...history].slice(0, limit);
}

/** Did this run move anything at all? Used to tell "worked, nothing to do" from "worked". */
export function isNoOp(entry: SyncHistoryEntry): boolean {
  const { added, changed, deleted } = entry.pushed;
  return (
    entry.outcome === 'ok' &&
    added + changed + deleted === 0 &&
    entry.pulled.written + entry.pulled.deleted === 0
  );
}

/**
 * One line describing a run, without the timestamp — the caller renders that, because how a date
 * should read depends on where it is being shown.
 */
export function summarizeEntry(entry: SyncHistoryEntry): string {
  if (entry.outcome === 'error') return `Failed — ${entry.error ?? 'unknown error'}`;

  const parts: string[] = [];
  const { added, changed, deleted } = entry.pushed;
  if (added + changed + deleted > 0) {
    const detail = [
      added > 0 ? `${added} added` : null,
      changed > 0 ? `${changed} changed` : null,
      deleted > 0 ? `${deleted} deleted` : null,
    ]
      .filter(Boolean)
      .join(', ');
    parts.push(`Pushed ${detail}`);
  }
  if (entry.pulled.written + entry.pulled.deleted > 0) {
    const detail = [
      entry.pulled.written > 0 ? `${entry.pulled.written} written` : null,
      entry.pulled.deleted > 0 ? `${entry.pulled.deleted} deleted` : null,
    ]
      .filter(Boolean)
      .join(', ');
    parts.push(`Pulled ${detail}`);
  }
  if (parts.length === 0) parts.push('Already up to date');
  if (entry.conflicts > 0) parts.push(`${entry.conflicts} conflict(s)`);
  return parts.join(' · ');
}
