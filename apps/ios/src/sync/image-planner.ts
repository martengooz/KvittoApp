import type { BlobRoleRegistry } from './blob-files';
import type { ReceiptImageRefs, SyncImagePlannerPort } from './engine';
import type { IosDataRepository, ReceiptListCursor } from '../data/repository';

export interface CreateReceiptImagePlannerInput {
  repository: IosDataRepository;
  hasBlob(id: string): Promise<boolean>;
  roles: BlobRoleRegistry;
  /** Receipts read per page while collecting image references. Default 250. */
  pageSize?: number;
  /** Safety bound on how many receipts one planning pass walks. Default 5000. */
  maxReceipts?: number;
}

/**
 * Collects the image ids live receipts reference, newest receipts first, and
 * records each id's role so a downloaded blob is stored as the thumbnail or
 * processed image the receipt actually points at.
 */
export function createReceiptImagePlanner(input: CreateReceiptImagePlannerInput): SyncImagePlannerPort {
  const pageSize = input.pageSize ?? 250;
  const maxReceipts = input.maxReceipts ?? 5_000;

  return {
    async listReceiptImageRefs(): Promise<ReceiptImageRefs[]> {
      const refs: ReceiptImageRefs[] = [];
      let cursor: ReceiptListCursor | undefined;
      let seen = 0;

      while (seen < maxReceipts) {
        const page = await input.repository.queryReceipts({}, pageSize, cursor);
        for (const receipt of page.items) {
          if (receipt.thumbId) input.roles.remember(receipt.thumbId, 'thumb');
          if (receipt.imageId) input.roles.remember(receipt.imageId, 'processed');
          if (receipt.originalImageId) input.roles.remember(receipt.originalImageId, 'original');
          refs.push({ thumbId: receipt.thumbId, imageId: receipt.imageId });
        }

        seen += page.items.length;
        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
      }

      return refs;
    },

    hasBlob(id: string): Promise<boolean> {
      return input.hasBlob(id);
    },
  };
}
