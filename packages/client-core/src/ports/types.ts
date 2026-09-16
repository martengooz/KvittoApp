import type {
  AnyEntity,
  EntityKind,
  EntityMap,
  ID,
  Receipt,
  SyncMeta,
} from '@kvitto/shared/domain';

export type CanonicalRecord<K extends EntityKind = EntityKind> = EntityMap[K] & SyncMeta;

export interface RevisionCursor {
  cursor: number;
  epoch: string;
}

export interface PageOptions {
  cursor?: number;
  limit: number;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: number;
  hasMore: boolean;
}

export interface DirtySnapshot<K extends EntityKind = EntityKind> {
  kind: K;
  id: ID;
  updatedAt: number;
  entity: CanonicalRecord<K>;
}

export interface SyncApplyResult {
  applied: number;
  merged: number;
  skippedStale: number;
}

export interface PullProgress {
  pages: number;
  records: number;
}

export interface Clock {
  now(): number;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface NetworkPort {
  isOnline(): boolean;
}

export interface SchedulerPort {
  delayMs(attempt: number): number;
}

export interface CredentialState {
  deviceId: ID | null;
  token: string | null;
  accountId: ID | null;
}

export interface CredentialsPort {
  get(): Promise<CredentialState>;
  set(next: CredentialState): Promise<void>;
  clear(): Promise<void>;
}

export interface ArchiveSummary {
  version: number;
  entities: Partial<Record<EntityKind, number>>;
  blobs: number;
}

export interface ArchivePort {
  exportSnapshot(): Promise<ArchiveSummary>;
  importSnapshot(summary: ArchiveSummary): Promise<void>;
}

export interface BlobDescriptor {
  id: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
  role: 'original' | 'processed' | 'thumb';
  createdAt: number;
}

export interface BlobStorePort {
  put(descriptor: Omit<BlobDescriptor, 'createdAt'>): Promise<BlobDescriptor>;
  get(id: string): Promise<BlobDescriptor | null>;
  markUploaded(id: string): Promise<void>;
  listPendingUpload(limit: number): Promise<BlobDescriptor[]>;
}

export interface OcrRequest {
  receiptId: ID;
  imageId: string;
  updatedAt: number;
}

export interface OcrResponse {
  text: string;
  confidence: number;
  durationMs: number;
  purchasedAt: string | null;
  orgNumber: string | null;
}

export interface OcrPort {
  recognize(request: OcrRequest): Promise<OcrResponse>;
}

export interface CanonicalRepositoryPort {
  get<K extends EntityKind>(kind: K, id: ID): Promise<CanonicalRecord<K> | null>;
  upsert<K extends EntityKind>(kind: K, entity: CanonicalRecord<K>): Promise<CanonicalRecord<K>>;
  tombstone<K extends EntityKind>(kind: K, id: ID, now: number): Promise<CanonicalRecord<K> | null>;
  list<K extends EntityKind>(kind: K, options: PageOptions): Promise<PageResult<CanonicalRecord<K>>>;
  listDirty(limit: number): Promise<DirtySnapshot[]>;
  markCleanIfUpdatedAtMatches(snapshot: DirtySnapshot, rev: number): Promise<boolean>;
  dirtyAllAndResetRev(): Promise<void>;
  getSyncState(): Promise<RevisionCursor>;
  setSyncState(state: RevisionCursor): Promise<void>;
  applyIncoming(changes: Partial<Record<EntityKind, AnyEntity[]>>): Promise<SyncApplyResult>;
  countByKind(): Promise<Record<EntityKind, number>>;
  countDirty(): Promise<number>;
  getReceipt(id: ID): Promise<Receipt | null>;
}
