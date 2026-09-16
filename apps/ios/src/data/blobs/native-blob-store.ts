import type { BlobDescriptor } from '@kvitto/client-core';

import { createKvittoNativeFacade, type BlobMetadataRecord, type KvittoNativeFacade } from '../../../modules/kvitto-native/src';
import type { BlobPutInput, NativeBlobStore } from './types';

function toDescriptor(record: BlobMetadataRecord): BlobDescriptor {
  return {
    id: record.sha256Id ?? record.uri,
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
    size: record.byteSize,
    role: record.role,
    createdAt: record.createdAt,
  };
}

export class IosNativeBlobStore implements NativeBlobStore {
  readonly #native: KvittoNativeFacade;

  constructor(native: KvittoNativeFacade = createKvittoNativeFacade()) {
    this.#native = native;
  }

  async putFromFile(input: BlobPutInput): Promise<BlobMetadataRecord> {
    return this.#native.storeContentAddressedFile(input);
  }

  async put(input: Omit<BlobDescriptor, 'createdAt'>): Promise<BlobDescriptor> {
    const record = await this.#native.putBlobMetadata({
      uri: input.id,
      mimeType: input.mimeType,
      width: input.width,
      height: input.height,
      byteSize: input.size,
      sha256Id: input.id,
      role: input.role,
      createdAt: Date.now(),
      uploadedAt: null,
      pendingUpload: true,
      shardPath: await this.#native.computeShardPath(input.id),
    });
    return toDescriptor(record);
  }

  async get(id: string): Promise<BlobDescriptor | null> {
    const result = await this.#native.getBlobMetadata(id);
    return result ? toDescriptor(result) : null;
  }

  async markUploaded(id: string): Promise<void> {
    await this.#native.markBlobUploaded(id);
  }

  async listPendingUpload(limit: number): Promise<BlobDescriptor[]> {
    const rows = await this.#native.listBlobMetadataPendingUpload(limit);
    return rows.map(toDescriptor);
  }

  async deleteMetadata(id: string): Promise<boolean> {
    return this.#native.deleteBlobMetadata(id);
  }
}
