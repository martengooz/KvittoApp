import type {
  BackgroundScheduleOutcome,
  EventSubscription,
  NativeBackgroundLaunch,
} from '../../modules/kvitto-native/src/contracts';
import type { BackgroundSweepOptions } from './background-runner';
import type { BackgroundSweepOutcome } from './service';

/**
 * The slice of the native module this needs.
 *
 * Narrowed to a port rather than taking the whole facade so a test can drive
 * the launch path without a native module, which is the only way any of this
 * is reachable off a device: `BGTaskScheduler` will not launch a task on
 * demand, and Xcode's debugger incantation only works with a device attached.
 */
export interface BackgroundTaskPort {
  backgroundTaskIdentifier(): string;
  drainPendingBackgroundLaunches(): NativeBackgroundLaunch[];
  isBackgroundLaunchExpired(handle: string): boolean;
  finishBackgroundLaunch(handle: string, success: boolean): boolean;
  scheduleBackgroundProcessing(
    earliestDelaySeconds: number,
    requiresNetwork: boolean,
    requiresPower: boolean,
  ): Promise<BackgroundScheduleOutcome>;
  onBackgroundLaunch(listener: (launch: NativeBackgroundLaunch) => void): EventSubscription;
  logDiagnostic(category: string, message: string): void;
}

export interface BackgroundTaskLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface BackgroundTaskOptions {
  native: BackgroundTaskPort;
  sweep(options: BackgroundSweepOptions): Promise<BackgroundSweepOutcome>;
  logger?: BackgroundTaskLogger;
  /** Jobs to allow in one window, whatever the clock says. */
  maxJobsPerWindow?: number;
  /**
   * What to assume the window is worth, in milliseconds. iOS reveals no
   * deadline, so this is a guess and deliberately a conservative one: a
   * `BGProcessingTask` usually gets minutes, but a sweep that overruns is
   * killed mid-job, and a killed job's claim blocks its own retry until it
   * lapses. Finishing early costs one deferred job; overrunning costs a stall.
   */
  assumedWindowMs?: number;
  /** How long after scheduling iOS may run the task, at the earliest. */
  earliestDelaySeconds?: number;
  now?: () => number;
}

const DEFAULT_MAX_JOBS = 12;
const DEFAULT_ASSUMED_WINDOW_MS = 25_000;
const DEFAULT_EARLIEST_DELAY_SECONDS = 15 * 60;

/** Diagnostic markers, kept here so tests and the smoke check share spellings. */
export const BACKGROUND_TASK_MARKERS = {
  scheduled: 'background:scheduled',
  launched: 'background:launched',
  swept: 'background:swept',
  failed: 'background:failed',
} as const;

export interface BackgroundTaskController {
  /** Subscribes, drains anything already buffered, and asks for a window. */
  start(): Promise<BackgroundScheduleOutcome>;
  stop(): void;
  /** Requests another window. Idempotent: iOS coalesces duplicate requests. */
  schedule(): Promise<BackgroundScheduleOutcome>;
  /** Exposed for the debug screen and for tests; normally driven by the event. */
  runLaunch(launch: NativeBackgroundLaunch): Promise<BackgroundSweepOutcome | null>;
  /**
   * Runs the same drain, with no OS window behind it.
   *
   * A `BGProcessingTask` may sit queued for hours, so waiting for a real window
   * is not a way to find out whether the sweep works. This takes the same path
   * minus the parts only iOS can supply: nothing to expire, and nothing to
   * complete. It proves the drain; it proves nothing about scheduling.
   */
  sweepNow(): Promise<BackgroundSweepOutcome | null>;
  isRunning(): boolean;
}

const NOOP_LOGGER: BackgroundTaskLogger = { info: () => {}, warn: () => {} };

/**
 * Connects iOS background windows to the durable job sweep.
 *
 * The rules this enforces, in order of how expensive getting them wrong is:
 *
 * 1. **Every window is completed exactly once.** iOS kills the app if a task
 *    is never completed, and traps if it is completed twice. The `finally` is
 *    the point of this function.
 * 2. **One sweep at a time.** A second window arriving mid-sweep would put two
 *    drains on the same claim table.
 * 3. **The next window is requested even when this one fails.** Otherwise a
 *    single bad sweep ends background processing until the app is next opened.
 */
