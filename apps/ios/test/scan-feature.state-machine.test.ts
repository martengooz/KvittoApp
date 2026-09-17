import { describe, expect, test } from '@jest/globals';

import { createScanFeatureController } from '../src/features/scan/controller';
import type {
  ScanCameraPort,
  ScanControllerOptions,
  ScanHapticsPort,
  ScanJobQueuePort,
  ScanLibraryPort,
  ScanPathBuilder,
  ScanPermissionState,
  ScanReceiptRepositoryPort,
  ScanStagingPort,
  ScanStagedDescriptor,
} from '../src/features/scan/types';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';
import { IosDataRepository } from '../src/data/repository';
import type {
  BlobMetadataRecord,
  FileBackedDescriptor,
  FrameAnalysisResult,
  KvittoNativeFacade,
  NormalizedQuad,
  ProcessReceiptImageResult,
  RecognizeTextResult,
} from '../modules/kvitto-native/src';

function descriptor(uri: string, role: 'original' | 'processed' | 'thumb' = 'original'): FileBackedDescriptor {
  return {
    uri,
    mimeType: 'image/jpeg',
    width: 1200,
    height: 800,
    byteSize: 2048,
    sha256Id: 'aa'.repeat(32),
    role,
  };
}

function frame(coverage = 0.5, evidence = 0.7, quad: NormalizedQuad | null = {
  topLeft: { x: 0.1, y: 0.1 },
  topRight: { x: 0.9, y: 0.12 },
  bottomRight: { x: 0.88, y: 0.92 },
  bottomLeft: { x: 0.12, y: 0.9 },
}): FrameAnalysisResult {
  return {
    status: 'ready',
    pluginLinked: true,
    evidenceScore: evidence,
    coverage,
    normalizedQuad: quad,
    source: 'vision-frame-plugin',
    timing: {
      startedAtMs: 1,
      endedAtMs: 4,
      durationMs: 3,
    },
  };
}

class FakeCamera implements ScanCameraPort {
  permission: ScanPermissionState = 'granted';
  frames: FrameAnalysisResult[] = [];
  captures = 0;

  async requestPermission(): Promise<ScanPermissionState> {
    return this.permission;
  }

  async startPreview(): Promise<void> {
    return;
  }

  async stopPreview(): Promise<void> {
    return;
  }

  async captureStill(): Promise<FileBackedDescriptor> {
    this.captures += 1;
    return descriptor(`file:///tmp/capture-${this.captures}.jpg`, 'original');
  }

  async analyzeFrameCompact(): Promise<FrameAnalysisResult> {
    return this.frames.shift() ?? frame();
  }
}

class MemoryStaging implements ScanStagingPort {
  readonly map = new Map<string, ScanStagedDescriptor>();

  async put(input: ScanStagedDescriptor): Promise<void> {
    this.map.set(input.id, input);
  }

  async remove(stageId: string): Promise<void> {
    this.map.delete(stageId);
  }

  async list(): Promise<ScanStagedDescriptor[]> {
    return [...this.map.values()];
  }
}

function makeNative(processImpl?: (input: { forcedQuad?: NormalizedQuad | null }) => ProcessReceiptImageResult): KvittoNativeFacade {
  return {
    hashFileSha256: async () => 'bb'.repeat(32),
    computeShardPath: async (id) => `blobs/${id.slice(0, 2)}`,
    storeContentAddressedFile: async (input) => ({
      uri: input.sourceUri,
      mimeType: input.mimeType,
      width: input.width,
      height: input.height,
      byteSize: input.byteSize,
      sha256Id: input.knownSha256Id ?? 'bb'.repeat(32),
      role: input.role,
      createdAt: 1,
      uploadedAt: null,
      pendingUpload: true,
      shardPath: 'blobs/bb/bb',
    }),
    getBlobMetadata: async () => null,
    putBlobMetadata: async (record) => record,
    markBlobUploaded: async () => undefined,
    listBlobMetadataPendingUpload: async () => [],
    deleteBlobMetadata: async () => true,
    resetBlobUploadState: async () => 0,
    readArchiveIndex: () => Promise.resolve([]),
    extractArchiveEntry: () => Promise.resolve(0),
    isSimulator: () => true,
    logDiagnostic: () => undefined,
    makeScratchFileUri: (prefix: string, extension: string) => `file:///scratch/${prefix}.${extension}`,
    deleteScratchFile: async () => true,
    storeDownloadedBlob: async () => {
      throw new Error('not used');
    },
    normalizeOrientation: async (sourceUri) => descriptor(sourceUri, 'original'),
    detectRectangle: async () => null,
    processReceiptImage: async (input) => {
      if (processImpl) return processImpl({ forcedQuad: input.forcedQuad ?? null });
      return {
        output: descriptor(input.outputUri, 'processed'),
        thumbnail: descriptor(input.thumbnailUri, 'thumb'),
        rectangle: input.forcedQuad ?? {
          topLeft: { x: 0.1, y: 0.1 },
          topRight: { x: 0.9, y: 0.1 },
          bottomRight: { x: 0.9, y: 0.9 },
          bottomLeft: { x: 0.1, y: 0.9 },
        },
        detectionSource: input.forcedQuad ? 'forced-quad' : 'vision-rectangle',
        fallbackUsed: false,
        timing: {
          startedAtMs: 1,
          endedAtMs: 3,
          durationMs: 2,
        },
      };
    },
    recognizeText: async (): Promise<RecognizeTextResult> => ({
      text: 'Datum 2026-09-16\nOrgnr 556123-4567',
      observations: [{ text: 'Datum', confidence: 0.9, boundingBox: { x: 0, y: 0, width: 1, height: 1 } }],
      usedLanguages: ['sv-SE'],
      supportedLanguages: ['sv-SE', 'en-US'],
      cancelled: false,
      timing: {
        startedAtMs: 1,
        endedAtMs: 5,
        durationMs: 4,
      },
    }),
    cancelOperation: async () => true,
    analyzeFrameCompact: async () => frame(),
  };
}

