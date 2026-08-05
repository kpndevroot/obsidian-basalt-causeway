/**
 * Work out where in the repo this vault already lives.
 *
 * `subfolder` is the one setting a user cannot reasonably be expected to know. It is not a
 * preference — there is exactly one right answer, it is already written into the repo, and
 * getting it wrong is silent and destructive in both directions: pushes land beside the real
 * tree instead of in it, and pulls map incoming paths onto notes that do not exist, so remote
 * edits materialise as a phantom folder rather than reaching the note they belong to. Asking
 * the user to supply it is the plugin declining to read something it can read.
 *
 * Detection is by **content agreement**, not by looking for a marker file. An earlier idea —
 * find `<x>/.obsidian/` in the tree and take `<x>` — reads a folder we now refuse to publish
 * at all, so it would work only on repos that predate that guard. Matching real note paths
 * works on any repo, including one that was never published by this plugin.
 *
 * Pure, so the whole decision is testable without a network or a vault.
 */

export type SubfolderCandidate = {
  /** '' means the vault root maps to the repo root. */
  subfolder: string;
  /** How many local paths exist under this prefix in the remote tree. */
  matched: number;
};

export type SubfolderDetection = {
  subfolder: string;
  matched: number;
  /** How many local paths were considered at all. */
  total: number;
  /** The next-best prefix, for explaining an ambiguous result. */
  runnerUp: SubfolderCandidate | null;
  /**
   * Whether to act on this without asking. A weak signal is worse than none: silently moving a
   * correctly-configured vault to the wrong prefix would republish it in the wrong place.
   */
  confident: boolean;
};

/**
 * Paths deeper than this contribute nothing but noise — a vault nested eight levels inside a
 * repo is not a real layout, and every extra level multiplies the candidate prefixes.
 */
const MAX_PREFIX_DEPTH = 8;

/** At least this many agreeing paths before a non-obvious answer is trusted. */
const MIN_MATCHES = 3;

/** The winner must beat the runner-up by this factor, or the answer is ambiguous. */
const MARGIN = 2;

/**
 * Score every prefix that could explain the remote tree, and return the best.
 *
 * Walks the *remote* side and asks "does some suffix of this path exist locally?", rather than
 * testing every local path against every candidate prefix. Each remote path yields at most one
 * suffix per segment, so this stays linear in the tree rather than quadratic in vault size.
 */
export function detectSubfolder(localPaths: string[], remotePaths: string[]): SubfolderDetection {
  const local = new Set(localPaths);
  const tally = new Map<string, number>();

  for (const remotePath of remotePaths) {
    const segments = remotePath.split('/');
    // `i` is how many leading segments form the prefix; the rest must match a local path. Stops
    // at the last segment, because a prefix that swallows the filename cannot match anything.
    const limit = Math.min(segments.length - 1, MAX_PREFIX_DEPTH);
    for (let i = 0; i <= limit; i += 1) {
      const suffix = segments.slice(i).join('/');
      if (!local.has(suffix)) continue;
      const prefix = segments.slice(0, i).join('/');
      tally.set(prefix, (tally.get(prefix) ?? 0) + 1);
    }
  }

  const ranked: SubfolderCandidate[] = [...tally.entries()]
    .map(([subfolder, matched]) => ({ subfolder, matched }))
    // Most agreement first; on a tie prefer the shallower prefix, and prefer the repo root over
    // any equally-good nesting — the simpler layout is the likelier one.
    .sort((a, b) => b.matched - a.matched || a.subfolder.length - b.subfolder.length);

  const best = ranked[0] ?? { subfolder: '', matched: 0 };
  const runnerUp = ranked[1] ?? null;

  // A vault smaller than MIN_MATCHES can still be detected, but then it has to match *entirely*.
  const enough = best.matched >= Math.min(MIN_MATCHES, localPaths.length) && best.matched > 0;
  const decisive = runnerUp === null || best.matched >= runnerUp.matched * MARGIN;

  return {
    subfolder: best.subfolder,
    matched: best.matched,
    total: localPaths.length,
    runnerUp,
    confident: enough && decisive,
  };
}

/** One line for a `Notice`, saying what was found and on what evidence. */
export function describeDetection(detection: SubfolderDetection): string {
  const where = detection.subfolder === '' ? 'the repo root' : `"${detection.subfolder}"`;
  if (detection.matched === 0) {
    return 'No matching notes found in the repo — leaving the subfolder unchanged.';
  }
  const base = `Vault found at ${where} (${detection.matched} of ${detection.total} notes matched)`;
  if (detection.confident) return `${base}.`;
  const runner =
    detection.runnerUp === null
      ? ''
      : ` — "${detection.runnerUp.subfolder || '(repo root)'}" matched ${detection.runnerUp.matched}`;
  return `${base}, but the match is not clear-cut${runner}. Check it before syncing.`;
}
