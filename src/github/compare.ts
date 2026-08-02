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

const PER_PAGE = 100;

/** Enough for 3,000 changed files in one range. Past that, refuse rather than guess. */
const MAX_PAGES = 30;

/**
 * Every path that differs between two commits.
 *
 * **Paginated, and it has to stay that way.** GitHub returns the changed-file list a page at a
 * time; an unpaginated call silently stops at the first page. A truncated diff is not a degraded
 * result here, it is a corrupting one: the caller applies what it received and then advances the
 * baseline commit past the entire range, putting every file it never saw permanently outside
 * future compare windows. A remote addition among them would never reach the desktop and never
 * be re-detected either, because the push planner ignores paths that are in neither the baseline
 * nor the vault.
 *
 * So `complete` is reported honestly and the caller refuses to advance on false — replacing a
 * `totalFiles` that was tautologically equal to the length the caller already had, and so could
 * never signal anything.
 */
export async function compareCommits(
  ctx: GitHubContext,
  base: string,
  head: string,
): Promise<{ files: ChangedFile[]; complete: boolean }> {
  const files: ChangedFile[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const json = await call<{
      files?: { filename: string; status: string; sha?: string; previous_filename?: string }[];
    }>(
      ctx,
      `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=${PER_PAGE}&page=${page}`,
    );

    const batch = json.files ?? [];
    for (const file of batch) {
      files.push({
        path: file.filename,
        status: file.status as ChangedFile['status'],
        // A removed file still carries the sha of the blob it *was*; we want "absent".
        sha: file.status === 'removed' ? null : (file.sha ?? null),
        previousPath: file.previous_filename ?? null,
      });
    }

    if (batch.length < PER_PAGE) return { files, complete: true };
  }

  return { files, complete: false };
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
