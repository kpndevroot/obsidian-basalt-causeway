/**
 * The one adapter between Obsidian's HTTP and the pure `github/` layer.
 *
 * Lives here rather than under `github/` so that folder keeps its rule: nothing in it imports
 * `obsidian`, and all of it is testable with a plain function in place of the network.
 *
 * `requestUrl` bypasses CORS and touches no Node API, which is the entire reason the manifest
 * can ship `isDesktopOnly: false`. `throw: false` is deliberate: the default rethrows on 4xx
 * and would collapse "rate limited", "no write scope" and "the ref moved" into one opaque
 * failure, when the whole error taxonomy exists to keep them apart.
 */

import { requestUrl } from 'obsidian';

import type { HttpRequest, HttpResponse, Transport } from './github/client';

export const obsidianTransport: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    ...(req.body === undefined ? {} : { body: req.body }),
    throw: false,
  });
  return { status: res.status, headers: res.headers, text: res.text };
};
