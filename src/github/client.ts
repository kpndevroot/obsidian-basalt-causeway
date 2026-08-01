/**
 * The HTTP seam. Nothing under `src/github/` imports `obsidian`, so all of it is testable
 * with a plain object in place of the network — the transport is injected.
 *
 * In the app that transport is `requestUrl()` from the `obsidian` module (see `main.ts`),
 * which bypasses CORS without touching a Node API. That is the whole reason the manifest
 * can ship `isDesktopOnly: false`.
 */

import { errorForResponse, errorForWriteResponse, GitHubError, OfflineError, type Headers } from './errors';

export type HttpRequest = {
  url: string;
  method: 'GET' | 'POST' | 'PATCH';
  headers: Record<string, string>;
  body?: string;
};

export type HttpResponse = {
  status: number;
  headers: Headers;
  text: string;
};

/**
 * Must resolve for any status the server actually returned — including 4xx and 5xx, which
 * this module maps itself — and reject only when the request never left the machine.
 */
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export type GitHubContext = {
  transport: Transport;
  owner: string;
  repo: string;
  token: string;
};

export const GITHUB_API = 'https://api.github.com';

function repoUrl(ctx: GitHubContext, path: string): string {
  return `${GITHUB_API}/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}${path}`;
}

/** GitHub returns `{ "message": "..." }` on failure; best-effort, '' when unreadable. */
function bodyMessage(text: string): string {
  try {
    const json = JSON.parse(text) as { message?: unknown };
    return typeof json.message === 'string' ? json.message : '';
  } catch {
    return '';
  }
}

type CallOptions = {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  /** Use the write taxonomy — a non-rate-limit 403 becomes `ScopeError`, not `AuthError`. */
  write?: boolean;
};

/**
 * One authenticated call against `/repos/{owner}/{repo}`. `path` is appended verbatim, so
 * callers percent-encode their own segments.
 */
export async function call<T>(ctx: GitHubContext, path: string, options: CallOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const req: HttpRequest = {
    url: repoUrl(ctx, path),
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${ctx.token}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  };

  let res: HttpResponse;
  try {
    res = await ctx.transport(req);
  } catch (err) {
    // The request never reached GitHub. Distinct from every status code: nothing was
    // written, so the caller may retry the whole sync unchanged once connectivity returns.
    if (err instanceof GitHubError) throw err;
    throw new OfflineError();
  }

  if (res.status < 200 || res.status >= 300) {
    const message = bodyMessage(res.text);
    throw options.write
      ? errorForWriteResponse(res.status, res.headers, message)
      : errorForResponse(res.status, res.headers, message);
  }

  return (res.text ? JSON.parse(res.text) : {}) as T;
}
