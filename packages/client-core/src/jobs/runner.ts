import type { JobStorePort } from '../ports/jobs.js';
import type { CanonicalRepositoryPort, Clock, Logger, SchedulerPort } from '../ports/types.js';

type DurableClaimState = 'active' | 'lost' | 'cancelled';

export type DurableRunResult =
  | 'none'
  | 'done'
  | 'retry'
  | 'cancelled'
  | 'stale_source'
  | 'stale_result'
  | 'max_attempts';

export interface DurableClaim {
  id: string;
  claimedAt: number;
  leaseMs: number;
  attempt: number;
  sourceVersion: number;
  claimToken: string;
}

export interface DurableJobHandlerContext {
  claim: DurableClaim;
  isCancelled(): Promise<boolean>;
  reportProgress(progress: number): Promise<void>;
  getClaimState(): Promise<DurableClaimState>;
}

export interface DurableJobHandlerResult {
  sourceVersion?: number;
  progress?: number;
}

export type IdempotentDurableJobHandler = (
  context: DurableJobHandlerContext,
) => Promise<void | DurableJobHandlerResult>;

export interface DurableJobOptions {
  leaseMs: number;
  kind: string;
  sourceVersionOf?: (job: { sourceKind: string; sourceId: string; sourceVersion: number }) => Promise<number | null>;
  backoffMs?: (attempt: number) => number;
  handle: IdempotentDurableJobHandler;
}

export interface DurableJobDispatchOptions {
  leaseMs: number;
  handlers: Record<string, IdempotentDurableJobHandler>;
  sourceVersionOf?: (job: { sourceKind: string; sourceId: string; sourceVersion: number }) => Promise<number | null>;
  backoffMs?: (attempt: number) => number;
  onUnsupportedKind?: 'cancel' | 'done';
}

export interface JobRunnerPorts {
  jobs: JobStorePort;
  repo: CanonicalRepositoryPort;
  clock: Clock;
  scheduler: SchedulerPort;
  logger: Logger;
}

export interface RunOnceOptions {
  leaseMs: number;
  kind: string;
  handle: (args: { sourceId: string; sourceUpdatedAt: number }) => Promise<void>;
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  if (progress < 0) return 0;
  if (progress > 1) return 1;
  return progress;
}

export function exponentialBackoffMs(attempt: number, baseMs = 1_000, maxMs = 60_000): number {
  const normalizedAttempt = Math.max(1, Math.trunc(attempt));
  const factor = 2 ** Math.max(0, normalizedAttempt - 1);
  return Math.min(maxMs, baseMs * factor);
}

async function getDefaultSourceVersion(repo: CanonicalRepositoryPort, sourceKind: string, sourceId: string, sourceVersion: number): Promise<number | null> {
  if (sourceKind !== 'receipt') return sourceVersion;
  const receipt = await repo.getReceipt(sourceId);
  return receipt ? receipt.updatedAt : null;
}

async function getClaimState(ports: JobRunnerPorts, claim: DurableClaim): Promise<DurableClaimState> {
  const latest = await ports.jobs.get(claim.id);
  if (!latest) return 'lost';
  if (latest.cancelRequested) return 'cancelled';
  if (latest.state !== 'running') return 'lost';
  if (latest.attempts !== claim.attempt) return 'lost';
  return 'active';
}

function nextDelayMs(ports: JobRunnerPorts, options: DurableJobOptions, attempt: number): number {
  if (options.backoffMs) return Math.max(0, options.backoffMs(attempt));
  const fromScheduler = ports.scheduler.delayMs(attempt);
  if (Number.isFinite(fromScheduler) && fromScheduler >= 0) return fromScheduler;
  return exponentialBackoffMs(attempt);
}

