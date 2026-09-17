import { describe, expect, test } from '@jest/globals';

import { createScanFeatureController, runSourceFirstOcrEnrichment } from '../src/features/scan/controller';
import type {
  ScanControllerOptions,
  ScanJobQueuePort,
  ScanLibraryPort,
  ScanReceiptRepositoryPort,
  ScanStagedDescriptor,
  ScanStagingPort,
} from '../src/features/scan/types';
import type {
  FileBackedDescriptor,
  KvittoNativeFacade,
  RecognizeTextResult,
} from '../modules/kvitto-native/src';
import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';

function source(uri: string): FileBackedDescriptor {
  return {
    uri,
    mimeType: 'image/jpeg',
    width: 1500,
    height: 900,
    byteSize: 3000,
    sha256Id: 'cc'.repeat(32),
    role: 'original',
  };
}

class MemoryStaging implements ScanStagingPort {
  readonly map = new Map<string, ScanStagedDescriptor>();

  async put(descriptor: ScanStagedDescriptor): Promise<void> {
    this.map.set(descriptor.id, descriptor);
  }

  async remove(stageId: string): Promise<void> {
    this.map.delete(stageId);
  }

  async list(): Promise<ScanStagedDescriptor[]> {
    return [...this.map.values()];
  }
}

function makeRecognizeResult(text: string, cancelled = false): RecognizeTextResult {
  return {
    text,
    observations: [{ text: 'obs', confidence: 0.87, boundingBox: { x: 0, y: 0, width: 1, height: 1 } }],
    usedLanguages: ['sv-SE'],
    supportedLanguages: ['sv-SE', 'en-US'],
    cancelled,
    timing: {
      startedAtMs: 1,
      endedAtMs: 3,
      durationMs: 2,
    },
  };
}

function makeNative(options: {
  failProcessedForUris?: Set<string>;
  failStoreForUris?: Set<string>;
  recognizeDelay?: Promise<void>;
} = {}): KvittoNativeFacade {
  return {
    hashFileSha256: async () => 'dd'.repeat(32),
    computeShardPath: async () => 'blobs/dd/dd',
    storeContentAddressedFile: async (input) => {
      if (options.failStoreForUris?.has(input.sourceUri)) {
        throw new Error('store-failed');
      }
      return ({
      uri: input.sourceUri,
      mimeType: input.mimeType,
      width: input.width,
      height: input.height,
      byteSize: input.byteSize,
      sha256Id: input.knownSha256Id ?? 'dd'.repeat(32),
      role: input.role,
      createdAt: 1,
      uploadedAt: null,
      pendingUpload: true,
      shardPath: 'blobs/dd/dd',
      });
    },
    getBlobMetadata: async () => null,
    putBlobMetadata: async (record) => record,
    markBlobUploaded: async () => undefined,
    listBlobMetadataPendingUpload: async () => [],
    deleteBlobMetadata: async () => true,
    resetBlobUploadState: async () => 0,
    storeDownloadedBlob: async () => {
      throw new Error('not used');
    },
    normalizeOrientation: async (uri) => source(uri),
    detectRectangle: async () => null,
    processReceiptImage: async (input) => {
      if (options.failProcessedForUris?.has(input.source.uri)) {
        throw new Error('processing-failed');
      }
      return {
        output: {
          ...source(input.outputUri),
          role: 'processed',
        },
        thumbnail: {
          ...source(input.thumbnailUri),
          role: 'thumb',
        },
        rectangle: {
          topLeft: { x: 0.1, y: 0.1 },
          topRight: { x: 0.9, y: 0.1 },
          bottomRight: { x: 0.9, y: 0.9 },
          bottomLeft: { x: 0.1, y: 0.9 },
        },
        detectionSource: 'vision-rectangle',
        fallbackUsed: false,
        timing: {
          startedAtMs: 1,
          endedAtMs: 2,
          durationMs: 1,
        },
      };
    },
    recognizeText: async () => {
      if (options.recognizeDelay) await options.recognizeDelay;
      return makeRecognizeResult('Datum 2026-09-16\nOrgnr 556123-4567');
    },
    cancelOperation: async () => true,
    analyzeFrameCompact: async () => ({
      status: 'ready',
      pluginLinked: true,
      evidenceScore: 0.8,
      coverage: 0.6,
      normalizedQuad: {
        topLeft: { x: 0.1, y: 0.1 },
        topRight: { x: 0.9, y: 0.1 },
        bottomRight: { x: 0.9, y: 0.9 },
        bottomLeft: { x: 0.1, y: 0.9 },
      },
      source: 'vision-frame-plugin',
      timing: { startedAtMs: 1, endedAtMs: 2, durationMs: 1 },
    }),
  };
}

