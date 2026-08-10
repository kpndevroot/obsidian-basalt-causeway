import { beforeEach, describe, expect, it } from 'vitest';

import { clearRequests, failRequest, queueResponse, requestUrlCalls } from './test/obsidian';
import { obsidianTransport } from './transport';

beforeEach(clearRequests);

describe('obsidianTransport', () => {
  it('passes the request through unchanged', async () => {
    queueResponse({ status: 200, text: '{"ok":true}' });

    await obsidianTransport({
      url: 'https://api.github.com/user',
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(requestUrlCalls[0]?.url).toBe('https://api.github.com/user');
    expect(requestUrlCalls[0]?.method).toBe('GET');
    expect(requestUrlCalls[0]?.headers).toEqual({ Authorization: 'Bearer t' });
  });

  /**
   * The single most load-bearing line in the file. `throw: true` — the default — collapses
   * "rate limited", "no write scope" and "the ref moved" into one opaque rejection, and the entire
   * error taxonomy downstream exists to keep those apart.
   */
  it('always asks Obsidian not to throw on error statuses', async () => {
    queueResponse({ status: 403 });
    await obsidianTransport({ url: 'https://api.github.com/user', method: 'GET', headers: {} });

    expect(requestUrlCalls[0]?.throw).toBe(false);
  });

  it('returns a 4xx as a value rather than rejecting', async () => {
    queueResponse({ status: 404, headers: { 'x-ratelimit-remaining': '9' }, text: '{"message":"Not Found"}' });

    const res = await obsidianTransport({
      url: 'https://api.github.com/repos/a/b',
      method: 'GET',
      headers: {},
    });

    expect(res.status).toBe(404);
    expect(res.headers).toEqual({ 'x-ratelimit-remaining': '9' });
    expect(res.text).toBe('{"message":"Not Found"}');
  });

  it('omits the body entirely when there is none', async () => {
    queueResponse({ status: 200 });
    await obsidianTransport({ url: 'https://api.github.com/user', method: 'GET', headers: {} });

    expect('body' in (requestUrlCalls[0] ?? {})).toBe(false);
  });

  it('forwards a body when one is given', async () => {
    queueResponse({ status: 201 });
    await obsidianTransport({
      url: 'https://api.github.com/repos/a/b/git/blobs',
      method: 'POST',
      headers: {},
      body: '{"content":"x"}',
    });

    expect(requestUrlCalls[0]?.body).toBe('{"content":"x"}');
  });

  // A request that never left the machine must reject, so `client.ts` can turn it into
  // `OfflineError` — which is the one failure that guarantees nothing was written.
  it('lets a transport-level failure reject', async () => {
    failRequest(new Error('net::ERR_INTERNET_DISCONNECTED'));

    await expect(
      obsidianTransport({ url: 'https://api.github.com/user', method: 'GET', headers: {} }),
    ).rejects.toThrow('ERR_INTERNET_DISCONNECTED');
  });
});
