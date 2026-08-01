/**
 * The Git Data (Trees) API — the reason this plugin exists in its chosen shape.
 *
 * A sync is one commit no matter how many files moved, because `POST /git/trees` accepts
 * entries carrying inline `content` instead of a pre-uploaded blob `sha`. That is not a
 * micro-optimisation: Basalt's pull is "HEAD changed → download the entire zipball", so a
 * desktop session that touched thirty notes must produce *one* new HEAD, not thirty.
 *
 * The full push is: `readHead` → (blobs, for binaries only) → `createTree` → `createCommit`
 * → `updateRef`.
 */

import { call, type GitHubContext } from './client';

export type Head = {
  commitSha: string;
  treeSha: string;
};

/** The current tip of `branch`, with the tree it points at. Two calls; the ref alone has no tree. */
export async function readHead(ctx: GitHubContext, branch: string): Promise<Head> {
  const ref = await call<{ object: { sha: string } }>(
    ctx,
    `/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
  );
  const commit = await call<{ tree: { sha: string } }>(ctx, `/git/commits/${ref.object.sha}`);
  return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
}

export type RemoteEntry = {
  path: string;
  sha: string;
  size: number;
};

export type RemoteTree = {
  files: RemoteEntry[];
  /**
   * GitHub caps a recursive tree response. When set, `files` is an incomplete picture of
   * the repo — which would make the planner hallucinate deletions, so the caller must
   * refuse to push rather than proceed on a partial listing.
   */
  truncated: boolean;
};

/** Every blob in the tree, flattened. Directories (`type: 'tree'`) are dropped. */
export async function readTree(ctx: GitHubContext, treeSha: string): Promise<RemoteTree> {
  const json = await call<{
    tree: { path: string; type: string; sha: string; size?: number }[];
    truncated?: boolean;
  }>(ctx, `/git/trees/${treeSha}?recursive=1`);

  return {
    files: json.tree
      .filter((entry) => entry.type === 'blob')
      .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 })),
    truncated: json.truncated === true,
  };
}

/** A binary file's bytes, base64 as GitHub wants them. Text never needs this — it inlines. */
export async function createBlob(ctx: GitHubContext, base64: string): Promise<string> {
  const json = await call<{ sha: string }>(ctx, '/git/blobs', {
    method: 'POST',
    write: true,
    body: { content: base64, encoding: 'base64' },
  });
  return json.sha;
}

/**
 * One tree entry. Exactly one of `content` (inline UTF-8 text) or `sha` is set; `sha: null`
 * is how the Trees API expresses a deletion, and is the only reason `sha` is nullable.
 */
export type TreeEntry = {
  path: string;
  mode: '100644';
  type: 'blob';
  content?: string;
  sha?: string | null;
};

/**
 * A new tree layered on `baseTree`. Only changed entries need to appear — everything else
 * is inherited, which is what keeps a thirty-file sync a single small request.
 */
export async function createTree(
  ctx: GitHubContext,
  baseTree: string,
  entries: TreeEntry[],
): Promise<string> {
  const json = await call<{ sha: string }>(ctx, '/git/trees', {
    method: 'POST',
    write: true,
    body: { base_tree: baseTree, tree: entries },
  });
  return json.sha;
}

export async function createCommit(
  ctx: GitHubContext,
  message: string,
  treeSha: string,
  parentSha: string,
): Promise<string> {
  const json = await call<{ sha: string }>(ctx, '/git/commits', {
    method: 'POST',
    write: true,
    body: { message, tree: treeSha, parents: [parentSha] },
  });
  return json.sha;
}

/**
 * Move the branch to `commitSha`.
 *
 * `force` is omitted on purpose, and must stay omitted. Without it GitHub rejects a
 * non-fast-forward move with a 409 — which `errors.ts` maps to `ConflictError` and the
 * engine answers by recomputing against the new HEAD. Passing `force: true` would turn
 * "someone else pushed while we worked" into "silently discard their commit".
 */
export async function updateRef(ctx: GitHubContext, branch: string, commitSha: string): Promise<void> {
  await call(ctx, `/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PATCH',
    write: true,
    body: { sha: commitSha },
  });
}