export function createBackgroundTaskController(options: BackgroundTaskOptions): BackgroundTaskController {
  const logger = options.logger ?? NOOP_LOGGER;
  const now = options.now ?? (() => Date.now());
  const maxJobs = options.maxJobsPerWindow ?? DEFAULT_MAX_JOBS;
  const assumedWindowMs = options.assumedWindowMs ?? DEFAULT_ASSUMED_WINDOW_MS;
  const earliestDelaySeconds = options.earliestDelaySeconds ?? DEFAULT_EARLIEST_DELAY_SECONDS;

  let subscription: EventSubscription | null = null;
  let inFlight: Promise<unknown> | null = null;

  async function schedule(): Promise<BackgroundScheduleOutcome> {
    try {
      const outcome = await options.native.scheduleBackgroundProcessing(earliestDelaySeconds, false, false);
      options.native.logDiagnostic(BACKGROUND_TASK_MARKERS.scheduled, outcome);
      logger.info('Background processing requested', { outcome, earliestDelaySeconds });
      return outcome;
    } catch (error) {
      logger.warn('Background processing could not be requested', { error: String(error) });
      return 'unavailable';
    }
  }

  async function runWindow(
    launch: NativeBackgroundLaunch,
    ownedByOs: boolean,
  ): Promise<BackgroundSweepOutcome | null> {
    if (inFlight) {
      // Two windows at once should not happen, but if it does, the second is
      // finished immediately rather than run: two drains against one claim
      // table is worse than one deferred window.
      logger.warn('Background window arrived while another was running', { handle: launch.handle });
      if (ownedByOs) options.native.finishBackgroundLaunch(launch.handle, false);
      return null;
    }

    options.native.logDiagnostic(BACKGROUND_TASK_MARKERS.launched, launch.handle);

    const startedAt = now();
    const run = (async (): Promise<BackgroundSweepOutcome | null> => {
      let success = false;
      try {
        const outcome = await options.sweep({
          window: {
            startedAt: launch.startedAt,
            // iOS gives no deadline, so one is invented from the assumed
            // budget. The runner still refuses to start a job it cannot
            // finish inside it, which is what keeps the guess safe.
            deadlineAt: launch.deadlineAt ?? startedAt + assumedWindowMs,
            opportunistic: true,
          },
          expiration: ownedByOs
            ? { isExpired: () => options.native.isBackgroundLaunchExpired(launch.handle) }
            : // Nothing can revoke a window iOS did not grant. Asking the
              // native side would be worse than not asking: an unknown handle
              // reads as expired, and the sweep would stop before its first job.
              undefined,
          maxJobs,
        });
        success = true;
        options.native.logDiagnostic(
          BACKGROUND_TASK_MARKERS.swept,
          `${outcome.outcome} processed=${outcome.summary?.processed ?? 0} stop=${outcome.summary?.stopReason ?? 'none'} pending=${outcome.pendingJobs}`,
        );
        logger.info('Background sweep complete', {
          handle: launch.handle,
          outcome: outcome.outcome,
          pendingJobs: outcome.pendingJobs,
        });
        return outcome;
      } catch (error) {
        options.native.logDiagnostic(BACKGROUND_TASK_MARKERS.failed, String(error));
        logger.warn('Background sweep failed', { handle: launch.handle, error: String(error) });
        return null;
      } finally {
        // iOS terminates the app if a launched task is never completed, so this
        // runs whatever happened above, before any rescheduling can throw.
        if (ownedByOs) options.native.finishBackgroundLaunch(launch.handle, success);
      }
    })();

    inFlight = run;
    try {
      return await run;
    } finally {
      inFlight = null;
      // Asked for after the window closes, not before: a request submitted
      // while the app still owns a window is the one iOS is least likely to
      // honour, and the coordinator has already submitted a successor anyway.
      if (ownedByOs) void schedule();
    }
  }

  function runLaunch(launch: NativeBackgroundLaunch): Promise<BackgroundSweepOutcome | null> {
    return runWindow(launch, true);
  }

  return {
    async start(): Promise<BackgroundScheduleOutcome> {
      if (!subscription) {
        subscription = options.native.onBackgroundLaunch((launch) => {
          void runLaunch(launch);
        });
      }

      // Anything that arrived before this listener existed. On a cold launch
      // into the background - the case this whole feature is for - the window
      // that woke the process is always here rather than in the event.
      for (const pending of options.native.drainPendingBackgroundLaunches()) {
        void runLaunch(pending);
      }

      return schedule();
    },

    stop(): void {
      subscription?.remove();
      subscription = null;
    },

    schedule,
    runLaunch,
    sweepNow(): Promise<BackgroundSweepOutcome | null> {
      return runWindow(
        {
          handle: `manual-${now()}`,
          identifier: options.native.backgroundTaskIdentifier(),
          startedAt: now(),
          deadlineAt: null,
        },
        false,
      );
    },
    isRunning: () => inFlight !== null,
  };
}
