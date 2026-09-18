import { exponentialBackoffMs, runOneDurableJobStrictDispatch } from '@kvitto/client-core/jobs';
import type { JobStorePort, Logger } from '@kvitto/client-core/ports';

import type { BlobMetadataRecord, FileBackedDescriptor, KvittoNativeFacade } from '../../modules/kvitto-native/src';
import { IosNativeBlobStore } from '../data/blobs/native-blob-store';
import type { IosDataRepository } from '../data/repository';
import { runSourceFirstOcrEnrichment, type CompanyEnricher } from '../features/scan/controller';
import type { ForegroundRunResult } from './foreground-runner';

const SCAN_IMAGE_PROCESSING_KIND = 'scan:image-processing';
const SCAN_OCR_KIND = 'scan:ocr';
const SCAN_EXTRACTION_KIND = 'scan:extraction';

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface ScanDurableRunnerClock {
  now(): number;
}

/**
 * Runs an AI extraction for one receipt. Supplied by the composition, which
 * owns provider selection and credentials; absent when AI is turned off, and
 * then extraction jobs report `unsupported` instead of failing.
 */
export type ScanExtractionRunner = (input: {
  receiptId: string;
  sourceVersion: number;
  signal?: AbortSignal;
}) => Promise<'applied' | 'stale' | 'unsupported'>;

export interface ScanDurableRunOneOptions {
  store: JobStorePort;
  repository: IosDataRepository;
  native: KvittoNativeFacade;
  blobStore?: IosNativeBlobStore;
  clock?: ScanDurableRunnerClock;
  logger?: Logger;
  leaseMs?: number;
  runExtraction?: ScanExtractionRunner;
  /**
   * Links a scanned receipt to a company in the registry, after OCR. Absent
   * when company lookup is not configured; OCR then files what it read and
   * stops.
   */
  enrichCompany?: CompanyEnricher;
}

