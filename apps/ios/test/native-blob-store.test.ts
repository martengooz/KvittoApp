import { describe, expect, test } from '@jest/globals';

import { IosNativeBlobStore } from '../src/data/blobs';
import type { BlobMetadataRecord, KvittoNativeFacade } from '../modules/kvitto-native/src';

const blobId = 'ffeeddccbbaa00998877665544332211ffeeddccbbaa00998877665544332211';

function makeRecord(overrides: Partial<BlobMetadataRecord> = {}): BlobMetadataRecord {
  return {
    uri: 'file:///tmp/blob.bin',
    mimeType: 'image/jpeg',
    width: 10,
    height: 20,
    byteSize: 30,
    sha256Id: blobId,
    role: 'processed',
    createdAt: 10,
    uploadedAt: null,
    pendingUpload: true,
    shardPath: 'blobs/ff/ee/' + blobId,
    ...overrides,
  };
}

function nativeMock(): KvittoNativeFacade {
  let stored = makeRecord();
  return {
    hashFileSha256: async () => blobId,
    computeShardPath: async () => 'blobs/ff/ee/' + blobId,
    storeContentAddressedFile: async () => stored,
    getBlobMetadata: async () => stored,
    putBlobMetadata: async (record) => {
      stored = record;
      return stored;
    },
    markBlobUploaded: async () => {
      stored = { ...stored, pendingUpload: false, uploadedAt: 20 };
    },
    listBlobMetadataPendingUpload: async () => (stored.pendingUpload ? [stored] : []),
    deleteBlobMetadata: async () => true,
    resetBlobUploadState: async () => 0,
    isSimulator: () => true,
    logDiagnostic: () => undefined,
    makeScratchFileUri: (prefix: string, extension: string) => `file:///scratch/${prefix}.${extension}`,
    deleteScratchFile: async () => true,
    storeDownloadedBlob: async () => {
      throw new Error('not used');
    },
    normalizeOrientation: async () => stored,
    detectRectangle: async () => null,
    processReceiptImage: async () => {
      throw new Error('not used');
    },
    recognizeText: async () => {
      throw new Error('not used');
    },
    cancelOperation: async () => true,
    analyzeFrameCompact: async () => {
      throw new Error('not used');
    },
  };
}

describe('Packet 4 iOS native blob store facade', () => {
  test('stores metadata and lists pending uploads', async () => {
    const store = new IosNativeBlobStore(nativeMock());
    const saved = await store.put({
      id: blobId,
      mimeType: 'image/jpeg',
      width: 100,
      height: 200,
      size: 300,
      role: 'processed',
    });

    expect(saved.id).toBe(blobId);

    const pending = await store.listPendingUpload(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(blobId);
  });

  test('marks upload completion', async () => {
    const store = new IosNativeBlobStore(nativeMock());
    await store.markUploaded(blobId);

    const pending = await store.listPendingUpload(10);
    expect(pending).toEqual([]);
  });
});
