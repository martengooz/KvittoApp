/**
 * Content-addressed blob storage on the filesystem.
 *
 * Images go on disk rather than into SQLite: they are large, immutable and
 * never queried, and keeping them out of the database keeps the WAL small and
 * makes backups a plain file copy.
 *
 * Files are sharded two levels deep by the first four hex characters of the
 * digest, so no single directory ends up with tens of thousands of entries.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { config } from './env.ts';

const HEX_64 = /^[0-9a-f]{64}$/;

export function isValidBlobId(id: string): boolean {
  return HEX_64.test(id);
}

/**
 * Resolves a digest to its path on disk.
 *
 * The digest is validated first: it is attacker-supplied and goes straight into
 * a filesystem path, so anything but 64 lowercase hex characters is rejected
 * rather than sanitised.
 */
export function blobPath(id: string): string {
  if (!isValidBlobId(id)) throw new Error(`Invalid blob id: ${id}`);
  return join(config.blobDir, id.slice(0, 2), id.slice(2, 4), id);
}

export function blobExists(id: string): boolean {
  if (!isValidBlobId(id)) return false;
  return existsSync(blobPath(id));
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface StoreResult {
  ok: boolean;
  /** Set when the supplied digest does not match the bytes. */
  mismatch?: { expected: string; actual: string };
}

/**
 * Writes a blob, verifying that its contents hash to the claimed id.
 *
 * The check is the whole point of content addressing: without it a client
 * could overwrite one image's bytes under another's digest, and every device
 * that later pulled that digest would get the wrong picture.
 */
export async function storeBlob(id: string, data: Buffer): Promise<StoreResult> {
  if (!isValidBlobId(id)) return { ok: false };

  const actual = sha256(data);
  if (actual !== id) return { ok: false, mismatch: { expected: id, actual } };

  const target = blobPath(id);
  if (existsSync(target)) return { ok: true };

  await mkdir(join(config.blobDir, id.slice(0, 2), id.slice(2, 4)), { recursive: true });

  // Write to a temporary name and rename into place, so a crash mid-write
  // cannot leave a truncated file that later reads would trust.
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, target);
  return { ok: true };
}

export async function readBlob(id: string): Promise<Buffer | null> {
  if (!blobExists(id)) return null;
  try {
    return await readFile(blobPath(id));
  } catch {
    return null;
  }
}

export async function deleteBlob(id: string): Promise<void> {
  if (!blobExists(id)) return;
  await unlink(blobPath(id)).catch(() => undefined);
}