function toDescriptor(record: BlobMetadataRecord): FileBackedDescriptor {
  return {
    uri: record.uri,
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
    byteSize: record.byteSize,
    sha256Id: record.sha256Id,
    role: record.role,
  };
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function deterministicTempUri(jobId: string, sourceVersion: number, role: 'processed' | 'thumb'): string {
  const safeId = sanitizePathPart(jobId);
  return `file:///tmp/kvitto-durable-${safeId}-${sourceVersion}-${role}.jpg`;
}

async function runWithCancellationMonitor<T>(
  cancellationId: string,
  isCancelled: () => Promise<boolean>,
  cancelNative: (id: string) => Promise<boolean>,
  work: () => Promise<T>,
): Promise<T> {
  let active = true;
  let cancellationSent = false;
  const timer = setInterval(() => {
    void (async () => {
      if (!active || cancellationSent) return;
      const cancelled = await isCancelled();
      if (!cancelled) return;
      cancellationSent = true;
      try {
        await cancelNative(cancellationId);
      } finally {
        cancellationSent = false;
      }
    })();
  }, 25);

  try {
    if (await isCancelled()) {
      await cancelNative(cancellationId);
    }
    return await work();
  } finally {
    active = false;
    clearInterval(timer);
  }
}

async function hasValidProcessedBlobs(native: KvittoNativeFacade, receipt: Awaited<ReturnType<IosDataRepository['getReceipt']>>): Promise<boolean> {
  if (!receipt?.imageId || !receipt.thumbId) return false;
  const [processed, thumb] = await Promise.all([
    native.getBlobMetadata(receipt.imageId),
    native.getBlobMetadata(receipt.thumbId),
  ]);
  return Boolean(processed && thumb);
}

export function createScanDurableRunOne(options: ScanDurableRunOneOptions): () => Promise<ForegroundRunResult> {
  const blobStore = options.blobStore ?? new IosNativeBlobStore(options.native);
  const clock = options.clock ?? { now: () => Date.now() };
  const logger = options.logger ?? NOOP_LOGGER;
  const leaseMs = options.leaseMs ?? 20_000;

  return async () => runOneDurableJobStrictDispatch(
    {
      jobs: options.store,
      repo: options.repository,
      clock,
      scheduler: {
        delayMs(attempt) {
          return exponentialBackoffMs(attempt, 1_000, 60_000);
        },
      },
      logger,
    },
    {
      leaseMs,
      handlers: {
        [SCAN_OCR_KIND]: async (context) => {
          const job = await options.store.get(context.claim.id);
          const sourceId = job?.sourceId;
          if (!sourceId) {
            throw new Error(`missing-receipt-id-for-job:${context.claim.id}`);
          }
          const current = await options.repository.getReceipt(sourceId);
          if (!current) {
            throw new Error(`missing-receipt:${sourceId}`);
          }

          if (!current.originalImageId) {
            throw new Error(`missing-original-image-id:${sourceId}`);
          }

          const sourceMetadata = await options.native.getBlobMetadata(current.originalImageId);
          if (!sourceMetadata) {
            throw new Error(`missing-original-image-metadata:${current.originalImageId}`);
          }

          const ocrOutcome = await runWithCancellationMonitor(
            context.claim.claimToken,
            () => context.isCancelled(),
            (id) => options.native.cancelOperation(id),
            () => runSourceFirstOcrEnrichment({
              nativeRecognize: (input) => options.native.recognizeText(input),
              repo: {
                getReceipt: (id) => options.repository.getReceipt(id),
                updateReceipt: (id, patch) => options.repository.updateReceipt(id, patch),
              },
              receiptId: sourceId,
              source: toDescriptor(sourceMetadata),
              sourceVersion: context.claim.sourceVersion,
              now: () => clock.now(),
              cancellationId: context.claim.claimToken,
              enrichCompany: options.enrichCompany,
            }),
          );

          if (ocrOutcome.outcome === 'cancelled') {
            return {
              sourceVersion: context.claim.sourceVersion,
            };
          }

          const latest = await options.repository.getReceipt(sourceId);
          return {
            sourceVersion: latest?.updatedAt,
          };
        },
        [SCAN_EXTRACTION_KIND]: async (context) => {
          const job = await options.store.get(context.claim.id);
          const sourceId = job?.sourceId;
          if (!sourceId) {
            throw new Error(`missing-receipt-id-for-job:${context.claim.id}`);
          }

          const receipt = await options.repository.getReceipt(sourceId);
          if (!receipt) {
            throw new Error(`missing-receipt:${sourceId}`);
          }

          if (!options.runExtraction) {
            // AI is off, or no provider is configured. Nothing to retry, so
            // the job settles instead of failing for its whole attempt budget.
            logger.info?.('extraction skipped: no runner configured', { receiptId: sourceId });
            return { sourceVersion: receipt.updatedAt };
          }

          const outcome = await options.runExtraction({
            receiptId: sourceId,
            sourceVersion: context.claim.sourceVersion,
          });

          if (outcome === 'stale') {
            // A newer version of the source exists; the job for that version
            // will do the work, so this one must not overwrite it.
            return { sourceVersion: context.claim.sourceVersion };
          }

          const latest = await options.repository.getReceipt(sourceId);
          return { sourceVersion: latest?.updatedAt };
        },
        [SCAN_IMAGE_PROCESSING_KIND]: async (context) => {
          const job = await options.store.get(context.claim.id);
          const sourceId = job?.sourceId;
          if (!sourceId) {
            throw new Error(`missing-receipt-id-for-job:${context.claim.id}`);
          }

          const receipt = await options.repository.getReceipt(sourceId);
          if (!receipt) {
            throw new Error(`missing-receipt:${sourceId}`);
          }

          if (await hasValidProcessedBlobs(options.native, receipt)) {
            return {
              sourceVersion: receipt.updatedAt,
            };
          }

          if (!receipt.originalImageId) {
            throw new Error(`missing-original-image-id:${sourceId}`);
          }

          const sourceMetadata = await options.native.getBlobMetadata(receipt.originalImageId);
          if (!sourceMetadata) {
            throw new Error(`missing-original-image-metadata:${receipt.originalImageId}`);
          }

          const processed = await runWithCancellationMonitor(
            context.claim.claimToken,
            () => context.isCancelled(),
            (id) => options.native.cancelOperation(id),
            () => options.native.processReceiptImage({
              source: toDescriptor(sourceMetadata),
              outputUri: deterministicTempUri(context.claim.id, context.claim.sourceVersion, 'processed'),
              thumbnailUri: deterministicTempUri(context.claim.id, context.claim.sourceVersion, 'thumb'),
              maxLongEdge: 1568,
              jpegQuality: 0.9,
              enhancement: 'grayscale',
              cancellationId: context.claim.claimToken,
            }),
          );

          const processedStored = await blobStore.putFromFile({
            sourceUri: processed.output.uri,
            mimeType: processed.output.mimeType,
            width: processed.output.width,
            height: processed.output.height,
            byteSize: processed.output.byteSize,
            role: 'processed',
            knownSha256Id: processed.output.sha256Id ?? undefined,
          });

          const thumbStored = await blobStore.putFromFile({
            sourceUri: processed.thumbnail.uri,
            mimeType: processed.thumbnail.mimeType,
            width: processed.thumbnail.width,
            height: processed.thumbnail.height,
            byteSize: processed.thumbnail.byteSize,
            role: 'thumb',
            knownSha256Id: processed.thumbnail.sha256Id ?? undefined,
          });

          const latest = await options.repository.getReceipt(sourceId);
          if (!latest) {
            return {
              sourceVersion: undefined,
            };
          }

          if (latest.updatedAt !== context.claim.sourceVersion) {
            return {
              sourceVersion: latest.updatedAt,
            };
          }

          const updated = await options.repository.updateReceipt(sourceId, {
            imageId: processedStored.sha256Id,
            thumbId: thumbStored.sha256Id,
          });

          return {
            sourceVersion: updated?.updatedAt,
          };
        },
      },
      onUnsupportedKind: 'cancel',
    },
  );
}
