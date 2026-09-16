import type {
  ArchiveEntityKind,
  ArchiveEntry,
  ArchiveEntrySource,
  BlobMetadataRecord,
  ConflictResolver,
  PreflightReport,
  SyncLikeEntity,
} from '@kvitto/archive';
import type { CanonicalRecord, CanonicalRepositoryPort } from '@kvitto/client-core/ports';
import type { EntityKind } from '@kvitto/shared/domain';

export interface FileBackedZipReader {
  openFromFile(fileUri: string): Promise<ArchiveEntrySource>;
}

export interface FileBackedZipWriter {
  addEntry(path: string, bytes: AsyncIterable<Uint8Array>): Promise<void>;
  close(): Promise<AsyncIterable<Uint8Array>>;
}

export interface ArchiveSourceFactory {
  create(): Promise<ArchiveEntrySource>;
}

export interface BlobStagingPort {
  begin(): Promise<string>;
  stageBlob(stagingId: string, sha256: string, bytes: AsyncIterable<Uint8Array>, sizeBytes: number): Promise<void>;
  commit(stagingId: string): Promise<void>;
  rollback(stagingId: string): Promise<void>;
}

export interface ImportSettingsPort {
  applyImportedSettings(settings: Record<string, unknown>): Promise<void>;
}

export interface ImportDiagnosticsPort {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type RepoWithTransaction = CanonicalRepositoryPort & {
  runInTransaction?<T>(work: () => Promise<T>): Promise<T>;
};

export interface ArchiveImportInput {
  sourceFactory: ArchiveSourceFactory;
  repository: RepoWithTransaction;
  blobStaging: BlobStagingPort;
  settings?: ImportSettingsPort;
  conflictResolvers?: Partial<Record<ArchiveEntityKind, ConflictResolver<SyncLikeEntity>>>;
  diagnostics?: ImportDiagnosticsPort;
}

export type MergeEntity = SyncLikeEntity & Record<string, unknown>;

export interface MergeBatch {
  kind: ArchiveEntityKind;
  creates: MergeEntity[];
  updates: MergeEntity[];
  noops: string[];
}

export interface ArchiveImportResult {
  preflight: PreflightReport;
  stagingId: string | null;
  merged: {
    creates: number;
    updates: number;
    noops: number;
  };
  blob: {
    staged: number;
    committed: number;
  };
}

export interface LoadedArchivePayload {
  entities: Record<ArchiveEntityKind, MergeEntity[]>;
  blobMetadata: BlobMetadataRecord[];
  blobEntriesBySha: Map<string, ArchiveEntry>;
  settings: Record<string, unknown> | null;
}

export interface EntityMergePort {
  merge(repository: RepoWithTransaction, batches: readonly MergeBatch[]): Promise<void>;
}

export type CanonicalKind = Extract<ArchiveEntityKind, EntityKind>;

export type CanonicalByIdMap<TEntity extends CanonicalRecord = CanonicalRecord> = Map<string, TEntity>;
