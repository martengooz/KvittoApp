/**
 * The background extraction pass.
 *
 * Takes receipts that have arrived from a device but have never been read,
 * runs the local vision model over their images, and merges what comes back
 * into the stored record.
 *
 * The result is not delivered on a channel of its own. It is written with an
 * ordinary revision through {@link writeServerRecords}, which means every
 * device picks it up on the pull it was already going to do — no second
 * protocol, no second cursor, no second set of conflict rules.
 *
 * The merge is deliberately timid. See `@kvitto/shared/merge` for why a
 * background writer must not play by last-write-wins.
 */

import { readFile } from 'node:fs/promises';

import {
  EMPTY_SYNC_META,
  LOCAL_LLM_PROVIDER,
  RECEIPT_USER_PROMPT,
  guessCategorySlug,
  mergeEnrichment,
  newId,
  normalizeExtraction,
  validateExtraction,
  type ExtractionInfo,
  type Receipt,
  type ReceiptItem,
} from '@kvitto/shared';

import { blobExists, blobPath } from '../blobs.ts';
import { countLiveItems, listLiveCategories, readRecord, writeServerRecords } from '../db/sync.ts';
import { config } from '../env.ts';
import { LlmError, generate } from './ollama.ts';
import * as jobs from './jobs.ts';
import { ensureReady, isReady } from './runtime.ts';

export interface PassReport {
  claimed: number;
  extracted: number;
  skipped: number;
  failed: number;
  /** Set when the pass could not start at all. */
  blocked: string | null;
  durationMs: number;
}

let running = false;
let timer: ReturnType<typeof setInterval> | undefined;
let lastReport: PassReport | null = null;
/** Consecutive passes that failed outright; drives the idle backoff. */
let quietPasses = 0;

export function lastPass(): PassReport | null {
  return lastReport;
}

/**
 * Runs one pass over the queue.
 *
 * Concurrent callers share the in-flight pass rather than starting a second
 * one: a 4B model on CPU is single-threaded in practice, and two passes would
 * simply queue behind each other inside Ollama while doubling the memory.
 */
export async function runPass(accountId: string, options: { size?: number } = {}): Promise<PassReport> {
  const started = Date.now();
  const report: PassReport = { claimed: 0, extracted: 0, skipped: 0, failed: 0, blocked: null, durationMs: 0 };

  if (!config.llm.enabled) {
    report.blocked = 'Den lokala modellen är avstängd.';
    report.durationMs = Date.now() - started;
    return report;
  }
  if (running) {
    report.blocked = 'En körning pågår redan.';
    report.durationMs = Date.now() - started;
    return report;
  }

  running = true;
  try {
    if (!(await ensureReady())) {
      report.blocked = 'Modellen är inte redo.';
      return report;
    }

    jobs.enqueueEligible(accountId);
    const batch = jobs.claimBatch(accountId, options.size ?? config.llm.batchSize);
    report.claimed = batch.length;

    for (const job of batch) {
      // Re-check between receipts: a model that died mid-batch should stop the
      // batch rather than burn every remaining job's retry budget on the same
      // failure.
      if (!isReady()) {
        jobs.fail(job.receiptId, 'Modellen blev otillgänglig under körningen.', true);
        report.failed += 1;
        continue;
      }

      const outcome = await extractOne(accountId, job.receiptId);
      if (outcome === 'extracted') report.extracted += 1;
      else if (outcome === 'skipped') report.skipped += 1;
      else report.failed += 1;
    }
  } finally {
    running = false;
    report.durationMs = Date.now() - started;
    lastReport = report;
  }

  return report;
}

type Outcome = 'extracted' | 'skipped' | 'failed';