function buildHarness(native: KvittoNativeFacade, libraryFiles: FileBackedDescriptor[] = []) {
  const repo = new IosDataRepository(new SqliteTestAdapter(), () => Date.now()) as ScanReceiptRepositoryPort;
  const staging = new MemoryStaging();
  const jobs: Array<{ kind: string; receiptId: string }> = [];
  const jobQueue: ScanJobQueuePort = {
    enqueue: async (job) => {
      jobs.push({ kind: job.kind, receiptId: job.receiptId });
    },
  };

  const camera = {
    async requestPermission() { return 'granted' as const; },
    async startPreview() { return; },
    async stopPreview() { return; },
    async captureStill() { return source('file:///tmp/camera.jpg'); },
    async analyzeFrameCompact() {
      return {
        status: 'ready' as const,
        pluginLinked: true,
        evidenceScore: 0.8,
        coverage: 0.55,
        normalizedQuad: {
          topLeft: { x: 0.1, y: 0.1 },
          topRight: { x: 0.9, y: 0.1 },
          bottomRight: { x: 0.9, y: 0.9 },
          bottomLeft: { x: 0.1, y: 0.9 },
        },
        source: 'vision-frame-plugin' as const,
        timing: { startedAtMs: 1, endedAtMs: 2, durationMs: 1 },
      };
    },
  };

  const library: ScanLibraryPort = {
    pickImages: async () => libraryFiles,
  };

  const controller = createScanFeatureController({
    native,
    camera,
    library,
    haptics: { impact: () => {} },
    staging,
    jobs: jobQueue,
    repo,
    paths: {
      tempUri: (kind, stageId) => `file:///tmp/${stageId}-${kind}.jpg`,
    },
    clock: { now: () => 1_000_000 },
    armDelayMs: 0,
  });

  return { controller, repo, staging, jobs };
}

describe('scan-feature workflow', () => {
  test('confirm saves offline and queues jobs without waiting for OCR completion', async () => {
    let release!: () => void;
    const ocrGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const native = makeNative({ recognizeDelay: ocrGate });
    const { controller, repo, jobs } = buildHarness(native);

    await controller.requestPermission();
    await controller.startCapture();
    await controller.manualShutter();

    const receiptId = await controller.confirm();
    const saved = await repo.getReceipt(receiptId);

    expect(saved).not.toBeNull();
    expect(saved?.status).toBe('draft');
    expect(jobs.map((entry) => entry.kind).sort()).toEqual(['image-processing', 'ocr']);

    release();
  });

  test('source-first OCR enrichment is blank-only and stale/cancel safe', async () => {
    const repo = new IosDataRepository(new SqliteTestAdapter(), () => Date.now());
    const created = await repo.createReceipt({
      purchasedAt: null,
      merchant: {
        name: null,
        orgNumber: null,
        vatNumber: null,
        address: null,
        postalCode: null,
        city: null,
        country: null,
        phone: null,
        storeId: null,
      },
      source: 'camera',
    });

    const applied = await runSourceFirstOcrEnrichment({
      nativeRecognize: async () => makeRecognizeResult('Datum 2026-09-16\nOrgnr 556123-4567'),
      repo: {
        getReceipt: (id) => repo.getReceipt(id),
        updateReceipt: (id, patch) => repo.updateReceipt(id, patch),
      },
      receiptId: created.id,
      source: source('file:///tmp/source.jpg'),
      sourceVersion: created.updatedAt,
      now: () => 1_000,
    });

    expect(applied.outcome).toBe('applied');
    expect(applied.filled).toContain('purchasedAt');
    expect(applied.filled).toContain('orgNumber');

    const stale = await runSourceFirstOcrEnrichment({
      nativeRecognize: async () => makeRecognizeResult('Datum 2026-09-16'),
      repo: {
        getReceipt: async () => ({ ...(await repo.getReceipt(created.id))!, updatedAt: created.updatedAt + 1 }),
        updateReceipt: async () => null,
      },
      receiptId: created.id,
      source: source('file:///tmp/source.jpg'),
      sourceVersion: created.updatedAt,
      now: () => 1_001,
    });

    expect(stale.outcome).toBe('stale');

    const cancelled = await runSourceFirstOcrEnrichment({
      nativeRecognize: async () => makeRecognizeResult('ignored', true),
      repo: {
        getReceipt: (id) => repo.getReceipt(id),
        updateReceipt: (id, patch) => repo.updateReceipt(id, patch),
      },
      receiptId: created.id,
      source: source('file:///tmp/source.jpg'),
      sourceVersion: created.updatedAt,
      now: () => 1_002,
      cancellationId: 'cancel-me',
    });

    expect(cancelled.outcome).toBe('cancelled');
  });

  test('photo-library batch reports partial failures and leaves failed stages recoverable', async () => {
    const lib = [
      source('file:///tmp/ok-1.jpg'),
      source('file:///tmp/fail.jpg'),
      source('file:///tmp/ok-2.jpg'),
    ];

    const native = makeNative({
      failStoreForUris: new Set(['file:///tmp/fail.jpg']),
    });

    const { controller, staging } = buildHarness(native, lib);

    const outcome = await controller.importFromLibrary();

    expect(outcome.total).toBe(3);
    expect(outcome.imported).toBe(2);
    expect(outcome.failed).toBe(1);
    expect(outcome.failures[0]?.uri).toBe('file:///tmp/fail.jpg');

    const recoverable = await staging.list();
    expect(recoverable).toHaveLength(1);
    expect(recoverable[0]?.source.uri).toBe('file:///tmp/fail.jpg');
  });
});
