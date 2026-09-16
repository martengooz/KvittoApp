import {
  IOS_JOB_RUNNER_CAPABILITY,
  type PersistentJobStoreDependency,
} from './contracts';

export type ForegroundRunResult =
  | 'none'
  | 'done'
  | 'retry'
  | 'cancelled'
  | 'stale_source'
  | 'stale_result'
  | 'max_attempts';

export interface ForegroundRunnerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ForegroundRunnerDeps {
  store: PersistentJobStoreDependency;
  runOne: () => Promise<ForegroundRunResult>;
  logger: ForegroundRunnerLogger;
}

export interface ForegroundDrainSummary {
  processed: number;
  lastResult: ForegroundRunResult;
  stoppedEarly: boolean;
}

export interface ForegroundDrainOptions {
  maxJobsPerForegroundWindow: number;
}

export function createForegroundJobRunner(deps: ForegroundRunnerDeps) {
  if (!deps.store.durable) {
    throw new Error('Foreground job runner requires a persistent durable store.');
  }

  const capability = IOS_JOB_RUNNER_CAPABILITY;
  let active = true;

  return {
    capability,
    stop(): void {
      active = false;
    },
    start(): void {
      active = true;
    },
    isActive(): boolean {
      return active;
    },
    async drain(options: ForegroundDrainOptions): Promise<ForegroundDrainSummary> {
      if (options.maxJobsPerForegroundWindow <= 0) {
        throw new Error('maxJobsPerForegroundWindow must be > 0');
      }

      let processed = 0;
      let lastResult: ForegroundRunResult = 'none';

      while (active && processed < options.maxJobsPerForegroundWindow) {
        lastResult = await deps.runOne();
        if (lastResult === 'none') {
          deps.logger.info('Foreground durable job runner is idle');
          return {
            processed,
            lastResult,
            stoppedEarly: false,
          };
        }

        processed += 1;

        if (lastResult === 'cancelled') {
          deps.logger.info('Foreground durable job cancelled', { processed });
        } else if (lastResult === 'retry' || lastResult === 'max_attempts') {
          deps.logger.warn('Foreground durable job deferred', {
            result: lastResult,
            processed,
          });
        }
      }

      return {
        processed,
        lastResult,
        stoppedEarly: !active || processed >= options.maxJobsPerForegroundWindow,
      };
    },
  };
}