function makeHarness(overrides: Partial<ScanControllerOptions> = {}) {
  const camera = new FakeCamera();
  const staging = new MemoryStaging();
  const jobs: Array<{ kind: string; receiptId: string }> = [];
  const jobQueue: ScanJobQueuePort = {
    enqueue: async (job) => {
      jobs.push({ kind: job.kind, receiptId: job.receiptId });
    },
  };
  const hapticsCalls: string[] = [];
  const haptics: ScanHapticsPort = {
    impact: (kind) => {
      hapticsCalls.push(kind);
    },
  };

  const repo = new IosDataRepository(new SqliteTestAdapter(), () => Date.now()) as ScanReceiptRepositoryPort;
  const library: ScanLibraryPort = { pickImages: async () => [] };
  const paths: ScanPathBuilder = {
    tempUri: (kind, stageId) => `file:///tmp/${stageId}-${kind}.jpg`,
  };

  const clock = { value: 10_000, now() { return this.value; } };

  const controller = createScanFeatureController({
    native: makeNative(),
    camera,
    library,
    haptics,
    staging,
    jobs: jobQueue,
    repo,
    paths,
    clock,
    ...overrides,
  });

  return { controller, camera, staging, jobs, hapticsCalls, clock };
}

describe('scan-feature state machine', () => {
  test('auto-capture arms, holds, stalls, and triggers deterministically', async () => {
    const { controller, camera, clock } = makeHarness({
      armDelayMs: 100,
      stallAfterMs: 250,
      frameCadenceMs: 50,
    });

    await controller.requestPermission();
    await controller.startCapture();

    camera.frames = [frame(), frame(), frame(), frame()];

    clock.value += 40;
    await controller.ingestFrame(clock.value);
    expect(controller.getState().auto).toBe('searching');

    clock.value += 70;
    await controller.ingestFrame(clock.value);
    expect(controller.getState().auto).toBe('searching');

    clock.value += 60;
    await controller.ingestFrame(clock.value);
    expect(controller.getState().auto).toBe('holding');

    clock.value += 60;
    await controller.ingestFrame(clock.value);
    expect(camera.captures).toBe(1);
    expect(controller.getState().stage).toBe('review');

    await controller.startCapture();
    camera.frames = [frame(0.05, 0.2, null), frame(0.05, 0.2, null), frame(0.05, 0.2, null), frame(0.05, 0.2, null)];

    clock.value += 120;
    await controller.ingestFrame(clock.value);
    clock.value += 60;
    await controller.ingestFrame(clock.value);
    clock.value += 60;
    await controller.ingestFrame(clock.value);
    clock.value += 60;
    await controller.ingestFrame(clock.value);
    expect(controller.getState().auto).toBe('stalled');
  });

  test('permission denied keeps manual shutter available and auto off', async () => {
    const camera = new FakeCamera();
    camera.permission = 'denied';
    const { controller } = makeHarness({ camera });

    await controller.requestPermission();
    const snapshot = controller.getState();

    expect(snapshot.permission).toBe('denied');
    expect(snapshot.auto).toBe('off');
    expect(snapshot.manualShutterEnabled).toBe(true);
  });

  test('handles interruption stop and resume', async () => {
    const { controller } = makeHarness({ armDelayMs: 10 });

    await controller.requestPermission();
    await controller.startCapture();
    await controller.onInterruption('backgrounded');
    expect(controller.getState().interruption).toBe('backgrounded');
    expect(controller.getState().auto).toBe('off');

    await controller.onInterruption('resumed');
    expect(controller.getState().interruption).toBe('none');
    expect(controller.getState().auto).toBe('searching');
  });

  test('crop geometry is clamped and rotation reprocesses', async () => {
    const { controller } = makeHarness();

    await controller.requestPermission();
    await controller.startCapture();
    await controller.manualShutter();
    expect(controller.getState().stage).toBe('review');

    await controller.setCrop({
      topLeft: { x: -0.2, y: -0.2 },
      topRight: { x: 1.3, y: -0.1 },
      bottomRight: { x: 1.2, y: 1.4 },
      bottomLeft: { x: -0.1, y: 1.2 },
    });

    const cropped = controller.getState().review;
    expect(cropped?.cropQuad?.topLeft.x).toBe(0);
    expect(cropped?.cropQuad?.bottomRight.x).toBe(1);

    await controller.rotateClockwise();
    expect(controller.getState().review?.rotation).toBe(90);
  });
});
