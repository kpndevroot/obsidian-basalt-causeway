/**
 * The failure taxonomy, kept deliberately identical to Basalt's `src/github/errors.ts`.
 *
 * The vocabulary is the contract: a user who sees "rate limited" on the phone and
 * "rate limited" on the desktop must be able to assume it means the same thing and has the
 * same fix. Do not rename these or soften the messages without changing both codebases.
 *
 * The one structural difference: Obsidian's `requestUrl` hands back a plain header record
 * rather than a `Response`, so the mappers take `(status, headers, bodyMessage)`.
 */

export type Headers = Record<string, string>;

export class GitHubError extends Error {}

/** 401, or a 403 that is not a rate limit. The token is bad, expired, or revoked. */
export class AuthError extends GitHubError {
  constructor(message = 'Access revoked — check your token in Basalt Sync settings.') {
    super(message);
    this.name = 'AuthError';
  }
}

/** 403/429 with `X-RateLimit-Remaining: 0`. Carries the reset time so we can say when. */
export class RateLimitError extends GitHubError {
  constructor(readonly resetAt: Date | null) {
    super('GitHub API rate limit reached.');
    this.name = 'RateLimitError';
  }
}

/** Repo missing, or the token cannot see it. Indistinguishable from GitHub's side. */
export class NotFoundError extends GitHubError {
  constructor(message = 'Repository not found, or this token cannot access it.') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** No connectivity. Never destructive — nothing has been written. */
export class OfflineError extends GitHubError {
  constructor(message = "You're offline.") {
    super(message);
    this.name = 'OfflineError';
  }
}

export class HttpError extends GitHubError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * A write-path 403 that is NOT a rate limit: the token can read but cannot write here — a
 * read-only PAT, a fine-grained token missing `contents:write`, or an archived repo.
 * Crucially this is NOT `AuthError`: the token is fine, so "reconnect" would send the user
 * to fix the wrong thing.
 */
export class ScopeError extends GitHubError {
  constructor(readonly detail?: string) {
    super("This token can't write to the repository.");
    this.name = 'ScopeError';
  }
}

/** Branch protection rejected the write (a 409/422 whose body names a protected branch). */
export class ProtectedBranchError extends GitHubError {
  constructor(readonly detail?: string) {
    super('This branch is protected and rejected the push.');
    this.name = 'ProtectedBranchError';
  }
}

/**
 * A real 409: the ref moved on GitHub since we read it. On the Trees path this is the
 * non-fast-forward `PATCH /git/refs`, and the fix is to recompute from the new HEAD and
 * retry — never to force. Deliberately distinct from `ValidationError` (422), which is a
 * request bug, not a concurrent push.
 */
export class ConflictError extends GitHubError {
  constructor(readonly detail?: string) {
    super('The branch moved on GitHub while we were pushing.');
    this.name = 'ConflictError';
  }
}

/**
 * A 422 that is not branch protection: the request itself is malformed — a bad tree entry,
 * an invalid path, a sha that does not parse. A caller bug to log and report, never a
 * conflict to retry.
 */
export class ValidationError extends GitHubError {
  constructor(readonly detail?: string) {
    super('GitHub rejected the push as invalid.');
    this.name = 'ValidationError';
  }
}

function header(headers: Headers, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function resetHeaderToDate(headers: Headers): Date | null {
  const raw = header(headers, 'x-ratelimit-reset');
  if (!raw) return null;
  const secs = Number(raw);
  return Number.isFinite(secs) ? new Date(secs * 1000) : null;
}

function isProtectedBranchMessage(message: string): boolean {
  return /protected branch|branch protection/i.test(message);
}

/**
 * Map a non-OK **read** response onto the taxonomy.
 *
 * The 403 split matters: GitHub returns 403 both for "you are rate limited" and for
 * "your token lacks the scope". Only the former sets `X-RateLimit-Remaining: 0`.
 */
export function errorForResponse(status: number, headers: Headers, bodyMessage = ''): GitHubError {
  if ((status === 403 || status === 429) && header(headers, 'x-ratelimit-remaining') === '0') {
    return new RateLimitError(resetHeaderToDate(headers));
  }
  if (status === 401 || status === 403) return new AuthError();
  if (status === 404) return new NotFoundError();
  return new HttpError(status, bodyMessage || `GitHub returned ${status}.`);
}

/**
 * Map a non-OK **write** response onto the taxonomy.
 *
 * Separate from `errorForResponse` for one reason: on the read path a 403 that isn't a rate
 * limit means the token is bad. On the write path the very same 403 usually means the token
 * reads fine but lacks write scope — telling that user to reconnect is wrong.
 *
 * The 409/422 split is load-bearing and must not be collapsed:
 *   - 409 = the ref moved under us → `ConflictError`, retry from the new HEAD.
 *   - 422 = the request itself is invalid → `ValidationError`, a caller bug, never retried.
 * Either status can instead name a protected branch, which takes precedence.
 */
export function errorForWriteResponse(status: number, headers: Headers, bodyMessage = ''): GitHubError {
  if ((status === 403 || status === 429) && header(headers, 'x-ratelimit-remaining') === '0') {
    return new RateLimitError(resetHeaderToDate(headers));
  }
  if (status === 401) return new AuthError();
  if (status === 403) return new ScopeError(bodyMessage || undefined);
  if (status === 409) {
    if (isProtectedBranchMessage(bodyMessage)) return new ProtectedBranchError(bodyMessage);
    return new ConflictError(bodyMessage || undefined);
  }
  if (status === 422) {
    if (isProtectedBranchMessage(bodyMessage)) return new ProtectedBranchError(bodyMessage);
    return new ValidationError(bodyMessage || undefined);
  }
  if (status === 404) return new NotFoundError();
  return new HttpError(status, bodyMessage || `GitHub returned ${status}.`);
}

/** A human sentence for any error, for `Notice` and the status bar tooltip. */
export function describeError(err: unknown): string {
  if (err instanceof RateLimitError) {
    const when = err.resetAt ? ` Resets ${err.resetAt.toLocaleTimeString()}.` : '';
    return `${err.message}${when}`;
  }
  if (err instanceof ScopeError || err instanceof ProtectedBranchError || err instanceof ValidationError) {
    return err.detail ? `${err.message} ${err.detail}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
