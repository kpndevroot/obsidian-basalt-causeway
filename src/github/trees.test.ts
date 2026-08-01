import { describe, expect, it, vi } from 'vitest';

import type { GitHubContext, HttpResponse, Transport } from './client';
import { createTree, readHead, readTree, updateRef } from './trees';

function context(responses: Record<string, unknown>): { ctx: GitHubContext; transport: ReturnType<typeof vi.fn> } {
  const transport = vi.fn(async (req: { url: string }): Promise<HttpResponse> => {
    const key = Object.keys(responses).find((suffix) => req.url.endsWith(suffix));
    if (!key) throw new Error(`no stub for ${req.url}`);
    return { status: 200, headers: {}, text: JSON.stringify(responses[key]) };
  });
  return {
    ctx: { transport: transport as unknown as Transport, owner: 'o', repo: 'r', token: 't' },
    transport,
  };
}

describe('readHead', () => {
  it('resolves the branch to a commit and its tree', async () => {
    const { ctx } = context({
      '/git/ref/heads/main': { object: { sha: 'commit1' } },
      '/git/commits/commit1': { tree: { sha: 'tree1' } },
    });
    await expect(readHead(ctx, 'main')).resolves.toEqual({ commitSha: 'commit1', treeSha: 'tree1' });
  });

  it('encodes each segment of a slashed branch name without eating the slash', async () => {
    const { ctx, transport } = context({
      'heads/feature/my%20branch': { object: { sha: 'c' } },
      '/git/commits/c': { tree: { sha: 't' } },
    });
    await readHead(ctx, 'feature/my branch');
    expect(transport.mock.calls[0]![0].url).toContain('/git/ref/heads/feature/my%20branch');
  });
});

describe('readTree', () => {
  it('flattens to blobs and drops directory entries', async () => {
    const { ctx } = context({
      '/git/trees/tree1?recursive=1': {
        tree: [
          { path: 'notes', type: 'tree', sha: 'dir' },
          { path: 'notes/a.md', type: 'blob', sha: 'blob1', size: 12 },
        ],
      },
    });
    const tree = await readTree(ctx, 'tree1');
    expect(tree.files).toEqual([{ path: 'notes/a.md', sha: 'blob1', size: 12 }]);
    expect(tree.truncated).toBe(false);
  });

  // A truncated listing is indistinguishable from a repo that lost thousands of files, and
  // the planner would answer that with thousands of deletions. The flag must survive.
  it('surfaces truncation rather than silently returning a partial repo', async () => {
    const { ctx } = context({ '/git/trees/t?recursive=1': { tree: [], truncated: true } });
    await expect(readTree(ctx, 't')).resolves.toMatchObject({ truncated: true });
  });
});

describe('createTree', () => {
  it('layers on the base tree so unchanged files need not be listed', async () => {
    const { ctx, transport } = context({ '/git/trees': { sha: 'newtree' } });
    await createTree(ctx, 'basetree', [
      { path: 'a.md', mode: '100644', type: 'blob', content: 'hello' },
      { path: 'gone.md', mode: '100644', type: 'blob', sha: null },
    ]);

    const body = JSON.parse(transport.mock.calls[0]![0].body as string) as {
      base_tree: string;
      tree: { path: string; content?: string; sha?: string | null }[];
    };
    expect(body.base_tree).toBe('basetree');
    expect(body.tree[0]).toMatchObject({ path: 'a.md', content: 'hello' });
    // `sha: null` is the Trees API's only way to express a deletion — it must survive
    // JSON.stringify rather than being dropped as an absent key.
    expect(body.tree[1]).toMatchObject({ path: 'gone.md', sha: null });
  });
});

describe('updateRef', () => {
  it('never force-pushes, so a concurrent push fails loudly instead of being discarded', async () => {
    const { ctx, transport } = context({ '/git/refs/heads/main': {} });
    await updateRef(ctx, 'main', 'commit2');

    const body = JSON.parse(transport.mock.calls[0]![0].body as string) as Record<string, unknown>;
    expect(body).toEqual({ sha: 'commit2' });
    expect(body.force).toBeUndefined();
    expect(transport.mock.calls[0]![0].method).toBe('PATCH');
  });
});