async function failAndScheduleRetry(ports: JobRunnerPorts, options: DurableJobOptions, claim: DurableClaim, errorMessage: string): Promise<DurableRunResult> {
  const now = ports.clock.now();
  const delay = nextDelayMs(ports, options, claim.attempt);
  await ports.jobs.markRetry(claim.id, now, delay, errorMessage);

  const latest = await ports.jobs.get(claim.id);
  if (latest && latest.attempts >= latest.maxAttempts) {
    await ports.jobs.markCancelled(claim.id, now);
    ports.logger.warn('Durable job cancelled after max attempts', {
      jobId: claim.id,
      attempts: latest.attempts,
      maxAttempts: latest.maxAttempts,
    });
    return 'max_attempts';
  }

  ports.logger.warn('Retrying failed durable job', {
    jobId: claim.id,
    attempt: claim.attempt,
    delayMs: delay,
  });
  return 'retry';
}

async function runClaimedDurableJobStrict(
  ports: JobRunnerPorts,
  claimRef: { id: string; leaseMs: number; claimedAt: number },
  options: {
    sourceVersionOf: (job: { sourceKind: string; sourceId: string; sourceVersion: number }) => Promise<number | null>;
    backoffMs?: (attempt: number) => number;
    handleForKind(kind: string): IdempotentDurableJobHandler | null;
    unsupportedKind(jobKind: string, claim: DurableClaim): Promise<DurableRunResult>;
  },
): Promise<DurableRunResult> {
  const job = await ports.jobs.get(claimRef.id);
  if (!job) return 'none';

  const claim: DurableClaim = {
    id: job.id,
    claimedAt: claimRef.claimedAt,
    leaseMs: claimRef.leaseMs,
    attempt: job.attempts,
    sourceVersion: job.sourceUpdatedAt,
    claimToken: `${job.id}:${job.attempts}:${claimRef.claimedAt}`,
  };

  if (job.cancelRequested) {
    await ports.jobs.markCancelled(job.id, ports.clock.now());
    return 'cancelled';
  }

  const handle = options.handleForKind(job.kind);
  if (!handle) {
    return options.unsupportedKind(job.kind, claim);
  }

  const sourceVersion = await options.sourceVersionOf({
    sourceKind: job.sourceKind,
    sourceId: job.sourceId,
    sourceVersion: claim.sourceVersion,
  });
  if (sourceVersion === null || sourceVersion !== claim.sourceVersion) {
    ports.logger.info('Discarding stale durable job before run', {
      jobId: job.id,
      sourceId: job.sourceId,
      sourceVersion,
      expectedSourceVersion: claim.sourceVersion,
    });
    await ports.jobs.markDone(job.id, ports.clock.now());
    return 'stale_source';
  }

  const context: DurableJobHandlerContext = {
    claim,
    isCancelled: async () => {
      const current = await ports.jobs.get(claim.id);
      return current?.cancelRequested === true;
    },
    reportProgress: async (progress: number) => {
      const state = await getClaimState(ports, claim);
      if (state !== 'active') return;
      await ports.jobs.markProgress(claim.id, clampProgress(progress), ports.clock.now());
    },
    getClaimState: async () => getClaimState(ports, claim),
  };

  try {
    const result = await handle(context);

    const claimState = await getClaimState(ports, claim);
    if (claimState === 'cancelled') {
      await ports.jobs.markCancelled(claim.id, ports.clock.now());
      return 'cancelled';
    }
    if (claimState === 'lost') {
      ports.logger.info('Suppressing stale durable job result after claim loss', {
        jobId: claim.id,
        claimToken: claim.claimToken,
      });
      return 'stale_result';
    }

    if (result?.progress !== undefined) {
      await ports.jobs.markProgress(claim.id, clampProgress(result.progress), ports.clock.now());
    }

    const latestSourceVersion = await options.sourceVersionOf({
      sourceKind: job.sourceKind,
      sourceId: job.sourceId,
      sourceVersion: claim.sourceVersion,
    });
    const resultSourceVersion = result?.sourceVersion ?? claim.sourceVersion;
    if (latestSourceVersion === null || latestSourceVersion !== resultSourceVersion) {
      ports.logger.info('Suppressing stale durable job result after source change', {
        jobId: claim.id,
        sourceId: job.sourceId,
        resultSourceVersion,
        latestSourceVersion,
      });
      await ports.jobs.markDone(claim.id, ports.clock.now());
      return 'stale_result';
    }

    await ports.jobs.markDone(claim.id, ports.clock.now());
    return 'done';
  } catch (error) {
    if (await context.isCancelled()) {
      await ports.jobs.markCancelled(claim.id, ports.clock.now());
      return 'cancelled';
    }

    const message = error instanceof Error ? error.message : String(error);
    const retryOptions: DurableJobOptions = {
      leaseMs: claim.leaseMs,
      kind: job.kind,
      sourceVersionOf: options.sourceVersionOf,
      backoffMs: options.backoffMs,
      handle,
    };
    return failAndScheduleRetry(ports, retryOptions, claim, message);
  }
}

