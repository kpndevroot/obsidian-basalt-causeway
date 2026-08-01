import { DEFAULT_EXCLUDE } from './sync/exclude';

export type BasaltSyncSettings = {
  owner: string;
  repo: string;
  /**
   * Must match the branch the Basalt vault points at. They are independent settings, and a
   * mismatch is a silent no-op where everything looks healthy and nothing ever arrives —
   * which is why the status-bar tooltip always names the configured branch.
   */
  branch: string;
  /** A GitHub PAT with `contents: write`. Stored in plaintext — see `exclude.ts`. */
  token: string;
  autoSync: boolean;
  /** Idle window before an auto push. Pushing per keystroke is a commit storm. */
  settleMs: number;
  /** 0 = never. GitHub cannot push to us, so pulling is a poll or nothing. */
  pullIntervalMs: number;
  exclude: string[];
  /** '' = the vault root maps to the repo root. */
  subfolder: string;
  /** Files larger than this are skipped with a `Notice`; GitHub would reject them anyway. */
  maxFileBytes: number;
};

export const DEFAULT_SETTINGS: BasaltSyncSettings = {
  owner: '',
  repo: '',
  branch: 'main',
  token: '',
  autoSync: false,
  settleMs: 5000,
  pullIntervalMs: 0,
  exclude: [...DEFAULT_EXCLUDE],
  subfolder: '',
  maxFileBytes: 25 * 1024 * 1024,
};

/**
 * What both sides agreed on at the last successful sync: the commit we synced to, and the
 * blob sha of every file as it stood at that moment.
 *
 * This is the `base` leg of the three-way compare, and without it divergence is undetectable
 * — "remote differs from local" alone cannot tell "they changed it" from "I changed it".
 * It is also what makes deletions safe: `plan.ts` only ever deletes a remote path that the
 * baseline says we put there, so a first sync from a fresh vault can never wipe a repo.
 */
export type Baseline = {
  commitSha: string | null;
  /** Repo-relative path → git blob sha. */
  files: Record<string, string>;
};

export const EMPTY_BASELINE: Baseline = { commitSha: null, files: {} };

/** The single `data.json` payload. Settings and baseline share one file, one write. */
export type PersistedData = {
  settings: BasaltSyncSettings;
  baseline: Baseline;
};
