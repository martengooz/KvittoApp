import { describe, expect, test } from '@jest/globals';

import {
  createKvittoNativeFacade,
  type BlobMetadataRecord,
  type FrameAnalysisResult,
  type KvittoNativeBinding,
} from '../modules/kvitto-native/src';

function makeBlobRecord(id: string): BlobMetadataRecord {
  return {
    uri: 'file:///tmp/' + id,
    mimeType: 'image/jpeg',
    width: 1200,
    height: 800,
    byteSize: 1234,
    sha256Id: id,
    role: 'processed',
    createdAt: 10,
    uploadedAt: null,
    pendingUpload: true,
    shardPath: 'blobs/' + id.slice(0, 2) + '/' + id.slice(2, 4) + '/' + id,
  };
}

function makeFrame(pluginLinked: boolean): FrameAnalysisResult {
  return {
    status: pluginLinked ? 'ready' : 'unsupported',
    pluginLinked,
    evidenceScore: pluginLinked ? 0.9 : 0,
    coverage: pluginLinked ? 0.62 : 0,
    normalizedQuad: null,
    source: pluginLinked ? 'vision-frame-plugin' : 'stub',
    timing: {
      startedAtMs: 100,
      endedAtMs: 140,
      durationMs: 40,
    },
  };
}

function createBinding(): KvittoNativeBinding {
  const record = makeBlobRecord('aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899');
  return {
    hashFileSha256: async () => record.sha256Id ?? '',
    computeBlobShardPath: async (id) => 'blobs/' + id.slice(0, 2) + '/' + id.slice(2, 4) + '/' + id,
    storeContentAddressedFile: async () => record,
    getBlobMetadata: async () => record,
    putBlobMetadata: async (next) => next,
    markBlobUploaded: async () => undefined,
    listBlobMetadataPendingUpload: async () => [record],
    deleteBlobMetadata: async () => true,
    resetBlobUploadState: async () => 0,
  isSimulator: () => true,
  logDiagnostic: () => undefined,
    makeScratchFileUri: (prefix: string, extension: string) => `file:///scratch/${prefix}.${extension}`,
    deleteScratchFile: async () => true,
    storeDownloadedBlob: async () => {
      throw new Error('not used');
    },
    normalizeOrientation: async () => ({
      uri: 'file:///tmp/normalized.jpg',
      mimeType: 'image/jpeg',
      width: 100,
      height: 50,
      byteSize: 80,
      sha256Id: record.sha256Id,
      role: 'processed',
    }),
    detectRectangle: async () => null,
    processReceiptImage: async (input) => ({
      output: {
        uri: input.outputUri,
        mimeType: 'image/jpeg',
        width: 320,
        height: 240,
        byteSize: 500,
        sha256Id: record.sha256Id,
        role: 'processed',
      },
      thumbnail: {
        uri: input.thumbnailUri,
        mimeType: 'image/jpeg',
        width: 120,
        height: 90,
        byteSize: 120,
        sha256Id: record.sha256Id,
        role: 'thumb',
      },
      rectangle: null,
      detectionSource: 'fallback-full-frame',
      fallbackUsed: true,
      timing: {
        startedAtMs: 1,
        endedAtMs: 3,
        durationMs: 2,
      },
    }),
    recognizeText: async () => ({
      text: 'ICA Maxi',
      observations: [],
      usedLanguages: ['sv-SE', 'en-US'],
      supportedLanguages: ['en-US', 'sv-SE'],
      cancelled: false,
      timing: {
        startedAtMs: 1,
        endedAtMs: 2,
        durationMs: 1,
      },
    }),
    cancelOperation: async () => true,
    analyzeFrameCompact: async () => makeFrame(false),
  };
}

describe('Packet 6 kvitto-native facade', () => {
  test('compacts frame metadata and preserves duration', () => {
    const facade = createKvittoNativeFacade(createBinding());
    const compact = facade.compactFrameMetadata(makeFrame(true));

    expect(compact.status).toBe('ready');
    expect(compact.pluginLinked).toBe(true);
    expect(compact.durationMs).toBe(40);
  });

  test('returns explicit unsupported frame status when plugin is not linked', async () => {
    const facade = createKvittoNativeFacade(createBinding());
    const result = await facade.analyzeFrameCompact(123);

    expect(result.pluginLinked).toBe(false);
    expect(result.status).toBe('unsupported');
    expect(result.source).toBe('stub');
  });

  test('bridges blob metadata operations with file-backed descriptors', async () => {
    const facade = createKvittoNativeFacade(createBinding());
    const list = await facade.listBlobMetadataPendingUpload(10);

    expect(list).toHaveLength(1);
    expect(list[0]?.sha256Id).toMatch(/^[a-f0-9]{64}$/);
  });
});
