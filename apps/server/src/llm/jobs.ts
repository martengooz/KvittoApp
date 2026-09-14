/**
 * The extraction queue.
 *
 * Scheduling only — what to read next, when to try again, and when to give up.
 * The reading itself is in `worker.ts` and the merge rules are in
 * `@kvitto/shared`, so this file has no opinion about receipts at all.
 *
 * Backoff is stored rather than held in memory (`nextAttemptAt` is a column) so
 * a restart does not reset every failing job's timer and hammer a model that
 * was already struggling.
 */

import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import type { Receipt } from '@kvitto/shared';

import { getDb, schema } from '../db/index.ts';
import { config } from '../env.ts';

export type JobState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface Job {
  receiptId: string;
  accountId: string;
  state: JobState;
  attempts: number;
  nextAttemptAt: number;
  sourceUpdatedAt: number;
  imageId: string | null;
  lastError: string | null;
  durationMs: number | null;
  updatedAt: number;
}

/**
 * Finds receipts that want reading and makes sure each has a job row.
 *
 * A receipt qualifies when it has an image, has not been reviewed by a human,
 * and has no extraction yet. Re-queues one whose image changed since the last
 * attempt — a re-photographed receipt is a different job even though it is the
 * same record.
 */
export function enqueueEligible(accountId: string, limit = 200): number {
  const db = getDb();
  const now = Date.now();

  const rows = db
    .select({ payload: schema.receipts.payload, updatedAt: schema.receipts.updatedAt })
    .from(schema.receipts)
    .where(and(eq(schema.receipts.accountId, accountId), eq(schema.receipts.deletedAt, 0)))
    .orderBy(asc(schema.receipts.rev))
    .limit(limit)
    .all();

  let queued = 0;
  for (const row of rows) {
    let receipt: Receipt;
    try {
      receipt = JSON.parse(row.payload) as Receipt;
    } catch {
      continue;
    }
    if (!needsExtraction(receipt)) continue;

    const existing = get(receipt.id);
    if (existing) {
      // Only the picture changing justifies re-reading a receipt the model has
      // already had a go at; another device editing a note does not.
      const sameImage = existing.imageId === receipt.imageId;
      if (sameImage && existing.state !== 'pending') continue;
      if (sameImage) continue;
    }

    upsert({
      receiptId: receipt.id,
      accountId,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      sourceUpdatedAt: receipt.updatedAt,
      imageId: receipt.imageId,
      lastError: null,
      durationMs: null,
      updatedAt: now,
    });
    queued += 1;
  }
  return queued;
}

/** Whether this receipt is one the model should look at. */
export function needsExtraction(receipt: Receipt): boolean {
  if (receipt.deletedAt !== 0) return false;
  if (!receipt.imageId) return false;
  // A human has accepted it; nothing automatic touches it again.
  if (receipt.status === 'confirmed') return false;
  // Already parsed, by whatever means. A re-run is an explicit request.
  if (receipt.extraction) return false;
  return true;
}

/** The next batch of jobs whose backoff has elapsed. */
export function claimBatch(accountId: string, size: number): Job[] {
  const db = getDb();
  const now = Date.now();

  const due = db
    .select()
    .from(schema.extractionJobs)
    .where(
      and(
        eq(schema.extractionJobs.accountId, accountId),
        eq(schema.extractionJobs.state, 'pending'),
        lte(schema.extractionJobs.nextAttemptAt, now),
      ),
    )
    // Oldest backoff first, so a job that has been waiting does not starve
    // behind a stream of fresh arrivals.
    .orderBy(asc(schema.extractionJobs.nextAttemptAt))
    .limit(size)
    .all() as Job[];

  for (const job of due) {
    db.update(schema.extractionJobs)
      .set({ state: 'running', updatedAt: now })
      .where(eq(schema.extractionJobs.receiptId, job.receiptId))
      .run();
  }
  return due.map((job) => ({ ...job, state: 'running' as const }));
}

export function get(receiptId: string): Job | undefined {
  return getDb()
    .select()
    .from(schema.extractionJobs)
    .where(eq(schema.extractionJobs.receiptId, receiptId))
    .limit(1)
    .all()[0] as Job | undefined;
}

export function succeed(receiptId: string, durationMs: number): void {
  getDb()
    .update(schema.extractionJobs)
    .set({ state: 'done', lastError: null, durationMs, updatedAt: Date.now() })
    .where(eq(schema.extractionJobs.receiptId, receiptId))
    .run();
}

/** Records that there was nothing to do — a confirmed receipt, say. */
export function skip(receiptId: string, reason: string): void {
  getDb()
    .update(schema.extractionJobs)
    .set({ state: 'skipped', lastError: reason, updatedAt: Date.now() })
    .where(eq(schema.extractionJobs.receiptId, receiptId))
    .run();
}

