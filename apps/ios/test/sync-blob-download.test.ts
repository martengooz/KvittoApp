import { describe, expect, test } from '@jest/globals';
import type { Receipt } from '@kvitto/shared/domain';

import type {
  BlobMetadataRecord,
  ImageRole,
  KvittoNativeFacade,
  StoreDownloadedBlobRequest,
} from '../modules/kvitto-native/src';
import { IosDataRepository } from '../src/data/repository';
import { createBlobFilePort, createBlobRoleRegistry, encodeBase64 } from '../src/sync/blob-files';
import { createReceiptImagePlanner } from '../src/sync/image-planner';
import { planBlobDownloads } from '../src/sync/engine';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';

function record(id: string, role: ImageRole): BlobMetadataRecord {
  return {
    uri: `file:///blobs/${id}.jpg`,
    mimeType: 'image/jpeg',
    width: 10,
    height: 20,
    byteSize: 30,
    sha256Id: id,
    role,
    createdAt: 1,
    uploadedAt: 1,
    pendingUpload: false,
    shardPath: `blobs/${id}`,
  };
}

function createNativeStub(present: string[] = []) {
  const stored: StoreDownloadedBlobRequest[] = [];
  const known = new Set(present);
  const native = {
    async getBlobMetadata(id: string) {
      return known.has(id) ? record(id, 'processed') : null;
    },
    async storeDownloadedBlob(request: StoreDownloadedBlobRequest) {
      stored.push(request);
      known.add(request.sha256Id);
      return record(request.sha256Id, request.role);
    },
  } as unknown as KvittoNativeFacade;
  return { native, stored, known };
}

function makeReceipt(overrides: Partial<Receipt>): Receipt {
  return {
    id: 'r1',
    updatedAt: 1000,
    deletedAt: 0,
    rev: 0,
    dirty: 1,
    merchant: {
      name: 'ICA Maxi',
      orgNumber: null,
      vatNumber: null,
      address: null,
      postalCode: null,
      city: null,
      country: null,
      phone: null,
      storeId: null,
    },
    purchasedAt: '2026-02-10T10:00:00.000Z',
    currency: 'SEK',
    total: 100,
    subtotal: null,
    discountTotal: null,
    roundingAmount: null,
    depositTotal: null,
    vatLines: [],
    paymentMethod: null,
    cardLast4: null,
    receiptNumber: null,
    terminalId: null,
    cashier: null,
    categoryId: null,
    companyId: null,
    notes: null,
    source: 'manual',
    imageId: null,
    originalImageId: null,
    thumbId: null,
    status: 'parsed',
    extraction: null,
    ocr: null,
    itemCount: 0,
    ...overrides,
  };
}

describe('base64 encoding for the native bridge', () => {
  test('matches Node for every payload length remainder, including empty', () => {
    const cases = [[], [0], [0, 255], [1, 2, 3], [1, 2, 3, 4], [255, 254, 253, 252, 251]];
    for (const values of cases) {
      const bytes = Uint8Array.from(values);
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  test('matches Node across a long byte range', () => {
    const bytes = Uint8Array.from({ length: 512 }, (_, index) => index % 256);
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('downloaded blob persistence', () => {
  test('hands the bytes to the native store under the role the receipt references', async () => {
    const { native, stored } = createNativeStub();
    const roles = createBlobRoleRegistry();
    roles.remember('thumb-id', 'thumb');
    const port = createBlobFilePort({ native, roles });

    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    await port.writeDownloadedBlob({ id: 'thumb-id', mimeType: 'image/jpeg', bytes });

    expect(stored).toEqual([
      {
        base64: Buffer.from(bytes).toString('base64'),
        mimeType: 'image/jpeg',
        sha256Id: 'thumb-id',
        role: 'thumb',
      },
    ]);
  });

  test('an unknown id falls back to the processed role rather than failing the pull', async () => {
    const { native, stored } = createNativeStub();
    const port = createBlobFilePort({ native, roles: createBlobRoleRegistry() });

    await port.writeDownloadedBlob({ id: 'surprise', mimeType: 'image/png', bytes: Uint8Array.from([9]) });
    expect(stored[0]?.role).toBe('processed');
  });

  test('a native integrity failure propagates instead of being swallowed', async () => {
    const native = {
      async storeDownloadedBlob(): Promise<BlobMetadataRecord> {
        throw new Error('hashMismatch');
      },
    } as unknown as KvittoNativeFacade;
    const port = createBlobFilePort({ native, roles: createBlobRoleRegistry() });

    await expect(
      port.writeDownloadedBlob({ id: 'tampered', mimeType: 'image/jpeg', bytes: Uint8Array.from([7]) }),
    ).rejects.toThrow('hashMismatch');
  });

  test('upload descriptors come from native metadata and missing metadata is reported', async () => {
    const { native } = createNativeStub(['known-id']);
    const port = createBlobFilePort({ native, roles: createBlobRoleRegistry() });

    await expect(port.getUploadDescriptor('known-id')).resolves.toEqual({
      id: 'known-id',
      mimeType: 'image/jpeg',
      filePath: 'file:///blobs/known-id.jpg',
    });
    await expect(port.getUploadDescriptor('missing-id')).rejects.toThrow('Blob metadata is missing');
  });
});

describe('receipt image download planning', () => {
  test('plans thumbnails first, skips blobs already held, and records each role', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    const { native } = createNativeStub(['have-thumb']);
    const roles = createBlobRoleRegistry();

    await repository.upsert(
      'receipts',
      makeReceipt({
        id: 'r1',
        purchasedAt: '2026-02-10T10:00:00.000Z',
        thumbId: 'thumb-1',
        imageId: 'image-1',
        originalImageId: 'original-1',
      }),
    );
    await repository.upsert(
      'receipts',
      makeReceipt({ id: 'r2', purchasedAt: '2026-02-09T10:00:00.000Z', thumbId: 'have-thumb', imageId: 'image-2' }),
    );

    const planner = createReceiptImagePlanner({
      repository,
      roles,
      hasBlob: async (id) => (await native.getBlobMetadata(id)) !== null,
      pageSize: 1,
    });

    const plan = await planBlobDownloads(planner, 2);

    // Thumbnails lead, the already-stored thumbnail is not re-fetched, and the
    // processed images spill into the deferred bucket.
    expect(plan.eagerIds).toEqual(['thumb-1', 'image-1']);
    expect(plan.deferredIds).toEqual(['image-2']);

    expect(roles.roleOf('thumb-1')).toBe('thumb');
    expect(roles.roleOf('image-1')).toBe('processed');
    expect(roles.roleOf('original-1')).toBe('original');
    db.close();
  });

  test('deleted receipts contribute no downloads', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    const { native } = createNativeStub();

    await repository.upsert('receipts', makeReceipt({ id: 'r1', thumbId: 'thumb-1' }));
    await repository.deleteReceipt('r1');

    const planner = createReceiptImagePlanner({
      repository,
      roles: createBlobRoleRegistry(),
      hasBlob: async (id) => (await native.getBlobMetadata(id)) !== null,
    });

    await expect(planBlobDownloads(planner, 5)).resolves.toEqual({ eagerIds: [], deferredIds: [] });
    db.close();
  });

  test('a zero budget plans nothing at all', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await repository.upsert('receipts', makeReceipt({ id: 'r1', thumbId: 'thumb-1' }));

    const planner = createReceiptImagePlanner({
      repository,
      roles: createBlobRoleRegistry(),
      hasBlob: async () => false,
    });

    await expect(planBlobDownloads(planner, 0)).resolves.toEqual({ eagerIds: [], deferredIds: [] });
    db.close();
  });
});
