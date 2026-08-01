import { describe, expect, it, vi } from 'vitest';

import { call, type GitHubContext, type HttpRequest, type HttpResponse, type Transport } from './client';
import { AuthError, ConflictError, OfflineError, ScopeError } from './errors';

function context(transport: Transport): GitHubContext {
  return { transport, owner: 'kpndevroot', repo: 'my-vault', token: 'gh-token' };
}

function ok(body: unknown): HttpResponse {
  return { status: 200, headers: {}, text: JSON.stringify(body) };
}

describe('call', () => {
  it('authenticates and pins the API version', async () => {
    const seen: HttpRequest[] = [];
    const transport: Transport = async (req) => {
      seen.push(req);
      return ok({ ok: true });
    };

    await call(context(transport), '/git/ref/heads/main');

    expect(seen[0]!.url).toBe('https://api.github.com/repos/kpndevroot/my-vault/git/ref/heads/main');
    expect(seen[0]!.headers.Authorization).toBe('Bearer gh-token');
    expect(seen[0]!.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('sends no body or content type on a GET', async () => {
    const transport = vi.fn<Transport>(async () => ok({}));
    await call(context(transport), '/git/commits/abc');
    expect(transport.mock.calls[0]![0].body).toBeUndefined();
    expect(transport.mock.calls[0]![0].headers['Content-Type']).toBeUndefined();
  });

  it('serialises a JSON body for a write', async () => {
    const transport = vi.fn<Transport>(async () => ok({ sha: 'new' }));
    await call(context(transport), '/git/trees', { method: 'POST', write: true, body: { base_tree: 'x' } });
    expect(transport.mock.calls[0]![0].body).toBe('{"base_tree":"x"}');
    expect(transport.mock.calls[0]![0].headers['Content-Type']).toBe('application/json');
  });

  it('uses the read taxonomy by default', async () => {
    const transport: Transport = async () => ({ status: 403, headers: {}, text: '{}' });
    await expect(call(context(transport), '/git/ref/heads/main')).rejects.toBeInstanceOf(AuthError);
  });

  it('uses the write taxonomy when asked', async () => {
    const transport: Transport = async () => ({ status: 403, headers: {}, text: '{}' });
    await expect(
      call(context(transport), '/git/trees', { method: 'POST', write: true, body: {} }),
    ).rejects.toBeInstanceOf(ScopeError);
  });

  it('lifts GitHub’s message out of the body', async () => {
    const transport: Transport = async () => ({
      status: 409,
      headers: {},
      text: '{"message":"Update is not a fast forward"}',
    });
    const err = await call(context(transport), '/git/refs/heads/main', {
      method: 'PATCH',
      write: true,
      body: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).detail).toBe('Update is not a fast forward');
  });

  // A request that never left the machine is categorically different from any status code:
  // nothing was written, so the whole sync can be retried unchanged.
  it('maps a transport rejection to offline', async () => {
    const transport: Transport = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(call(context(transport), '/git/ref/heads/main')).rejects.toBeInstanceOf(OfflineError);
  });

  it('tolerates an empty success body', async () => {
    const transport: Transport = async () => ({ status: 204, headers: {}, text: '' });
    await expect(call(context(transport), '/git/refs/heads/main', { method: 'PATCH', write: true })).resolves.toEqual(
      {},
    );
  });
});
