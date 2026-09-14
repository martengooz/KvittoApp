/**
 * Retry and backoff for sync.
 *
 * Three separate things, often conflated:
 *
 * 1. **Per-request retry.** A push that fails on a flaky connection should be
 *    tried again within the same sync pass, a few times, quickly.
 * 2. **Per-pass backoff.** When a whole pass fails, the *next* pass should be
 *    scheduled further out — and further still if it keeps failing — so a phone
 *    that has lost its server does not spend its battery rediscovering that
 *    every five minutes.
 * 3. **A circuit breaker.** After enough consecutive failures, stop trying on a
 *    timer at all and wait for something to change: the network coming back,
 *    the user pressing sync, the app being reopened.
 *
 * All three use full jitter — a random point in `[0, delay]` rather than the
 * delay itself. Several devices in a household lose Wi-Fi at the same moment
 * and would otherwise retry in lockstep forever.
 */

import { SyncError } from './client.js';

export interface RetryPolicy {
  /** Attempts per request, including the first. */
  attempts: number;
  /** Delay before the second attempt; doubles thereafter. */
  baseMs: number;
  maxMs: number;
}

export const REQUEST_POLICY: RetryPolicy = { attempts: 3, baseMs: 500, maxMs: 8_000 };

/**
 * Runs `work`, retrying a retryable failure with exponential backoff.
 *
 * Only failures marked retryable are retried: a 401 means the device is
 * unpaired and a 400 means the payload is wrong, and repeating either just
 * turns one clear error into three.
 */
export async function withRetry<T>(
  work: (attempt: number) => Promise<T>,
  options: { policy?: RetryPolicy; signal?: AbortSignal; onRetry?: (attempt: number, delayMs: number, error: unknown) => void } = {},
): Promise<T> {
  const policy = options.policy ?? REQUEST_POLICY;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    if (options.signal?.aborted) throw new SyncError('Synkroniseringen avbröts.');
    try {
      return await work(attempt);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof SyncError ? error.retryable : false;
      if (!retryable || attempt === policy.attempts) throw error;

      const requested = error instanceof SyncError ? error.retryAfterMs : null;
      const delay = requested ?? jitter(backoff(attempt, policy));
      options.onRetry?.(attempt, delay, error);
      await sleep(delay, options.signal);
    }
  }

  throw lastError;
}

/**
 * Tracks consecutive sync failures and says when to try again.
 *
 * Deliberately not a timer of its own: it answers "may I?" and the caller's
 * existing schedule asks. That keeps the breaker honest when the app is
 * suspended for an hour, which on a phone is most of the time.
 */
export class Breaker {
  #failures = 0;
  #openUntil = 0;
  #lastError: string | null = null;

  /** After this many consecutive failures, pause the automatic schedule. */
  static readonly TRIP_AT = 5;
  /** Backoff for the automatic schedule, before jitter. */
  static readonly BASE_MS = 30_000;
  static readonly MAX_MS = 30 * 60_000;

  get failures(): number {
    return this.#failures;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  /** True when the breaker has given up on the timer. */
  get open(): boolean {
    return this.#failures >= Breaker.TRIP_AT;
  }

  /** When the next automatic attempt is allowed, as an epoch ms. */
  get nextAttemptAt(): number {
    return this.#openUntil;
  }

  /**
   * Whether an automatic pass may run now.
   *
   * `force` is what a user pressing "sync" passes: a deliberate request always
   * goes through, breaker or not. That is the whole reason the breaker can
   * afford to be aggressive — there is always a way past it.
   */
  mayRun(force = false): boolean {
    if (force) return true;
    return Date.now() >= this.#openUntil;
  }

  recordSuccess(): void {
    this.#failures = 0;
    this.#openUntil = 0;
    this.#lastError = null;
  }

  recordFailure(error: unknown): void {
    this.#failures += 1;
    this.#lastError = error instanceof Error ? error.message : String(error);

    const requested = error instanceof SyncError ? error.retryAfterMs : null;
    const delay =
      requested ??
      jitter(Math.min(Breaker.BASE_MS * 2 ** (this.#failures - 1), Breaker.MAX_MS));
    this.#openUntil = Date.now() + delay;
  }

  /** Clears the breaker — on reconnect, or when the server URL changes. */
  reset(): void {
    this.recordSuccess();
  }
}

function backoff(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.baseMs * 2 ** (attempt - 1), policy.maxMs);
}

/** Full jitter: a random point in `[0, ceiling]`, not the ceiling itself. */
function jitter(ceiling: number): number {
  return Math.round(Math.random() * ceiling);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new SyncError('Synkroniseringen avbröts.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
