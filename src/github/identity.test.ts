import { describe, expect, it, vi } from 'vitest';

import type { Credentials, HttpResponse, Transport } from './client';
import { fetchDefaultBranch, fetchViewer, fetchWritableRepos } from './identity';

function repo(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    full_name: `kpndevroot/${name}`,
    default_branch: 'main',
    private: false,
    pushed_at: '2026-07-30T00:00:00Z',
    owner: { login: 'kpndevroot' },
    permissions: { push: true },
    ...overrides,
  };
}

function credentials(pages: unknown[]): { creds: Credentials; transport: ReturnType<typeof vi.fn> } {
  let call = 0;
  const transport = vi.fn(async (): Promise<HttpResponse> => {
    const body = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return { status: 200, headers: {}, text: JSON.stringify(body) };
  });
  return { creds: { transport: transport as unknown as Transport, token: 't' }, transport };
}

describe('fetchViewer', () => {
  it('names the account behind the token', async () => {
    const { creds, transport } = credentials([{ login: 'kpndevroot', name: 'Mathew' }]);
    await expect(fetchViewer(creds)).resolves.toEqual({ login: 'kpndevroot', name: 'Mathew' });
    expect(transport.mock.calls[0]![0].url).toBe('https://api.github.com/user');
  });

  it('tolerates an account with no display name', async () => {
    const { creds } = credentials([{ login: 'kpndevroot' }]);
    await expect(fetchViewer(creds)).resolves.toEqual({ login: 'kpndevroot', name: null });
  });
});

describe('fetchWritableRepos', () => {
  // A read-only repo is not a publishing target. Offering it turns into a 403 several clicks
  // later, when the user has already committed to it.
  it('omits repositories the token cannot push to', async () => {
    const { creds } = credentials([
      [repo('writable'), repo('readonly', { permissions: { push: false } })],
    ]);

    const { repos } = await fetchWritableRepos(creds);

    expect(repos.map((r) => r.name)).toEqual(['writable']);
  });

  it('omits repositories that report no permissions at all', async () => {
    const { creds } = credentials([[repo('mystery', { permissions: undefined })]]);
    await expect(fetchWritableRepos(creds)).resolves.toMatchObject({ repos: [] });
  });

  it('carries the default branch through, which is the field worth not guessing', async () => {
    const { creds } = credentials([[repo('vault', { default_branch: 'trunk' })]]);
    const { repos } = await fetchWritableRepos(creds);
    expect(repos[0]).toMatchObject({ owner: 'kpndevroot', name: 'vault', defaultBranch: 'trunk' });
  });

  it('stops at a short page without asking for another', async () => {
    const { creds, transport } = credentials([[repo('only')]]);
    const { truncated } = await fetchWritableRepos(creds);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(truncated).toBe(false);
  });

  it('sorts by most recently pushed, so the picker leads with what you use', async () => {
    const { creds, transport } = credentials([[repo('a')]]);
    await fetchWritableRepos(creds);
    expect(transport.mock.calls[0]![0].url).toContain('sort=pushed');
  });

  it('includes org and collaborator repositories, not just your own', async () => {
    const { creds, transport } = credentials([[repo('a')]]);
    await fetchWritableRepos(creds);
    expect(transport.mock.calls[0]![0].url).toContain('affiliation=owner,collaborator,organization_member');
  });

  // A capped list presented as complete is worse than a capped list labelled as such: the user
  // concludes the repo they want does not exist.
  it('reports truncation when it stops before the end', async () => {
    const full = Array.from({ length: 100 }, (_, i) => repo(`r${i}`));
    const { creds, transport } = credentials([full]);

    const { repos, truncated } = await fetchWritableRepos(creds, 2);

    expect(transport).toHaveBeenCalledTimes(2);
    expect(repos).toHaveLength(200);
    expect(truncated).toBe(true);
  });
});

describe('fetchDefaultBranch', () => {
  it('percent-encodes the path segments', async () => {
    const { creds, transport } = credentials([{ default_branch: 'main' }]);
    await fetchDefaultBranch(creds, 'my org', 'my repo');
    expect(transport.mock.calls[0]![0].url).toBe('https://api.github.com/repos/my%20org/my%20repo');
  });
});
