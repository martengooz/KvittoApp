import type { JobRecord, JobState, JobStorePort } from '@kvitto/client-core/ports';

import type { ScanJobQueuePort } from '../features/scan/types';
import { createForegroundJobRunner, type ForegroundDrainSummary, type ForegroundRunResult } from './foreground-runner';
import {
  createBackgroundJobRunner,
  type BackgroundSweepOptions,
  type BackgroundSweepSummary,
} from './background-runner';

export type ScanDurableJobKind = 'image-processing' | 'ocr' | 'extraction';

export interface ScanDurableJobInput {
  kind: ScanDurableJobKind;
  receiptId: string;
  sourceVersion: number;
  sourceImageId: string | null;
}

export interface ScanJobServiceClock {
  now(): number;
}

export type ScanJobIdFactory = (job: ScanDurableJobInput) => string;

export interface ScanDurableJobServiceOptions {
  store: JobStorePort;
  clock?: ScanJobServiceClock;
  idFactory?: ScanJobIdFactory;
  runOne?: () => Promise<ForegroundRunResult>;
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface ForegroundDrainOutcome {
  outcome: 'processed' | 'idle' | 'deferred' | 'unsupported';
  summary: ForegroundDrainSummary | null;
  pendingJobs: number;
}

export interface BackgroundSweepOutcome {
  outcome: 'processed' | 'idle' | 'unsupported';
  summary: BackgroundSweepSummary | null;
  pendingJobs: number;
}

export interface ScanDurableJobService {
  queue: ScanJobQueuePort;
  enqueue(job: ScanDurableJobInput): Promise<JobRecord>;
  list(state?: JobState): Promise<JobRecord[]>;
  cancel(id: string): Promise<void>;
  drainForeground(maxJobsPerForegroundWindow: number): Promise<ForegroundDrainOutcome>;
  /**
   * Drains inside an OS-granted background window. Nothing calls this until a
   * background task is registered; see IOS-NEXT-STEPS.md.
   */
  sweepBackground(options: BackgroundSweepOptions): Promise<BackgroundSweepOutcome>;
  stop(): void;
  start(): void;
  isActive(): boolean;
}

const SCAN_IMAGE_PROCESSING_KIND = 'scan:image-processing';
const SCAN_OCR_KIND = 'scan:ocr';
const SCAN_EXTRACTION_KIND = 'scan:extraction';

const NOOP_LOGGER = {
  info: () => {},
  warn: () => {},
};

function defaultIdFactory(job: ScanDurableJobInput): string {
  const image = job.sourceImageId ?? 'none';
  const random = Math.random().toString(36).slice(2, 10);
  return `scan-${job.kind}-${job.receiptId}-${job.sourceVersion}-${image}-${random}`;
}

function priorityOf(kind: ScanDurableJobKind): number {
  if (kind === 'image-processing') return 220;
  // Extraction runs behind OCR: OCR is on-device and cheap, and its output is
  // evidence the user can see immediately, while extraction costs a network
  // round trip and possibly money.
  if (kind === 'extraction') return 100;
  return 140;
}

function maxAttemptsOf(kind: ScanDurableJobKind): number {
  if (kind === 'image-processing') return 4;
  // Extraction calls a paid provider; retrying it as freely as local work
  // turns one transient failure into several billed attempts.
  if (kind === 'extraction') return 2;
  return 3;
}

function toDurableKind(kind: ScanDurableJobKind): string {
  if (kind === 'image-processing') return SCAN_IMAGE_PROCESSING_KIND;
  if (kind === 'extraction') return SCAN_EXTRACTION_KIND;
  return SCAN_OCR_KIND;
}

export function createScanDurableJobService(options: ScanDurableJobServiceOptions): ScanDurableJobService {
  const clock = options.clock ?? { now: () => Date.now() };
  const idFactory = options.idFactory ?? defaultIdFactory;
  const logger = options.logger ?? NOOP_LOGGER;

  const foregroundRunner = options.runOne
    ? createForegroundJobRunner({
      store: { durable: true, persistence: 'sqlcipher', description: 'ios-kv-job-store' },
      runOne: options.runOne,
      logger,
    })
    : null;

  // Shares `runOne` with the foreground drain: the same handlers, run under a
  // revocable time budget instead of at the user's pace.
  const backgroundRunner = options.runOne
    ? createBackgroundJobRunner({
      store: { durable: true, persistence: 'sqlcipher', description: 'ios-kv-job-store' },
      runOne: options.runOne,
      logger,
      now: () => clock.now(),
    })
    : null;

  async function enqueue(job: ScanDurableJobInput): Promise<JobRecord> {
    const now = Math.max(0, Math.trunc(clock.now()));
    return options.store.enqueue({
      id: idFactory(job),
      kind: toDurableKind(job.kind),
      sourceKind: 'receipt',
      sourceId: job.receiptId,
      sourceUpdatedAt: Math.max(0, Math.trunc(job.sourceVersion)),
      priority: priorityOf(job.kind),
      nextAttemptAt: now,
      maxAttempts: maxAttemptsOf(job.kind),
    });
  }

  async function list(state?: JobState): Promise<JobRecord[]> {
    return options.store.list(state);
  }

  async function cancel(id: string): Promise<void> {
    const now = Math.max(0, Math.trunc(clock.now()));
    const current = await options.store.get(id);
    if (!current) return;
    await options.store.requestCancel(id, now);
    if (current.state === 'pending' || current.state === 'failed') {
      await options.store.markCancelled(id, now);
    }
  }

  async function drainForeground(maxJobsPerForegroundWindow: number): Promise<ForegroundDrainOutcome> {
    if (foregroundRunner && !foregroundRunner.isActive()) {
      return {
        outcome: 'deferred',
        summary: null,
        pendingJobs: (await options.store.list('pending')).length,
      };
    }

    if (!foregroundRunner) {
      const pendingJobs = (await options.store.list()).filter((job) => (
        (job.state === 'pending' || job.state === 'failed' || job.state === 'running')
        && !job.cancelRequested
      )).length;
      return {
        outcome: 'unsupported',
        summary: null,
        pendingJobs,
      };
    }

    const summary = await foregroundRunner.drain({
      maxJobsPerForegroundWindow,
    });

    if (summary.lastResult === 'none' && summary.processed === 0) {
      return {
        outcome: 'idle',
        summary,
        pendingJobs: (await options.store.list('pending')).length,
      };
    }

    if (summary.lastResult === 'retry' || summary.lastResult === 'max_attempts') {
      return {
        outcome: 'deferred',
        summary,
        pendingJobs: (await options.store.list('pending')).length,
      };
    }

    return {
      outcome: 'processed',
      summary,
      pendingJobs: (await options.store.list('pending')).length,
    };
  }

  async function sweepBackground(sweep: BackgroundSweepOptions): Promise<BackgroundSweepOutcome> {
    if (!backgroundRunner) {
      return { outcome: 'unsupported', summary: null, pendingJobs: (await options.store.list('pending')).length };
    }

    const summary = await backgroundRunner.sweep(sweep);
    return {
      outcome: summary.processed === 0 ? 'idle' : 'processed',
      summary,
      pendingJobs: (await options.store.list('pending')).length,
    };
  }

  return {
    queue: {
      enqueue: (job) => enqueue(job).then(() => undefined),
    },
    enqueue,
    list,
    cancel,
    drainForeground,
    sweepBackground,
    stop() {
      foregroundRunner?.stop();
      backgroundRunner?.stop();
    },
    start() {
      foregroundRunner?.start();
      backgroundRunner?.start();
    },
    isActive() {
      return foregroundRunner?.isActive() ?? true;
    },
  };
}