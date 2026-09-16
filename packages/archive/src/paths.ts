import {
  ARCHIVE_ENTITY_KINDS,
  type ArchiveEntityKind,
  type ArchiveManifestV1,
  KVITTO_ARCHIVE_FORMAT,
  KVITTO_ARCHIVE_VERSION,
} from './types.js';

export const MANIFEST_PATH = 'manifest.json';
export const SETTINGS_PATH = 'settings.json';
export const BLOB_METADATA_PATH = 'blob-metadata.ndjson';
export const BLOBS_DIR = 'blobs';

export function canonicalEntityPath(kind: ArchiveEntityKind): string {
  return `entities/${kind}.ndjson`;
}

export function canonicalBlobPath(sha256: string): string {
  return `${BLOBS_DIR}/${sha256}`;
}

export function canonicalManifest(): ArchiveManifestV1 {
  return {
    format: KVITTO_ARCHIVE_FORMAT,
    version: KVITTO_ARCHIVE_VERSION,
    createdAt: new Date().toISOString(),
    entityStreams: {
      companies: canonicalEntityPath('companies'),
      receipts: canonicalEntityPath('receipts'),
      items: canonicalEntityPath('items'),
      categories: canonicalEntityPath('categories'),
      tags: canonicalEntityPath('tags'),
      receiptTags: canonicalEntityPath('receiptTags'),
      secrets: canonicalEntityPath('secrets'),
    },
    settingsPath: SETTINGS_PATH,
    blobMetadataPath: BLOB_METADATA_PATH,
  };
}

export function isValidSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function normalizeArchivePath(value: string): string {
  return value.replace(/\\/g, '/');
}

export function validateArchivePath(path: string): string | null {
  const normalized = normalizeArchivePath(path);
  if (normalized.length === 0) return null;
  if (normalized.startsWith('/')) return null;
  if (/^[A-Za-z]:\//.test(normalized)) return null;
  if (normalized.includes('\u0000')) return null;

  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;

  return normalized;
}

export function isCanonicalEntityPath(path: string): path is `entities/${ArchiveEntityKind}.ndjson` {
  const normalized = normalizeArchivePath(path);
  return ARCHIVE_ENTITY_KINDS.some((kind) => normalized === canonicalEntityPath(kind));
}

export function isCanonicalBlobPath(path: string): boolean {
  const normalized = normalizeArchivePath(path);
  if (!normalized.startsWith(`${BLOBS_DIR}/`)) return false;
  const sha = normalized.slice(`${BLOBS_DIR}/`.length);
  return isValidSha256(sha);
}
