/**
 * The pull read. `GET /compare/{base}...{head}` names exactly which paths moved between two
 * commits, so a pull fetches only those blobs.
 *
 * This is deliberately *not* what Basalt does. The phone downloads the whole zipball on any
 * HEAD change, which is the right trade when the device may hold no copy at all and the
 * unpack feeds a full reindex. The desktop already holds the vault, so re-downloading it to
 * learn that one note changed would be pure waste.
 */

import { call, type GitHubContext } from './client';

export type ChangedFile = {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  /** The blob sha at `head`, or null when the file was removed. */
  sha: string | null;
  /** Set only for renames — the path the file occupied at `base`. */
  previousPath: string | null;
};

/**
 * Paths that differ between two commits.
 *
 * GitHub pages this at 300 files and reports the true count in `total_commits`/`files`; a
 * `truncated` view would make us miss changes silently, so callers that get fewer files
 * than `totalFiles` must fall back to a full tree diff rather than trusting the partial list.
 */
export async function compareCommits(
  ctx: GitHubContext,
  base: string,
  head: string,
): Promise<{ files: ChangedFile[]; totalFiles: number }> {
  const json = await call<{
    files?: { filename: string; status: string; sha?: string; previous_filename?: string }[];
  }>(ctx, `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);

  const files = (json.files ?? []).map((file) => ({
    path: file.filename,
    status: file.status as ChangedFile['status'],
    // A removed file still carries the sha of the blob it *was*; we want "absent".
    sha: file.status === 'removed' ? null : (file.sha ?? null),
    previousPath: file.previous_filename ?? null,
  }));

  return { files, totalFiles: files.length };
}

/** A blob's bytes. Returns base64 — the caller decides whether to decode it as text. */
export async function readBlob(ctx: GitHubContext, sha: string): Promise<string> {
  const json = await call<{ content: string; encoding: string }>(ctx, `/git/blobs/${sha}`);
  if (json.encoding !== 'base64') {
    throw new Error(`Unexpected blob encoding "${json.encoding}" for ${sha}.`);
  }
  // GitHub wraps its base64 at 60 columns with '\n'; strip the wrapping before any decode.
  return json.content.replace(/\s+/g, '');
}
