import type { BlobStorePort } from '@kvitto/client-core';

import type { BlobMetadataRecord, StoreBlobRequest } from '../../../modules/kvitto-native/src';

export type NativeBlobRecord = BlobMetadataRecord;

export interface BlobPutInput extends StoreBlobRequest {}

export interface NativeBlobStore extends BlobStorePort {
  putFromFile(input: BlobPutInput): Promise<NativeBlobRecord>;
  deleteMetadata(id: string): Promise<boolean>;
}
