export const KVITTO_ARCHIVE_FORMAT = 'kvitto-archive';
export const KVITTO_ARCHIVE_VERSION = 1;

export const ARCHIVE_ENTITY_KINDS = [
  'companies',
  'receipts',
  'items',
  'categories',
  'tags',
  'receiptTags',
  'secrets',
] as const;

export type ArchiveEntityKind = (typeof ARCHIVE_ENTITY_KINDS)[number];

export interface ArchiveManifestV1 {
  format: typeof KVITTO_ARCHIVE_FORMAT;
  version: typeof KVITTO_ARCHIVE_VERSION;
  createdAt: string;
  entityStreams: Record<ArchiveEntityKind, string>;
  settingsPath: string;
  blobMetadataPath: string;
}

export interface ParsedArchiveManifest extends Omit<ArchiveManifestV1, 'version'> {
  version: number;
}

export interface BlobMetadataRecord {
  sha256: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  role: 'original' | 'processed' | 'thumbnail';
}

export interface SyncLikeEntity {
  id: string;
  updatedAt: number;
  deletedAt: number;
  rev: number;
  dirty: 0 | 1;
  [key: string]: unknown;
}

export interface ArchiveEntry {
  path: string;
  uncompressedSize: number;
  open: () => AsyncIterable<Uint8Array>;
}

export interface ArchiveEntrySource {
  entries: () => AsyncIterable<ArchiveEntry>;
}

export interface DigestImplementation {
  sha256Hex: (chunks: AsyncIterable<Uint8Array>) => Promise<string>;
}

export interface ArchiveLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxEntryBytes: number;
  maxBlobBytes: number;
  maxNdjsonLineBytes: number;
  maxEntityRowsPerKind: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  maxEntries: 50000,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxEntryBytes: 256 * 1024 * 1024,
  maxBlobBytes: 128 * 1024 * 1024,
  maxNdjsonLineBytes: 512 * 1024,
  maxEntityRowsPerKind: 250000,
});

export type PreflightSeverity = 'error' | 'warning';

export interface PreflightIssue {
  severity: PreflightSeverity;
  code:
    | 'missing_manifest'
    | 'invalid_manifest'
    | 'future_version'
    | 'invalid_path'
    | 'duplicate_path'
    | 'entry_limit_exceeded'
    | 'entry_too_large'
    | 'total_size_exceeded'
    | 'missing_entity_stream'
    | 'malformed_ndjson'
    | 'entity_limit_exceeded'
    | 'invalid_entity'
    | 'missing_blob_metadata'
    | 'invalid_blob_metadata'
    | 'missing_blob'
    | 'unexpected_blob'
    | 'blob_size_mismatch'
    | 'blob_sha_mismatch'
    | 'secret_entity_present'
    | 'settings_not_allowed'
    | 'settings_malformed';
  path?: string;
  message: string;
}

export interface PreflightReport {
  ok: boolean;
  manifest: ParsedArchiveManifest | null;
  issues: PreflightIssue[];
  entryCount: number;
  totalUncompressedBytes: number;
  entityCounts: Partial<Record<ArchiveEntityKind, number>>;
  blobCount: number;
}

export interface PreflightOptions {
  limits?: Partial<ArchiveLimits>;
  digest?: DigestImplementation;
}

export type ConflictWinner = 'local' | 'imported';

export type ConflictResolver<TEntity extends SyncLikeEntity> = (
  local: TEntity,
  imported: TEntity,
) => ConflictWinner;

export interface ImportMergePlan<TEntity extends SyncLikeEntity> {
  creates: TEntity[];
  updates: TEntity[];
  noops: string[];
}

export interface ImportMergeOutcome<TEntity extends SyncLikeEntity> {
  merged: TEntity;
  changed: boolean;
}