export async function runOneDurableJobStrictDispatch(
  ports: JobRunnerPorts,
  options: DurableJobDispatchOptions,
): Promise<DurableRunResult> {
  const now = ports.clock.now();
  const claimRef = await ports.jobs.claimNext(now, options.leaseMs);
  if (!claimRef) return 'none';

  const sourceVersionOf = options.sourceVersionOf
    ?? ((input: { sourceKind: string; sourceId: string; sourceVersion: number }) => getDefaultSourceVersion(ports.repo, input.sourceKind, input.sourceId, input.sourceVersion));

  return runClaimedDurableJobStrict(ports, claimRef, {
    sourceVersionOf,
    backoffMs: options.backoffMs,
    handleForKind: (kind) => options.handlers[kind] ?? null,
    unsupportedKind: async (jobKind, claim) => {
      const strategy = options.onUnsupportedKind ?? 'cancel';
      if (strategy === 'done') {
        ports.logger.warn('Unsupported durable job kind was marked done by dispatcher', {
          jobId: claim.id,
          kind: jobKind,
        });
        await ports.jobs.markDone(claim.id, ports.clock.now());
        return 'done';
      }

      ports.logger.warn('Unsupported durable job kind was cancelled by dispatcher', {
        jobId: claim.id,
        kind: jobKind,
      });
      await ports.jobs.markCancelled(claim.id, ports.clock.now());
      return 'cancelled';
    },
  });
}

export async function runOneDurableJobStrict(ports: JobRunnerPorts, options: DurableJobOptions): Promise<DurableRunResult> {
  const now = ports.clock.now();
  const claimRef = await ports.jobs.claimNext(now, options.leaseMs);
  if (!claimRef) return 'none';
  const sourceVersionOf = options.sourceVersionOf
    ?? ((input: { sourceKind: string; sourceId: string; sourceVersion: number }) => getDefaultSourceVersion(ports.repo, input.sourceKind, input.sourceId, input.sourceVersion));

  return runClaimedDurableJobStrict(ports, claimRef, {
    sourceVersionOf,
    backoffMs: options.backoffMs,
    handleForKind: (kind) => (kind === options.kind ? options.handle : null),
    unsupportedKind: async (jobKind, claim) => failAndScheduleRetry(ports, options, claim, `unsupported-kind:${jobKind}`),
  });
}

export async function runOneDurableJob(ports: JobRunnerPorts, options: RunOnceOptions): Promise<'none' | 'done' | 'retry' | 'stale' | 'cancelled'> {
  const strict = await runOneDurableJobStrict(ports, {
    leaseMs: options.leaseMs,
    kind: options.kind,
    handle: async (context) => {
      const job = await ports.jobs.get(context.claim.id);
      if (!job) return;
      await options.handle({
        sourceId: job.sourceId,
        sourceUpdatedAt: job.sourceUpdatedAt,
      });
    },
  });

  if (strict === 'stale_source' || strict === 'stale_result') return 'stale';
  if (strict === 'max_attempts') return 'cancelled';
  return strict;
}
