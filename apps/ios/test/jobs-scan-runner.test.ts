import { describe, expect, test } from '@jest/globals';
import { InMemoryJobStore } from '@kvitto/client-core/fakes';

import type {
  BlobMetadataRecord,
  FileBackedDescriptor,
  KvittoNativeFacade,
  ProcessReceiptImageRequest,
  RecognizeTextRequest,
  RecognizeTextResult,
} from '../modules/kvitto-native/src';
import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';
import { createScanDurableRunOne } from '../src/jobs/scan-runner';
import { createRepositoryBackedJobStore } from '../src/jobs/store';
import { createScanDurableJobService } from '../src/jobs/service';

function blobRecord(input: {
  id: string;
  uri: string;
  role: 'original' | 'processed' | 'thumb';
  width?: number;
  height?: number;
  size?: number;
}): BlobMetadataRecord {
  return {
    uri: input.uri,
    mimeType: 'image/jpeg',
    width: input.width ?? 1000,
    height: input.height ?? 600,
    byteSize: input.size ?? 2_000,
    sha256Id: input.id,
    role: input.role,
    createdAt: 1,
    uploadedAt: null,
    pendingUpload: true,
    shardPath: `blobs/${input.id.slice(0, 2)}/${input.id.slice(2, 4)}/${input.id}`,
  };
}

function ocrResult(text: string, cancelled = false): RecognizeTextResult {
  return {
    text,
    observations: [{ text, confidence: 0.9, boundingBox: { x: 0, y: 0, width: 1, height: 1 } }],
    usedLanguages: ['sv-SE'],
    supportedLanguages: ['sv-SE', 'en-US'],
    cancelled,
    timing: {
      startedAtMs: 1,
      endedAtMs: 2,
      durationMs: 1,
    },
  };
}

class NativeStub implements KvittoNativeFacade {
  readonly metadata = new Map<string, BlobMetadataRecord>();
  readonly recognizeCalls: RecognizeTextRequest[] = [];
  readonly processCalls: ProcessReceiptImageRequest[] = [];
  readonly cancelledOperationIds: string[] = [];
  readonly storedFiles: Array<{ sourceUri: string; role: 'original' | 'processed' | 'thumb' }> = [];

  recognizeImpl: (input: RecognizeTextRequest) => Promise<RecognizeTextResult> = async () => ocrResult('');

  async hashFileSha256(fileUri: string): Promise<string> {
    return fileUri;
  }

  async computeShardPath(sha256Id: string): Promise<string> {
    return `blobs/${sha256Id.slice(0, 2)}/${sha256Id.slice(2, 4)}/${sha256Id}`;
  }

  async storeContentAddressedFile(request: {
    sourceUri: string;
    mimeType: string;
    width: number;
    height: number;
    byteSize: number;
    role: 'original' | 'processed' | 'thumb';
    knownSha256Id?: string;
  }): Promise<BlobMetadataRecord> {
    const id = request.knownSha256Id ?? `${request.role}-${this.storedFiles.length + 1}`;
    const record = blobRecord({
      id,
      uri: request.sourceUri,
      role: request.role,
      width: request.width,
      height: request.height,
      size: request.byteSize,
    });
    this.metadata.set(id, record);
    this.storedFiles.push({ sourceUri: request.sourceUri, role: request.role });
    return record;
  }

  async getBlobMetadata(sha256Id: string): Promise<BlobMetadataRecord | null> {
    return this.metadata.get(sha256Id) ?? null;
  }

  async putBlobMetadata(record: BlobMetadataRecord): Promise<BlobMetadataRecord> {
    this.metadata.set(record.sha256Id ?? record.uri, record);
    return record;
  }

  async markBlobUploaded(): Promise<void> {
    return;
  }

  async listBlobMetadataPendingUpload(limit: number): Promise<BlobMetadataRecord[]> {
    return [...this.metadata.values()].slice(0, limit);
  }

  async deleteBlobMetadata(sha256Id: string): Promise<boolean> {
    return this.metadata.delete(sha256Id);
  }

  async resetBlobUploadState(): Promise<number> {
    return 0;
  }

  async storeDownloadedBlob(): Promise<BlobMetadataRecord> {
    throw new Error('not used');
  }

  async normalizeOrientation(sourceUri: string): Promise<FileBackedDescriptor> {
    return {
      uri: sourceUri,
      mimeType: 'image/jpeg',
      width: 1000,
      height: 600,
      byteSize: 2000,
      sha256Id: null,
      role: 'original',
    };
  }

  async detectRectangle(): Promise<null> {
    return null;
  }

