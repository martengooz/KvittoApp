import {
  IOS_JOB_RUNNER_CAPABILITY,
  type JobBackgroundWindow,
  type PersistentJobStoreDependency,
} from './contracts';
import type { ForegroundRunResult, ForegroundRunnerLogger } from './foreground-runner';

/** Why the sweep stopped. Every one of these leaves remaining work retryable. */
export type BackgroundStopReason =
  /** No job was ready to run. */
  | 'idle'
  /** The window's time budget would not cover another job. */
  | 'budget'
  /** iOS revoked the window; the expiration handler fired. */
  | 'expired'
  /** The caller's job cap for one window was reached. */
  | 'max-jobs'
  /** The runner was stopped, e.g. the app is tearing down. */
  | 'stopped';

export interface BackgroundSweepSummary {
  processed: number;
  lastResult: ForegroundRunResult;
  stopReason: BackgroundStopReason;
  /** Wall-clock milliseconds the sweep occupied. */
  elapsedMs: number;
}

/**
 * The OS side of a background window.
 *
 * `isExpired` is polled rather than awaited because iOS delivers expiration by
 * calling a handler on its own thread: the adapter flips a flag and the sweep
 * notices at its next checkpoint.
 */
export interface BackgroundExpiration {
  isExpired(): boolean;
}

export interface BackgroundRunnerDeps {
  store: PersistentJobStoreDependency;
  runOne: () => Promise<ForegroundRunResult>;
  logger: ForegroundRunnerLogger;
  now?: () => number;
}

export interface BackgroundSweepOptions {
  window: JobBackgroundWindow;
  expiration?: BackgroundExpiration;
  /**
   * Hard cap on jobs in one window, independent of time. Keeps a fast queue
   * from monopolising an opportunistic window the OS granted for everything.
   */
  maxJobs: number;
  /**
   * Milliseconds to leave unused at the end of the window. iOS kills the task
   * when the window closes, so the sweep must finish before that, not at it.
   */
  reserveMs?: number;
  /**
   * Budget to assume when the window carries no deadline. `BGProcessingTask`
   * often reports none; that is not a licence to run forever.
   */
  fallbackBudgetMs?: number;
}

const DEFAULT_RESERVE_MS = 2_000;
const DEFAULT_FALLBACK_BUDGET_MS = 25_000;

/**
 * Drains durable jobs inside a background window.
 *
 * This is deliberately not the foreground runner with a timer bolted on. The
 * foreground drain may stop whenever it likes and the user is there to see it;
 * a background window is revocable, and being killed mid-job is the one outcome
 * that costs something - a claimed job whose process died has to wait for its
 * claim to lapse before anything retries it.
 *
 * So the sweep never starts a job it does not expect to finish. It measures
 * what jobs have actually cost in this window and refuses to start another
 * unless that much time, plus a reserve, is still available.
 */
export function createBackgroundJobRunner(deps: BackgroundRunnerDeps) {
  if (!deps.store.durable) {
    throw new Error('Background job runner requires a persistent durable store.');
  }

  const now = deps.now ?? (() => Date.now());
  let active = true;

  return {
    capability: IOS_JOB_RUNNER_CAPABILITY,

    stop(): void {
      active = false;
    },

    start(): void {
      active = true;
    },

    isActive(): boolean {
      return active;
    },

    async sweep(options: BackgroundSweepOptions): Promise<BackgroundSweepSummary> {
      if (options.maxJobs <= 0) throw new Error('maxJobs must be > 0');

      const startedAt = now();
      const reserveMs = options.reserveMs ?? DEFAULT_RESERVE_MS;
      const fallback = options.fallbackBudgetMs ?? DEFAULT_FALLBACK_BUDGET_MS;
      const deadlineAt = options.window.deadlineAt ?? startedAt + fallback;

      let processed = 0;
      let lastResult: ForegroundRunResult = 'none';
      // Start pessimistic: until a job has actually run, assume the next one
      // costs the whole reserve. A window too small for any job does nothing
      // rather than starting one it cannot finish.
      let worstJobMs = reserveMs;

      const finish = (stopReason: BackgroundStopReason): BackgroundSweepSummary => {
        const summary = { processed, lastResult, stopReason, elapsedMs: now() - startedAt };
        deps.logger.info('Background sweep finished', { ...summary, task: options.window.startedAt });
        return summary;
      };

      while (true) {
        if (!active) return finish('stopped');
        if (options.expiration?.isExpired()) {
          deps.logger.warn('Background window expired; leaving the rest for next time', { processed });
          return finish('expired');
        }
        if (processed >= options.maxJobs) return finish('max-jobs');

        const remaining = deadlineAt - now();
        if (remaining <= reserveMs + worstJobMs) return finish('budget');

        const jobStartedAt = now();
        lastResult = await deps.runOne();
        const jobMs = now() - jobStartedAt;
        worstJobMs = Math.max(worstJobMs, jobMs);

        if (lastResult === 'none') return finish('idle');

        processed += 1;

        if (lastResult === 'retry' || lastResult === 'max_attempts') {
          deps.logger.warn('Background durable job deferred', { result: lastResult, processed });
        }
      }
    },
  };
}