async function extractOne(accountId: string, receiptId: string): Promise<Outcome> {
  const receipt = readRecord(accountId, 'receipts', receiptId);
  if (!receipt) {
    jobs.skip(receiptId, 'Kvittot finns inte längre.');
    return 'skipped';
  }
  if (!jobs.needsExtraction(receipt)) {
    jobs.skip(receiptId, 'Kvittot behöver ingen tolkning.');
    return 'skipped';
  }

  const imageId = receipt.imageId;
  if (!imageId || !blobExists(imageId)) {
    // The metadata syncs before the image does, so a missing blob is normal and
    // temporary. Retryable, so it is picked up once the upload lands.
    jobs.fail(receiptId, 'Bilden har inte synkats hit än.', true);
    return 'failed';
  }

  let image: Buffer;
  try {
    image = await readFile(blobPath(imageId));
  } catch (error) {
    jobs.fail(receiptId, `Kunde inte läsa bilden: ${describe(error)}`, true);
    return 'failed';
  }

  let raw: Record<string, unknown>;
  let durationMs = 0;
  let model = config.llm.model;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  try {
    const response = await generate({
      model: config.llm.model,
      // The compact prompt: a 4B model follows short rules better than long
      // explanations, and the schema does the structural work anyway.
      prompt: RECEIPT_USER_PROMPT,
      images: [image.toString('base64')],
      structuredOutput: true,
      maxOutputTokens: config.llm.maxOutputTokens,
      timeoutMs: config.llm.requestTimeoutMs,
    });
    durationMs = response.durationMs;
    model = response.model;
    inputTokens = response.promptTokens;
    outputTokens = response.outputTokens;
    raw = response.raw;
  } catch (error) {
    const retryable = error instanceof LlmError ? error.retryable : true;
    jobs.fail(receiptId, describe(error), retryable);
    return 'failed';
  }

  const extraction = normalizeExtraction(raw);
  // Arithmetic/consistency issues, same check the phone runs after every
  // extraction — a receipt the local model reads must get the same review
  // prompts as one read on a device.
  const report = validateExtraction(extraction);
  const warnings = [
    ...extraction.warnings,
    ...report.issues.filter((issue) => issue.severity !== 'info').map((issue) => issue.message),
  ];
  const info: ExtractionInfo = {
    provider: LOCAL_LLM_PROVIDER,
    model,
    at: Date.now(),
    durationMs,
    inputTokens,
    outputTokens,
    warnings,
    error: null,
  };

  // Re-read inside the same tick as the merge: a device may have pushed an edit
  // while the model was thinking, and the merge must run against that, not
  // against the copy the job was queued from.
  const current = readRecord(accountId, 'receipts', receiptId);
  if (!current) {
    jobs.skip(receiptId, 'Kvittot togs bort under tolkningen.');
    return 'skipped';
  }

  const hasItems = current.itemCount > 0 || countLiveItems(accountId, receiptId) > 0;
  const merge = mergeEnrichment(current, extraction, { info, hasItems });

  if (merge.skipped) {
    jobs.skip(receiptId, `Inget att fylla i (${merge.skipped}).`);
    return 'skipped';
  }

  const now = Date.now();
  const updated: Receipt = {
    ...current,
    ...merge.patch,
    updatedAt: now,
    dirty: 0,
  };

  const records: { kind: 'receipts' | 'items'; record: Receipt | ReceiptItem }[] = [
    { kind: 'receipts', record: updated },
  ];

  if (merge.writeItems) {
    const categories = liveCategoryIds(accountId);
    for (const [index, item] of extraction.items.entries()) {
      records.push({
        kind: 'items',
        record: {
          ...EMPTY_SYNC_META,
          updatedAt: now,
          id: newId(),
          receiptId,
          lineNo: index,
          name: item.name,
          rawName: item.rawName,
          searchName: item.searchName,
          quantity: item.quantity,
          unit: item.unit,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          discount: item.discount,
          vatRate: item.vatRate,
          categoryId: seededCategoryId(item.searchName, categories),
          ean: item.ean,
          deposit: item.deposit,
          isDeposit: item.isDeposit,
          isDiscount: item.isDiscount,
          notes: null,
        } satisfies ReceiptItem,
      });
    }
  }

  writeServerRecords(accountId, records);
  jobs.succeed(receiptId, durationMs);
  return 'extracted';
}

/**
 * Categorises a line, but only into a category that actually exists.
 *
 * The server has no idea what categories a user has invented, but it does know
 * the seeded ones: the client derives their ids deterministically from the
 * slug, so `seed-category-groceries` means the same row on every device. Any
 * other category, or a seeded one the user deleted, is left to the human.
 */
function seededCategoryId(searchName: string, live: Set<string>): string | null {
  const slug = guessCategorySlug(searchName);
  if (!slug) return null;
  const id = `seed-category-${slug}`;
  return live.has(id) ? id : null;
}

/** Ids of the account's non-deleted categories. */
function liveCategoryIds(accountId: string): Set<string> {
  const ids = new Set<string>();
  for (const category of listLiveCategories(accountId)) ids.add(category.id);
  return ids;
}

// --- scheduling -----------------------------------------------------------

/**
 * Starts the periodic pass.
 *
 * The interval lengthens when there is nothing to do, so an idle server is not
 * waking a 4 GB model every minute to look at an empty queue, and shortens
 * again the moment a pass finds work.
 */
export function startWorker(accountId: string, log: (message: string, data?: unknown) => void): void {
  if (!config.llm.enabled || timer) return;

  const stranded = jobs.requeueStranded();
  if (stranded > 0) log(`requeued ${stranded} extraction jobs left running by a previous process`);

  const base = Math.max(10, config.llm.intervalSeconds) * 1000;
  let delay = base;

  const tick = async (): Promise<void> => {
    const report = await runPass(accountId);
    if (report.extracted > 0 || report.failed > 0) {
      log('extraction pass', report);
    }

    // Idle backoff, capped at eight times the configured interval.
    const idle = report.claimed === 0 && report.blocked === null;
    quietPasses = idle ? Math.min(quietPasses + 1, 3) : 0;
    const next = base * 2 ** quietPasses;

    if (next !== delay) {
      delay = next;
      clearInterval(timer);
      timer = setInterval(() => void tick(), delay);
    }
  };

  timer = setInterval(() => void tick(), delay);
  // Do not block startup on the first pass; a model download can take minutes.
  setTimeout(() => void tick(), 5_000);
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