/**
 * Records a failure and schedules the retry.
 *
 * Exponential with full jitter: the delay is a random point in `[0, 2^n · base]`
 * rather than exactly `2^n · base`. With several receipts failing at once —
 * which is what a model that has fallen over looks like — a fixed schedule
 * would retry them all in the same instant, again and again. Jitter spreads
 * them out, and full jitter is the variant that spreads them best.
 */
export function fail(receiptId: string, error: string, retryable: boolean): Job | undefined {
  const job = get(receiptId);
  if (!job) return undefined;

  const attempts = job.attempts + 1;
  const exhausted = !retryable || attempts >= config.llm.maxAttempts;
  const ceiling = Math.min(config.llm.retryBaseMs * 2 ** (attempts - 1), config.llm.retryMaxMs);
  const delay = Math.round(Math.random() * ceiling);

  const next: Partial<Job> = {
    state: exhausted ? 'failed' : 'pending',
    attempts,
    nextAttemptAt: exhausted ? 0 : Date.now() + delay,
    lastError: error.slice(0, 500),
    updatedAt: Date.now(),
  };

  getDb()
    .update(schema.extractionJobs)
    .set(next)
    .where(eq(schema.extractionJobs.receiptId, receiptId))
    .run();

  return { ...job, ...next } as Job;
}

/**
 * Returns every job whose state is `running` to `pending`.
 *
 * Called at startup: a job left `running` is one that was interrupted by a
 * crash or a restart, and it would otherwise sit in that state forever.
 */
export function requeueStranded(): number {
  const result = getDb()
    .update(schema.extractionJobs)
    .set({ state: 'pending', nextAttemptAt: Date.now(), updatedAt: Date.now() })
    .where(eq(schema.extractionJobs.state, 'running'))
    .run();
  return result.changes;
}

/** Clears the failure state so exhausted jobs are attempted again. */
export function retryFailed(accountId: string): number {
  const result = getDb()
    .update(schema.extractionJobs)
    .set({ state: 'pending', attempts: 0, nextAttemptAt: Date.now(), updatedAt: Date.now() })
    .where(
      and(eq(schema.extractionJobs.accountId, accountId), eq(schema.extractionJobs.state, 'failed')),
    )
    .run();
  return result.changes;
}

/** Queues one receipt explicitly, resetting whatever state it was in. */
export function requeue(accountId: string, receipt: Receipt): void {
  upsert({
    receiptId: receipt.id,
    accountId,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: Date.now(),
    sourceUpdatedAt: receipt.updatedAt,
    imageId: receipt.imageId,
    lastError: null,
    durationMs: null,
    updatedAt: Date.now(),
  });
}

export interface QueueCounts {
  pending: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
  /** Jobs waiting on a backoff timer rather than on a free slot. */
  waiting: number;
}

export function counts(accountId: string): QueueCounts {
  const rows = getDb()
    .select({ state: schema.extractionJobs.state, count: sql<number>`count(*)` })
    .from(schema.extractionJobs)
    .where(eq(schema.extractionJobs.accountId, accountId))
    .groupBy(schema.extractionJobs.state)
    .all();

  const result: QueueCounts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0, waiting: 0 };
  for (const row of rows) {
    if (row.state in result) (result as unknown as Record<string, number>)[row.state] = row.count;
  }

  const waiting = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(schema.extractionJobs)
    .where(
      and(
        eq(schema.extractionJobs.accountId, accountId),
        eq(schema.extractionJobs.state, 'pending'),
        sql`${schema.extractionJobs.nextAttemptAt} > ${Date.now()}`,
      ),
    )
    .all()[0];
  result.waiting = waiting?.count ?? 0;

  return result;
}

/** The most recent failures, for the status endpoint. */
export function recentFailures(accountId: string, limit = 5): Job[] {
  return getDb()
    .select()
    .from(schema.extractionJobs)
    .where(
      and(
        eq(schema.extractionJobs.accountId, accountId),
        inArray(schema.extractionJobs.state, ['failed', 'pending']),
        or(isNull(schema.extractionJobs.lastError), sql`${schema.extractionJobs.lastError} IS NOT NULL`),
      ),
    )
    .orderBy(sql`${schema.extractionJobs.updatedAt} DESC`)
    .limit(limit)
    .all()
    .filter((job) => (job as Job).lastError !== null) as Job[];
}

function upsert(job: Job): void {
  getDb()
    .insert(schema.extractionJobs)
    .values(job)
    .onConflictDoUpdate({ target: schema.extractionJobs.receiptId, set: job })
    .run();
}
