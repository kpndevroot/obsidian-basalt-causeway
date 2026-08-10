/**
 * When it is worth trying again.
 *
 * The error taxonomy already tells the two apart precisely — `RateLimitError` even carries the
 * moment GitHub says the budget refills — and until now nothing acted on it. A rate-limited poller
 * that keeps polling is not merely wasteful: every refused request still counts against some
 * limits, so the naive loop is capable of holding its own door shut.
 *
 * Pure, and takes its clock as an argument. No timers, no state of its own — the caller owns a
 * single "not before" instant and asks this what to set it to.
 */

import { OfflineError, RateLimitError } from '../github/errors';

/**
 * How long to wait after losing the network.
 *
 * `OfflineError` means the request never left the machine, which usually resolves on its own and
 * without warning, so this is short — long enough to stop a tight retry loop, short enough that a
 * laptop coming back from sleep syncs promptly.
 */
const OFFLINE_BACKOFF_MS = 60_000;

/**
 * The ceiling on a rate-limit wait.
 *
 * `resetAt` comes from a response header, so it is remote input: a wrong clock on either end — or a
 * header we misparsed — could otherwise park syncing for days with nothing in the UI to explain it.
 * An hour is longer than any real primary-rate-limit window and short enough to recover from.
 */
const MAX_BACKOFF_MS = 60 * 60_000;

/**
 * The instant automatic syncing may resume, or `null` when this failure says nothing about timing.
 *
 * `null` is the common answer and the important one. A bad token, a protected branch, a repo that
 * does not exist — none of those are *temporary*, and pausing on them would convert a problem the
 * user can see and fix into a plugin that has quietly stopped working. Only the two genuinely
 * time-based failures pause anything; everything else keeps its normal schedule and keeps
 * reporting itself.
 */
export function retryAfter(err: unknown, now: number): number | null {
  if (err instanceof RateLimitError) {
    // A reset already in the past — a skewed clock, most likely — must not resolve to "go now",
    // or the caller retries immediately into the same wall.
    const until = err.resetAt ? err.resetAt.getTime() : now + OFFLINE_BACKOFF_MS;
    return Math.min(Math.max(until, now + OFFLINE_BACKOFF_MS), now + MAX_BACKOFF_MS);
  }

  if (err instanceof OfflineError) return now + OFFLINE_BACKOFF_MS;

  return null;
}

/** Whether automatic syncing is currently parked. Manual syncs ignore this by design. */
export function isPaused(pausedUntil: number, now: number): boolean {
  return pausedUntil > now;
}
