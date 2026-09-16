import type { Logger } from '@kvitto/client-core/ports';

import type { SyncTransportError } from '../transport/client.js';

export interface RetryPolicy {
  attempts: number;
  baseMs: number;
  maxMs: number;
}

export const REQUEST_POLICY: RetryPolicy = {
  attempts: 3,
  baseMs: 500,
  maxMs: 8_000,
};

export async function withRetry<T>(
  work: (attempt: number) => Promise<T>,
  options: {
    signal?: AbortSignal;
    logger?: Logger;
    policy?: RetryPolicy;
    onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  } = {},
): Promise<T> {
  const policy = options.policy ?? REQUEST_POLICY;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await work(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt >= policy.attempts) throw error;

      const serverDelay = getRetryAfterMs(error);
      const delayMs = serverDelay ?? jitter(backoff(attempt, policy));
      options.logger?.warn('sync.retry', {
        attempt,
        delayMs,
        retryAfterMs: serverDelay,
        reason: describeError(error),
      });
      options.onRetry?.(attempt, delayMs, error);
      await sleep(delayMs, options.signal);
    }
  }

  throw lastError;
}

export class CircuitBreaker {
  static readonly TRIP_AT = 5;
  static readonly BASE_MS = 30_000;
  static readonly MAX_MS = 30 * 60_000;

  #failures = 0;
  #openUntil = 0;
  #lastError: string | null = null;

  get failures(): number {
    return this.#failures;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  get open(): boolean {
    return this.#failures >= CircuitBreaker.TRIP_AT;
  }

  get nextAttemptAt(): number {
    return this.#openUntil;
  }

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
    this.#lastError = describeError(error);

    const retryAfterMs = getRetryAfterMs(error);
    const delayMs = retryAfterMs ?? jitter(Math.min(CircuitBreaker.BASE_MS * 2 ** (this.#failures - 1), CircuitBreaker.MAX_MS));
    this.#openUntil = Date.now() + delayMs;
  }

  reset(): void {
    this.recordSuccess();
  }
}

function backoff(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.baseMs * 2 ** (attempt - 1), policy.maxMs);
}

function jitter(maxMs: number): number {
  return Math.round(Math.random() * maxMs);
}

function isRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'retryable' in error && (error as { retryable: unknown }).retryable === true);
}

function getRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  if (!('retryAfterMs' in error)) return null;
  const value = (error as SyncTransportError).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new Error('Sync cancelled.');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Sync cancelled.'));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
