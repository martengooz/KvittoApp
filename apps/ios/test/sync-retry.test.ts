/** @jest-environment node */

import { CircuitBreaker } from '../src/sync/retry';
import { HttpSyncTransportError } from '../src/sync/transport/client';

describe('CircuitBreaker', () => {
  test('opens after repeated failures and resets after success', () => {
    const breaker = new CircuitBreaker();

    for (let index = 0; index < CircuitBreaker.TRIP_AT; index += 1) {
      breaker.recordFailure(new Error('boom'));
    }

    expect(breaker.open).toBe(true);
    expect(breaker.failures).toBe(CircuitBreaker.TRIP_AT);
    expect(breaker.mayRun(false)).toBe(false);
    expect(breaker.mayRun(true)).toBe(true);

    breaker.recordSuccess();

    expect(breaker.open).toBe(false);
    expect(breaker.failures).toBe(0);
    expect(breaker.lastError).toBeNull();
  });

  test('uses retry-after delay when present', () => {
    const breaker = new CircuitBreaker();
    const before = Date.now();

    breaker.recordFailure(new HttpSyncTransportError('busy', {
      status: 429,
      retryable: true,
      retryAfterMs: 2_500,
    }));

    expect(breaker.nextAttemptAt).toBeGreaterThanOrEqual(before + 2_500);
  });
});
