/**
 * Content-addressed image storage.
 *
 * Blobs are keyed by the SHA-256 of their bytes, so re-scanning the same photo
 * costs nothing and the sync layer can ask the server "do you have these
 * digests?" before uploading anything.
 */

import { sha256Hex } from '@kvitto/shared';
import { db, type StoredBlob } from './db.js';

export interface PutBlobOptions {
  role: StoredBlob['role'];
  width?: number | null;
  height?: number | null;
}

/**
 * Stores a blob and returns its digest. Storing the same bytes twice is a
 * no-op that returns the existing id.
 */
export async function putBlob(blob: Blob, options: PutBlobOptions): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const id = await sha256Hex(bytes);

  const existing = await db.blobs.get(id);
  if (existing) return id;

  await db.blobs.put({
    id,
    data: blob,
    mimeType: blob.type || 'application/octet-stream',
    byteSize: blob.size,
    width: options.width ?? null,
    height: options.height ?? null,
    createdAt: Date.now(),
    uploaded: 0,
    role: options.role,
  });
  return id;
}

export async function getBlob(id: string | null | undefined): Promise<StoredBlob | undefined> {
  if (!id) return undefined;
  return db.blobs.get(id);
}

/** Tracks object URLs so views can release them on teardown. */
const urlCache = new Map<string, string>();

/**
 * Returns an object URL for a stored blob, creating it on first use.
 *
 * URLs are cached for the lifetime of the page: receipt images are shown
 * repeatedly (list thumbnail, detail view, review screen) and re-creating the
 * URL each time leaks one per render.
 */
export async function blobUrl(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const cached = urlCache.get(id);
  if (cached) return cached;

  const stored = await db.blobs.get(id);
  if (!stored) return null;

  const url = URL.createObjectURL(stored.data);
  urlCache.set(id, url);
  return url;
}

/** Releases a cached object URL, e.g. after the blob is deleted. */
export function releaseBlobUrl(id: string): void {
  const url = urlCache.get(id);
  if (!url) return;
  URL.revokeObjectURL(url);
  urlCache.delete(id);
}

/**
 * Deletes blobs no receipt refers to any more.
 *
 * Called after a receipt is hard-deleted and on demand from Settings. Returns
 * how many bytes were freed.
 */
export async function collectGarbage(): Promise<{ removed: number; bytes: number }> {
  const referenced = new Set<string>();
  await db.receipts.each((receipt) => {
    if (receipt.imageId) referenced.add(receipt.imageId);
    if (receipt.originalImageId) referenced.add(receipt.originalImageId);
    if (receipt.thumbId) referenced.add(receipt.thumbId);
  });

  let removed = 0;
  let bytes = 0;
  const doomed: string[] = [];
  await db.blobs.each((blob) => {
    if (referenced.has(blob.id)) return;
    doomed.push(blob.id);
    removed += 1;
    bytes += blob.byteSize;
  });

  if (doomed.length > 0) {
    await db.blobs.bulkDelete(doomed);
    for (const id of doomed) releaseBlobUrl(id);
  }
  return { removed, bytes };
}

/**
 * Drops the full-resolution originals of receipts that have already been
 * parsed, keeping the processed scan and the thumbnail. This is the cheapest
 * way to reclaim space, since originals are by far the largest blobs.
 */
export async function discardOriginals(): Promise<{ removed: number; bytes: number }> {
  const receipts = await db.receipts
    .filter((receipt) => receipt.originalImageId !== null && receipt.status !== 'draft')
    .toArray();

  let removed = 0;
  let bytes = 0;
  for (const receipt of receipts) {
    const id = receipt.originalImageId;
    if (!id) continue;
    // Never drop a blob that is doing double duty as the processed image.
    if (id === receipt.imageId || id === receipt.thumbId) continue;

    const stored = await db.blobs.get(id);
    if (stored) {
      await db.blobs.delete(id);
      releaseBlobUrl(id);
      removed += 1;
      bytes += stored.byteSize;
    }
    await db.receipts.update(receipt.id, { originalImageId: null });
  }
  return { removed, bytes };
}

/** Total bytes held in the blob store. */
export async function blobStoreSize(): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  await db.blobs.each((blob) => {
    count += 1;
    bytes += blob.byteSize;
  });
  return { count, bytes };
}