  async processReceiptImage(input: ProcessReceiptImageRequest) {
    this.processCalls.push(input);
    return {
      output: {
        uri: input.outputUri,
        mimeType: 'image/jpeg',
        width: 1200,
        height: 800,
        byteSize: 3000,
        sha256Id: 'processed-sha',
        role: 'processed' as const,
      },
      thumbnail: {
        uri: input.thumbnailUri,
        mimeType: 'image/jpeg',
        width: 300,
        height: 200,
        byteSize: 800,
        sha256Id: 'thumb-sha',
        role: 'thumb' as const,
      },
      rectangle: null,
      detectionSource: 'fallback-full-frame' as const,
      fallbackUsed: true,
      timing: {
        startedAtMs: 1,
        endedAtMs: 2,
        durationMs: 1,
      },
    };
  }

  async recognizeText(input: RecognizeTextRequest): Promise<RecognizeTextResult> {
    this.recognizeCalls.push(input);
    return this.recognizeImpl(input);
  }

  async cancelOperation(cancellationId: string): Promise<boolean> {
    this.cancelledOperationIds.push(cancellationId);
    return true;
  }

  async analyzeFrameCompact(): Promise<never> {
    throw new Error('not needed in job runner tests');
  }
}

async function enqueueScanJob(store: InMemoryJobStore, input: {
  id: string;
  kind: 'scan:ocr' | 'scan:image-processing';
  receiptId: string;
  sourceVersion: number;
}): Promise<void> {
  await store.enqueue({
    id: input.id,
    kind: input.kind,
    sourceKind: 'receipt',
    sourceId: input.receiptId,
    sourceUpdatedAt: input.sourceVersion,
    priority: 200,
    nextAttemptAt: 1_000,
    maxAttempts: 4,
  });
}

