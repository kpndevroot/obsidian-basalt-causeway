import { describe, expect, it } from 'vitest';

import {
  AuthError,
  ConflictError,
  NotFoundError,
  OfflineError,
  RateLimitError,
  ScopeError,
} from '../github/errors';
import { isPaused, retryAfter } from './backoff';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

describe('retryAfter', () => {
  it('waits until GitHub says the budget refills', () => {
    const resetAt = new Date(NOW + 12 * MINUTE);

    expect(retryAfter(new RateLimitError(resetAt), NOW)).toBe(NOW + 12 * MINUTE);
  });

  it('waits a minute when offline', () => {
    expect(retryAfter(new OfflineError(), NOW)).toBe(NOW + MINUTE);
  });

  // A rate limit with no reset header still has to pause, or the poller spends the window
  // hammering an endpoint that is refusing it.
  it('falls back to a minute when a rate limit carries no reset time', () => {
    expect(retryAfter(new RateLimitError(null), NOW)).toBe(NOW + MINUTE);
  });

  // `resetAt` is remote input read through a local clock. A reset "in the past" must not resolve
  // to "retry immediately" — that is the tight loop this module exists to stop.
  it('never resolves a past reset time to now', () => {
    const stale = new Date(NOW - 10 * MINUTE);

    expect(retryAfter(new RateLimitError(stale), NOW)).toBe(NOW + MINUTE);
  });

  it('caps an absurd reset time at an hour', () => {
    const wrong = new Date(NOW + 400 * 24 * 60 * MINUTE);

    expect(retryAfter(new RateLimitError(wrong), NOW)).toBe(NOW + 60 * MINUTE);
  });

  /**
   * The important half. Pausing on a failure the user has to act on would turn a visible problem
   * into a plugin that silently stopped syncing — the failure mode this whole feature could
   * easily have introduced.
   */
  it('does not pause for failures that are not about timing', () => {
    expect(retryAfter(new AuthError(), NOW)).toBeNull();
    expect(retryAfter(new ScopeError(), NOW)).toBeNull();
    expect(retryAfter(new NotFoundError(), NOW)).toBeNull();
    expect(retryAfter(new ConflictError('moved'), NOW)).toBeNull();
    expect(retryAfter(new Error('something else'), NOW)).toBeNull();
    expect(retryAfter('not an error at all', NOW)).toBeNull();
  });
});

describe('isPaused', () => {
  it('is paused up to, but not past, the instant it lifts', () => {
    expect(isPaused(NOW + 1, NOW)).toBe(true);
    expect(isPaused(NOW, NOW)).toBe(false);
    expect(isPaused(NOW - 1, NOW)).toBe(false);
  });

  it('is never paused from a zero default', () => {
    expect(isPaused(0, NOW)).toBe(false);
  });
});
