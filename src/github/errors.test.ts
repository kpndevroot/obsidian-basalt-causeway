import { describe, expect, it } from 'vitest';

import {
  AuthError,
  ConflictError,
  errorForResponse,
  errorForWriteResponse,
  HttpError,
  NotFoundError,
  ProtectedBranchError,
  RateLimitError,
  ScopeError,
  ValidationError,
} from './errors';

describe('errorForResponse', () => {
  it('splits a rate-limit 403 from a bad-token 403 on the remaining header', () => {
    expect(errorForResponse(403, { 'x-ratelimit-remaining': '0' })).toBeInstanceOf(RateLimitError);
    expect(errorForResponse(403, { 'x-ratelimit-remaining': '4321' })).toBeInstanceOf(AuthError);
  });

  it('carries the reset time so the UI can say when', () => {
    const err = errorForResponse(429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' });
    expect((err as RateLimitError).resetAt).toEqual(new Date(1800000000 * 1000));
  });

  it('reads headers case-insensitively, since requestUrl does not normalise them', () => {
    expect(errorForResponse(403, { 'X-RateLimit-Remaining': '0' })).toBeInstanceOf(RateLimitError);
  });

  it('maps 404 to not found', () => {
    expect(errorForResponse(404, {})).toBeInstanceOf(NotFoundError);
  });

  it('falls back to HttpError with the status', () => {
    const err = errorForResponse(500, {});
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
  });
});

describe('errorForWriteResponse', () => {
  // The whole reason this mapper is separate: on the write path a non-rate-limit 403 means
  // the token reads fine but cannot write, so telling the user to reconnect is wrong.
  it('maps a non-rate-limit 403 to a scope problem, not a bad token', () => {
    const err = errorForWriteResponse(403, {}, 'Resource not accessible by personal access token');
    expect(err).toBeInstanceOf(ScopeError);
    expect(err).not.toBeInstanceOf(AuthError);
  });

  it('still maps 401 to a bad token', () => {
    expect(errorForWriteResponse(401, {})).toBeInstanceOf(AuthError);
  });

  it('keeps 409 and 422 apart — one is retried, the other is a bug', () => {
    expect(errorForWriteResponse(409, {}, 'Update is not a fast forward')).toBeInstanceOf(ConflictError);
    expect(errorForWriteResponse(422, {}, 'Invalid request')).toBeInstanceOf(ValidationError);
  });

  it('lets branch protection take precedence over both', () => {
    expect(errorForWriteResponse(409, {}, 'refusing to update protected branch')).toBeInstanceOf(
      ProtectedBranchError,
    );
    expect(errorForWriteResponse(422, {}, 'branch protection rules')).toBeInstanceOf(ProtectedBranchError);
  });

  it('preserves GitHub’s own wording so an "archived" explanation survives to the UI', () => {
    const err = errorForWriteResponse(403, {}, 'Repository was archived so is read-only.');
    expect((err as ScopeError).detail).toBe('Repository was archived so is read-only.');
  });
});