describe('scan durable runOne handlers', () => {
  test('OCR reads original/source metadata descriptor and keeps non-blank user fields', async () => {
    let now = 5_000;
    const repo = new IosDataRepository(new SqliteTestAdapter(), () => now);
    const native = new NativeStub();

    native.metadata.set('orig-1', blobRecord({
      id: 'orig-1',
      uri: 'file:///tmp/original-source.jpg',
      role: 'original',
    }));
    native.recognizeImpl = async () => ocrResult('Datum 2026-09-16\nOrgnr 559999-0000');

    const created = await repo.createReceipt({
      originalImageId: 'orig-1',
      imageId: 'processed-old',
      thumbId: 'thumb-old',
      purchasedAt: null,
      merchant: {
        name: null,
        orgNumber: '556111-2222',
        vatNumber: null,
        address: null,
        postalCode: null,
        city: null,
        country: null,
        phone: null,
        storeId: null,
      },
    });

    const store = new InMemoryJobStore();
    await enqueueScanJob(store, {
      id: 'job-ocr-1',
      kind: 'scan:ocr',
      receiptId: created.id,
      sourceVersion: created.updatedAt,
    });

    const runOne = createScanDurableRunOne({
      store,
      repository: repo,
      native,
      clock: { now: () => now },
      leaseMs: 2_000,
    });

    now = 6_000;
    const result = await runOne();
    expect(result).toBe('done');

    expect(native.recognizeCalls).toHaveLength(1);
    expect(native.recognizeCalls[0]?.source.uri).toBe('file:///tmp/original-source.jpg');
    expect(native.recognizeCalls[0]?.cancellationId).toContain('job-ocr-1:1:');

    const updated = await repo.getReceipt(created.id);
    expect(updated?.purchasedAt).not.toBeNull();
    expect(updated?.merchant.orgNumber).toBe('556111-2222');
  });

  test('OCR missing original metadata retries with explicit error', async () => {
    const repo = new IosDataRepository(new SqliteTestAdapter(), () => 10_000);
    const native = new NativeStub();
    const created = await repo.createReceipt({
      originalImageId: 'missing-orig-id',
    });

    const store = new InMemoryJobStore();
    await enqueueScanJob(store, {
      id: 'job-ocr-missing',
      kind: 'scan:ocr',
      receiptId: created.id,
      sourceVersion: created.updatedAt,
    });

    const runOne = createScanDurableRunOne({
      store,
      repository: repo,
      native,
      clock: { now: () => 10_000 },
      leaseMs: 2_000,
    });

    const result = await runOne();
    expect(result).toBe('retry');

    const row = await store.get('job-ocr-missing');
    expect(row?.state).toBe('failed');
    expect(row?.lastError).toContain('missing-original-image-metadata:missing-orig-id');
  });

  test('OCR cancellation requests cancel the in-flight native operation', async () => {
    let now = 20_000;
    const repo = new IosDataRepository(new SqliteTestAdapter(), () => now);
    const native = new NativeStub();

    native.metadata.set('orig-cancel', blobRecord({
      id: 'orig-cancel',
      uri: 'file:///tmp/original-cancel.jpg',
      role: 'original',
    }));

    let resolveRecognize!: () => void;
    const recognizeStarted = new Promise<void>((resolve) => {
      native.recognizeImpl = async () => {
        resolve();
        await new Promise<void>((resume) => {
          resolveRecognize = resume;
        });
        return ocrResult('', true);
      };
    });

    const created = await repo.createReceipt({
      originalImageId: 'orig-cancel',
    });

    const store = new InMemoryJobStore();
    await enqueueScanJob(store, {
      id: 'job-ocr-cancel',
      kind: 'scan:ocr',
      receiptId: created.id,
      sourceVersion: created.updatedAt,
    });

    const runOne = createScanDurableRunOne({
      store,
      repository: repo,
      native,
      clock: { now: () => now },
      leaseMs: 2_000,
    });

    const running = runOne();
    await recognizeStarted;

    now = 20_050;
    await store.requestCancel('job-ocr-cancel', now);
    await new Promise((resolve) => setTimeout(resolve, 50));
    resolveRecognize();

    const result = await running;
    expect(result).toBe('cancelled');
    expect(native.cancelledOperationIds[0]).toContain('job-ocr-cancel:1:');
  });

  test('image-processing is idempotent when processed and thumb metadata already exist', async () => {
    const repo = new IosDataRepository(new SqliteTestAdapter(), () => 30_000);
    const native = new NativeStub();

    native.metadata.set('processed-existing', blobRecord({
      id: 'processed-existing',
      uri: 'file:///tmp/processed-existing.jpg',
      role: 'processed',
    }));
    native.metadata.set('thumb-existing', blobRecord({
      id: 'thumb-existing',
      uri: 'file:///tmp/thumb-existing.jpg',
      role: 'thumb',
      width: 250,
      height: 150,
    }));

    const created = await repo.createReceipt({
      originalImageId: 'orig-existing',
      imageId: 'processed-existing',
      thumbId: 'thumb-existing',
    });

    const store = new InMemoryJobStore();
    await enqueueScanJob(store, {
      id: 'job-image-idempotent',
      kind: 'scan:image-processing',
      receiptId: created.id,
      sourceVersion: created.updatedAt,
    });

    const runOne = createScanDurableRunOne({
      store,
      repository: repo,
      native,
      clock: { now: () => 30_000 },
      leaseMs: 2_000,
    });

    const result = await runOne();
    expect(result).toBe('done');
    expect(native.processCalls).toHaveLength(0);
  });

  test('image-processing stale source is suppressed before native processing runs', async () => {
    let now = 40_000;
    const repo = new IosDataRepository(new SqliteTestAdapter(), () => now);
    const native = new NativeStub();

    native.metadata.set('orig-stale', blobRecord({
      id: 'orig-stale',
      uri: 'file:///tmp/original-stale.jpg',
      role: 'original',
    }));

    const created = await repo.createReceipt({
      originalImageId: 'orig-stale',
    });

    const store = new InMemoryJobStore();
    await enqueueScanJob(store, {
      id: 'job-image-stale',
      kind: 'scan:image-processing',
      receiptId: created.id,
      sourceVersion: created.updatedAt,
    });

    now = 40_100;
    await repo.updateReceipt(created.id, { notes: 'manual edit' });

    const runOne = createScanDurableRunOne({
      store,
      repository: repo,
      native,
      clock: { now: () => now },
      leaseMs: 2_000,
    });

    const result = await runOne();
    expect(result).toBe('stale_source');
    expect(native.processCalls).toHaveLength(0);
  });

  test('foreground drain reports processed when real handlers complete queued jobs', async () => {
    let now = 50_000;
    const repository = new IosDataRepository(new SqliteTestAdapter(), () => now);
    const native = new NativeStub();

    native.metadata.set('orig-drain', blobRecord({
      id: 'orig-drain',
      uri: 'file:///tmp/original-drain.jpg',
      role: 'original',
    }));
    native.recognizeImpl = async () => ocrResult('Datum 2026-09-16');

    const receipt = await repository.createReceipt({
      originalImageId: 'orig-drain',
    });

    const store = createRepositoryBackedJobStore({
      repository,
      clock: { now: () => now },
    });

    const runOne = createScanDurableRunOne({
      store,
      repository,
      native,
      clock: { now: () => now },
      leaseMs: 2_000,
    });

    const service = createScanDurableJobService({
      store,
      clock: { now: () => now },
      idFactory: () => 'drain-job',
      runOne,
    });

    await service.enqueue({
      kind: 'ocr',
      receiptId: receipt.id,
      sourceVersion: receipt.updatedAt,
      sourceImageId: receipt.originalImageId,
    });

    now = 50_100;
    const outcome = await service.drainForeground(5);
    expect(outcome.outcome).toBe('processed');
    expect(outcome.pendingJobs).toBe(0);
    expect(outcome.summary?.processed).toBeGreaterThan(0);

    const row = await store.get('drain-job');
    expect(row?.state).toBe('done');
  });
});
